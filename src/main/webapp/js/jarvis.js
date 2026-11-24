/*
 * 제브리스 메인 화면
 *  1) 크롬 Web Speech API로 음성을 텍스트로 바꾼다.
 *  2) /api/chat 으로 보내 제브(LLM)의 답과 음성(mp3)을 받는다.
 *  3) 답을 화면에 띄우고 음성을 재생하며 코어를 소리에 맞춰 움직인다.
 */
(function () {
    'use strict';

    var ctx = document.body.getAttribute('data-ctx') || '';
    var $ = function (id) { return document.getElementById(id); };

    var core = $('core');
    var stateLabel = $('stateLabel');
    var transcript = $('transcript');
    var micBtn = $('micBtn');
    var chatLog = $('chatLog');
    var todayList = $('todayList');
    var voiceToggle = $('voiceToggle');
    var textForm = $('textForm');
    var textInput = $('textInput');
    var IDLE_TEXT = '마이크를 누르고 말을 걸어 보세요';

    var STATE_TEXT = {
        idle: '대기 중',
        wake: '호출됨',
        listening: '듣는 중',
        thinking: '생각 중',
        speaking: '말하는 중',
        error: '오류'
    };
    var INTENT_TEXT = { chat: '대화', add_schedule: '일정 등록', query_schedule: '일정 조회' };

    function setState(state) {
        core.setAttribute('data-state', state);
        document.body.setAttribute('data-state', state);
        stateLabel.textContent = STATE_TEXT[state] || state;
        micBtn.classList.toggle('active', state === 'listening');
        micBtn.setAttribute('aria-label', state === 'listening' ? '말하기 멈추기' : '말하기 시작');
        onStateForClap(state);
    }

    function toast(msg, type) {
        if (window.jebrisToast) window.jebrisToast(msg, type);
    }

    // ---------- 시계 ----------
    var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function tick() {
        var d = new Date();
        $('clockTime').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
        $('clockDate').textContent = d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + DAYS[d.getDay()] + '요일';
    }
    tick();
    setInterval(tick, 1000);

    // ---------- 음성 답변 설정 (이 브라우저에만 저장) ----------
    try {
        var saved = localStorage.getItem('jebris.voice');
        if (saved !== null) voiceToggle.checked = saved === '1';
    } catch (e) { /* 저장소를 못 쓰면 기본값 사용 */ }
    voiceToggle.addEventListener('change', function () {
        try { localStorage.setItem('jebris.voice', voiceToggle.checked ? '1' : '0'); } catch (e) { /* 무시 */ }
        if (!voiceToggle.checked) stopAudio();
    });

    // ---------- 대화 표시 ----------
    function addMessage(role, text) {
        var empty = $('chatEmpty');
        if (empty) empty.remove();
        var wrap = document.createElement('div');
        wrap.className = 'msg msg-' + role;
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;
        wrap.appendChild(bubble);
        chatLog.appendChild(wrap);
        chatLog.scrollTop = chatLog.scrollHeight;
        return wrap;
    }

    function addMeta(wrap, text) {
        var meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.textContent = text;
        wrap.appendChild(meta);
    }

    function nowTime() {
        var d = new Date();
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // ---------- 다가오는 일정 ----------
    function loadToday(highlightNew) {
        fetch(ctx + '/api/today', { headers: { 'Accept': 'application/json' } })
            .then(function (res) {
                if (res.status === 401) { location.href = ctx + '/login'; throw new Error('login'); }
                return res.json();
            })
            .then(function (data) { renderToday(data.ok ? data.items : null, highlightNew); })
            .catch(function (e) { if (e.message !== 'login') renderToday(null); });
    }

    function renderToday(items, highlightNew) {
        var previous = {};
        todayList.querySelectorAll('[data-id]').forEach(function (li) { previous[li.getAttribute('data-id')] = true; });
        todayList.innerHTML = '';
        if (items === null) {
            todayList.appendChild(li('empty', '일정을 불러오지 못했어요.'));
            return;
        }
        if (items.length === 0) {
            todayList.appendChild(li('empty', '7일 안에 예정된 일정이 없어요.'));
            return;
        }
        var lastDate = null;
        items.forEach(function (it) {
            if (it.date !== lastDate) {
                lastDate = it.date;
                var day = li('day' + (it.today ? ' is-today' : ''), it.today ? '오늘 · ' + it.date : it.date);
                todayList.appendChild(day);
            }
            var row = document.createElement('li');
            row.className = 'today-item' + (it.status === 'DONE' ? ' done' : '') + (it.overdue ? ' overdue' : '');
            row.setAttribute('data-id', it.id);
            if (highlightNew && !previous[String(it.id)]) row.classList.add('flash');

            var time = document.createElement('div');
            time.className = 't-time';
            time.textContent = it.time;
            var body = document.createElement('div');
            var title = document.createElement('div');
            title.className = 't-title';
            title.textContent = it.title;
            body.appendChild(title);
            if (it.memo) {
                var memo = document.createElement('div');
                memo.className = 't-memo';
                memo.textContent = it.memo;
                body.appendChild(memo);
            }
            row.appendChild(time);
            row.appendChild(body);
            todayList.appendChild(row);
        });
    }

    function li(cls, text) {
        var el = document.createElement('li');
        el.className = cls;
        el.textContent = text;
        return el;
    }

    // ---------- 음성 재생 + 코어 반응 ----------
    var audio = null;
    var audioCtx = null;
    var analyser = null;
    var raf = 0;

    function playAudio(base64) {
        stopAudio();
        audio = new Audio('data:audio/mpeg;base64,' + base64);
        analyser = null;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                audioCtx = audioCtx || new AC();
                var source = audioCtx.createMediaElementSource(audio);
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                source.connect(analyser);
                analyser.connect(audioCtx.destination);
                if (audioCtx.state === 'suspended') audioCtx.resume();
            }
        } catch (e) {
            analyser = null; // 분석이 안 되어도 재생은 된다.
        }
        var current = audio;
        audio.addEventListener('play', function () { setState('speaking'); animateLevel(); });
        audio.addEventListener('ended', function () { if (audio === current) finishAudio(); });
        audio.addEventListener('error', function () { if (audio === current) finishAudio(); });
        audio.play().catch(function () {
            finishAudio();
            toast('브라우저가 소리 재생을 막았어요. 화면을 한 번 클릭한 뒤 다시 시도해 주세요.', 'info');
        });
    }

    function animateLevel() {
        cancelAnimationFrame(raf);
        if (!analyser) return;
        var data = new Uint8Array(analyser.frequencyBinCount);
        (function loop() {
            analyser.getByteFrequencyData(data);
            var sum = 0;
            for (var i = 0; i < data.length; i++) sum += data[i];
            var level = Math.min(1, sum / data.length / 80);
            core.style.setProperty('--level', level.toFixed(3));
            raf = requestAnimationFrame(loop);
        })();
    }

    function finishAudio() {
        cancelAnimationFrame(raf);
        core.style.setProperty('--level', '0');
        audio = null;
        if (core.getAttribute('data-state') === 'speaking') setState('idle');
    }

    function stopAudio() {
        if (audio) {
            audio.pause();
            finishAudio();
        }
    }

    // ---------- 서버로 보내기 ----------
    var busy = false;

    function send(text) {
        if (busy) return;
        busy = true;
        stopAudio();
        transcript.textContent = '“' + text + '”';
        addMessage('user', text);
        setState('thinking');

        var pending = addMessage('assistant', '');
        pending.querySelector('.bubble').innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';

        var body = new URLSearchParams();
        body.set('text', text);
        body.set('voice', voiceToggle.checked ? 'true' : 'false');

        fetch(ctx + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Accept': 'application/json' },
            body: body.toString()
        })
            .then(function (res) {
                if (res.status === 401) { location.href = ctx + '/login'; throw new Error('login'); }
                return res.json();
            })
            .then(function (data) {
                var bubble = pending.querySelector('.bubble');
                bubble.textContent = data.answer || data.error || '응답이 비어 있어요.';
                if (!data.ok) {
                    pending.classList.add('msg-error');
                    addMeta(pending, '오류 · ' + nowTime());
                    setState('error');
                    setTimeout(function () { if (core.getAttribute('data-state') === 'error') setState('idle'); }, 2500);
                    return;
                }
                addMeta(pending, (INTENT_TEXT[data.intent] || '대화') + ' · ' + nowTime());
                chatLog.scrollTop = chatLog.scrollHeight;

                if (data.scheduleChanged) {
                    loadToday(true);
                    toast('일정에 등록했어요.', 'ok');
                }
                if (data.audio) {
                    playAudio(data.audio);
                } else {
                    if (data.ttsError) toast(data.ttsError, 'error');
                    setState('idle');
                }
            })
            .catch(function (e) {
                if (e.message === 'login') return;
                pending.classList.add('msg-error');
                pending.querySelector('.bubble').textContent = '서버에 연결하지 못했어요. Tomcat이 실행 중인지 확인해 주세요.';
                setState('error');
                setTimeout(function () { setState('idle'); }, 2500);
            })
            .then(function () { busy = false; });
    }

    textForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = textInput.value.trim();
        if (!text || busy) return;
        textInput.value = '';
        send(text);
    });

    // ---------- 음성 인식 (Web Speech API) ----------
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recognition = null;
    var listening = false;
    var finalText = '';

    if (SR) {
        recognition = new SR();
        recognition.lang = 'ko-KR';
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = function () {
            listening = true;
            finalText = '';
            setState('listening');
            transcript.textContent = '듣고 있어요...';
        };
        recognition.onresult = function (e) {
            var interim = '';
            for (var i = e.resultIndex; i < e.results.length; i++) {
                var r = e.results[i];
                if (r.isFinal) finalText += r[0].transcript;
                else interim += r[0].transcript;
            }
            transcript.textContent = (finalText + interim) || '듣고 있어요...';
        };
        recognition.onerror = function (e) {
            var messages = {
                'not-allowed': '마이크 권한을 허용해 주세요. 주소창 왼쪽 아이콘에서 바꿀 수 있어요.',
                'service-not-allowed': '마이크 권한을 허용해 주세요.',
                'no-speech': '아무 말도 들리지 않았어요. 다시 눌러 말해 주세요.',
                'audio-capture': '마이크를 찾지 못했어요. 연결을 확인해 주세요.',
                'network': '음성 인식에 인터넷 연결이 필요해요.'
            };
            if (e.error !== 'aborted') {
                transcript.textContent = messages[e.error] || ('음성 인식 오류: ' + e.error);
            }
        };
        recognition.onend = function () {
            listening = false;
            var text = finalText.trim();
            if (text) {
                send(text);
            } else if (core.getAttribute('data-state') === 'listening' || core.getAttribute('data-state') === 'wake') {
                setState('idle');
                if (transcript.textContent === '듣고 있어요...') transcript.textContent = IDLE_TEXT;
            }
        };
    } else {
        $('speechWarn').hidden = false;
        micBtn.disabled = true;
    }

    micBtn.addEventListener('click', function () {
        if (!recognition || busy) return;
        stopAudio();
        if (listening) {
            recognition.stop();
        } else {
            try { recognition.start(); } catch (e) { /* 이미 시작된 경우 무시 */ }
        }
    });

    // 입력창 밖에서 Space를 누르면 말하기 시작/멈춤
    document.addEventListener('keydown', function (e) {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (e.code === 'Space' && !e.repeat && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON') {
            e.preventDefault();
            micBtn.click();
        }
        if (e.key === 'Escape') stopAudio();
    });

    // ---------- 호출: 동작(웹캠 제스처) / 소리(박수 소리) + 제스처 → 기능 연결 ----------
    //  새 제스처에 기능을 붙이려면 여기에 id: function(detail){...} 를 추가 (id는 gestures.js 참고)
    var GESTURE_ACTIONS = {
        double_clap: function () { if (triggerUses('motion')) summon('motion'); },
        wave: function () { cancelAll('👋 손 흔들기 — 취소했어요'); },
        open_palm: function () { if (audio || (window.speechSynthesis && speechSynthesis.speaking)) cancelAll('✋ 손바닥 — 멈췄어요'); },
        thumbs_up: function () { toast('👍 엄지척 인식!', 'ok'); },
        v_sign: function () { toast('✌️ 브이 인식!', 'ok'); }
    };

    var clap = null;
    var sensing = false;
    var vision = { running: false, present: false };
    var triggerMode = $('triggerMode');
    var needPerson = $('needPerson');
    var clapStatus = $('clapStatus');
    var resumeTimer = 0;
    var SENSE_KEY = 'jebris.sense';
    var TRIGGER_KEY = 'jebris.trigger';

    try { var savedMode = localStorage.getItem(TRIGGER_KEY); if (savedMode) triggerMode.value = savedMode; } catch (e) { /* 무시 */ }
    function triggerUses(kind) { return triggerMode.value === 'both' || triggerMode.value === kind; }

    var flashUntil = 0;
    function setClapStatus(text, flash) {
        if (!flash && Date.now() < flashUntil) return;   // 방금 띄운 알림은 잠시 유지
        clapStatus.textContent = text;
        if (flash) {
            flashUntil = Date.now() + 2500;
            clapStatus.classList.remove('flash');
            void clapStatus.offsetWidth; // 애니메이션 다시 시작
            clapStatus.classList.add('flash');
        }
    }
    function idleStatus() {
        return { motion: '박수 동작 기다리는 중', sound: '박수 소리 기다리는 중', both: '박수 동작·소리 기다리는 중' }[triggerMode.value];
    }
    function syncSoundUi() {
        $('soundRow').hidden = !triggerUses('sound');
        $('needPersonWrap').hidden = !triggerUses('sound');
    }

    // 자비스가 듣거나 말하는 동안은 박수 소리 감지를 멈춘다 (자기 목소리에 반응하지 않게)
    function onStateForClap(state) {
        clearTimeout(resumeTimer);
        if (state === 'idle' || state === 'error') {
            resumeTimer = setTimeout(function () {
                if (core.getAttribute('data-state') !== 'idle') return;
                if (clap && triggerUses('sound')) clap.resume();
                if (sensing) setClapStatus(idleStatus());
            }, 900);
        } else if (clap) {
            clap.pause();
        }
    }

    function sayShort(text, done) {
        var finished = false;
        function finish() { if (!finished) { finished = true; done(); } }
        if (!voiceToggle.checked || !window.speechSynthesis) { setTimeout(finish, 500); return; }
        try {
            speechSynthesis.cancel();
            var u = new SpeechSynthesisUtterance(text);
            u.lang = 'ko-KR';
            u.rate = 1.05;
            var ko = speechSynthesis.getVoices().filter(function (v) { return /ko/i.test(v.lang); });
            if (ko.length) u.voice = ko[0];
            u.onend = finish;
            u.onerror = finish;
            speechSynthesis.speak(u);
            setTimeout(finish, 3500); // onend가 안 오는 브라우저 대비
        } catch (e) {
            finish();
        }
    }

    function cancelAll(msg) {
        var state = core.getAttribute('data-state');
        if (state === 'idle' && !audio) return;
        if (window.speechSynthesis) speechSynthesis.cancel();
        stopAudio();
        if (recognition && (listening || state === 'wake')) { try { recognition.abort(); } catch (e) { /* 무시 */ } }
        if (!busy) setState('idle');
        transcript.textContent = IDLE_TEXT;
        setClapStatus(msg, true);
    }

    function summon(source) {
        var state = core.getAttribute('data-state');
        if (state === 'speaking') { stopAudio(); state = core.getAttribute('data-state'); } // 말하는 중에 부르면 끊고 다시 듣기
        if (busy || listening || (state !== 'idle' && state !== 'error')) return;
        if (source === 'sound' && needPerson.checked && vision.running && !vision.present) {
            setClapStatus('짝·짝 소리 — 사람이 안 보여서 무시했어요', true);
            return;
        }
        if (!recognition) {
            toast('이 브라우저는 음성 인식을 지원하지 않아요. 크롬에서 열어 주세요.', 'error');
            return;
        }
        setClapStatus(source === 'motion' ? '👏 박수 동작 감지! 듣는 중' : '👏 박수 소리 감지! 듣는 중', true);
        setState('wake');
        transcript.textContent = '네, 부르셨어요?';
        sayShort('네, 부르셨어요?', function () {
            if (core.getAttribute('data-state') !== 'wake') return;
            try { recognition.start(); } catch (e) { setState('idle'); return; }
            // 음성 인식이 시작되지 않으면(권한 거부 등) 호출 상태에 멈춰 있지 않게 되돌린다
            setTimeout(function () {
                if (core.getAttribute('data-state') === 'wake') {
                    setState('idle');
                    transcript.textContent = IDLE_TEXT;
                }
            }, 5000);
        });
    }

    function startSound() {
        if (clap) return;
        clap = new JebrisClap({
            onDouble: function () { summon('sound'); },
            onClap: function () { $('visionPanel').classList.add('clap-hit'); setTimeout(function () { $('visionPanel').classList.remove('clap-hit'); }, 160); },
            onLevel: function (level, threshold) {
                $('clapLevel').style.width = (level * 100).toFixed(1) + '%';
                $('clapThresh').style.left = (threshold * 100).toFixed(1) + '%';
            }
        });
        clap.start().then(function () {
            if (!triggerUses('sound')) clap.pause();
            onStateForClap(core.getAttribute('data-state'));
        }).catch(function () {
            clap = null;
            setClapStatus('마이크를 쓸 수 없어요');
            toast('마이크 권한을 허용해야 박수 소리로 부를 수 있어요.', 'error');
        });
    }

    function startSensing() {
        if (sensing) return;
        sensing = true;
        $('senseBtn').disabled = true;
        $('senseBtn').textContent = '켜는 중…';
        try { localStorage.setItem(SENSE_KEY, '1'); } catch (e) { /* 무시 */ }
        setClapStatus(idleStatus());

        if (triggerUses('sound')) startSound();

        whenVisionReady(function () {
            window.JebrisVision.start().then(function () {
                $('camCover').hidden = true;
                $('camLive').hidden = false;
            }).catch(function (e) {
                console.error(e);
                $('camCover').hidden = false;
                $('senseBtn').hidden = true;
                $('camCover').querySelector('p').textContent = (e && e.name === 'NotAllowedError')
                    ? '카메라 권한이 거부됐어요. 주소창 왼쪽 아이콘에서 허용해 주세요.'
                    : '카메라 또는 AI 모델을 불러오지 못했어요. (인터넷 연결 확인)';
                vision.running = false;
            });
        });
    }

    function whenVisionReady(fn) {
        if (window.JebrisVision) fn();
        else window.addEventListener('jebris:vision-ready', fn, { once: true });
    }

    // 웹캠 상태 → 패널
    window.addEventListener('jebris:vision', function (e) {
        var d = e.detail;
        vision.running = d.running;
        vision.present = d.present;
        $('actName').textContent = (d.emoji ? d.emoji + ' ' : '') + d.activity;
        $('actConf').textContent = d.present ? Math.round(d.confidence * 100) + '%' : '--';
        $('actBar').style.width = (d.present ? d.confidence * 100 : 0) + '%';
        $('handCount').textContent = d.running ? '손 ' + d.hands + '개 · 몸 33점 + 손 21점×' + d.hands : '';
        core.setAttribute('data-present', d.present ? 'true' : 'false');
        document.body.classList.toggle('person-present', !!d.present);
    });

    // 제스처 이벤트 → 기록 칩 + 기능 실행
    window.addEventListener('jebris:gesture', function (e) {
        var d = e.detail;
        var logEl = $('gestureLog');
        var chip = document.createElement('span');
        chip.className = 'g-chip';
        chip.textContent = (d.emoji ? d.emoji + ' ' : '') + d.label;
        logEl.insertBefore(chip, logEl.firstChild);
        while (logEl.children.length > 4) logEl.removeChild(logEl.lastChild);
        if (d.id === 'double_clap') {
            $('visionPanel').classList.add('clap-hit');
            setTimeout(function () { $('visionPanel').classList.remove('clap-hit'); }, 300);
        }
        var action = GESTURE_ACTIONS[d.id];
        if (action) action(d);
    });

    triggerMode.addEventListener('change', function () {
        try { localStorage.setItem(TRIGGER_KEY, triggerMode.value); } catch (e) { /* 무시 */ }
        syncSoundUi();
        if (!sensing) return;
        if (triggerUses('sound')) { if (clap) clap.resume(); else startSound(); }
        else if (clap) clap.pause();
        setClapStatus(idleStatus());
    });
    syncSoundUi();

    $('senseBtn').addEventListener('click', startSensing);

    // 판정 수치 보기 — 박수·흔들기가 왜 안 잡히는지 눈으로 확인하는 용도
    var debugTimer = 0;
    function renderDebug() {
        var g = window.JebrisGestures, cfg = g && g.config;
        if (!g) return;
        var d = g.debug;
        var dist = d.handDist === null || d.handDist === undefined ? '--' : d.handDist.toFixed(2);
        $('gDebug').innerHTML =
            '<span>FPS <b>' + d.fps + '</b>' + (d.fps && d.fps < 10 ? ' ⚠️' : '') + '</span>' +
            '<span>손 거리 <b>' + dist + '</b> <i>(박수: ' + cfg.clap.maxClosed + ' 이하로 빠르게)</i></span>' +
            '<span>박수 <b>' + d.clapCount + '</b>/2</span>' +
            '<span>흔들기 <b>' + d.waveRev + '</b>/' + cfg.wave.reversals + '</span>';
    }
    $('debugToggle').addEventListener('change', function () {
        $('gDebug').hidden = !this.checked;
        clearInterval(debugTimer);
        if (this.checked) { renderDebug(); debugTimer = setInterval(renderDebug, 150); }
    });

    // 전에 켜 둔 적이 있으면, 화면을 처음 클릭할 때 자동으로 다시 켠다
    // (브라우저는 사용자 클릭 없이 마이크 소리 분석을 시작하지 못하게 막는다)
    try {
        if (localStorage.getItem(SENSE_KEY) === '1') {
            $('senseBtn').textContent = '화면을 클릭하면 켜져요';
            document.addEventListener('pointerdown', startSensing, { once: true });
        }
    } catch (e) { /* 무시 */ }

    // 시작
    setState('idle');
    chatLog.scrollTop = chatLog.scrollHeight;
    loadToday(false);
})();
