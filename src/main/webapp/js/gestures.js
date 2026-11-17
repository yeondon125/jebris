/*
 * 제스처(동작) 인식 엔진
 *
 *  vision.js가 매 프레임 넘겨주는 관절 좌표로 제스처를 판정한다.
 *    frame = {
 *      t:     ms (performance.now),
 *      pose:  몸 관절 33개 [{x,y,z,visibility}] 또는 null   (MediaPipe Pose, 0~1 좌표, y는 아래로 갈수록 큼)
 *      hands: [{ side: 'Left'|'Right', lm: 손 관절 21개 [{x,y,z}] }]  (MediaPipe Hand)
 *    }
 *
 *  제스처 종류
 *    - state : 지금 하고 있는 자세 (예: 주먹, 손 들기). 화면에 "현재 동작"으로 표시.
 *    - event : 한 번 일어나는 동작 (예: 박수 두 번, 손 흔들기). window 이벤트 'jebris:gesture' 발생.
 *              (state 제스처도 hold 시간을 주면 그 시간만큼 유지했을 때 event가 한 번 발생)
 *
 *  ★ 새 제스처 추가 방법 (아래 "기본 제스처" 참고)
 *    JebrisGestures.register({
 *      id: 'my_gesture', label: '내 동작', emoji: '🤙', type: 'state',
 *      priority: 50,            // 여러 state가 동시에 맞으면 큰 값이 표시됨
 *      hold: 800,               // (선택) 이만큼 유지하면 event 발생
 *      detect: function (ctx) { return ctx.hand && ctx.fingers(ctx.hand).thumb; }
 *    });
 *    → 동작에 기능을 연결하려면 jarvis.js 의 GESTURE_ACTIONS 에 id를 추가.
 */
(function () {
    'use strict';

    // 판정 기준값 — 사람/카메라에 따라 여기만 조정하면 된다.
    var CFG = {
        historyMs: 2000,          // 이 시간만큼의 과거 프레임을 보관 (흔들기 등 움직임 판정용)
        stableFrames: 4,          // state 제스처가 연속 몇 프레임 맞아야 인정할지 (깜빡임 방지)
        clap: {
            // 두 손 사이 거리 d (어깨너비 = 1). 프레임이 적어도(10fps) 잡히도록 "맞닿는 순간"이 아니라
            // "빠르게 줄어든 것"으로 판정한다.
            windowMs: 450,        // 이 시간 안의 최대 거리(hi)와 비교
            minDrop: 0.22,        // hi - d 가 이만큼 이상 줄면 박수 (빠르게 모음)
            maxClosed: 0.55,      // 그때 d 가 이 값 이하여야 함 (실제로 손이 가까워짐)
            rearm: 0.12,          // 다음 박수로 인정하려면 최소값보다 이만큼 다시 벌어져야 함
            minGapMs: 120,        // 박수 두 번 사이 최소/최대 간격
            maxGapMs: 1100,
            settleMs: 350,        // 두 번째 박수 뒤 이 시간 동안 세 번째가 없으면 확정
            cooldownMs: 2000
        },
        wave: {
            minSwing: 0.14,       // 좌우로 움직인 폭 (어깨너비 기준)
            reversals: 2,         // 방향 전환 횟수 (왼→오→왼 = 2)
            windowMs: 1500,
            minRaisedRatio: 0.6,  // 이 시간 중 손을 들고 있던 프레임 비율
            cooldownMs: 1800
        }
    };

    // ---------------- 기하 도우미 ----------------
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function avg(points) {
        var x = 0, y = 0, n = 0;
        points.forEach(function (p) { if (p) { x += p.x; y += p.y; n++; } });
        return n ? { x: x / n, y: y / n } : null;
    }
    function vis(p, th) { return p && (p.visibility === undefined || p.visibility > (th === undefined ? 0.4 : th)); }

    /** 손 관절 21개 → 손가락별 펴짐 여부 */
    function fingers(hand) {
        var lm = hand.lm;
        var wrist = lm[0];
        function ext(tip, pip) { return dist(wrist, lm[tip]) > dist(wrist, lm[pip]) * 1.12; }
        // 엄지: 끝이 새끼손가락 뿌리(17)에서 충분히 멀어야 펴진 것
        var thumb = dist(lm[4], lm[17]) > dist(lm[3], lm[17]) * 1.08 && dist(lm[4], lm[5]) > dist(lm[0], lm[5]) * 0.35;
        return { thumb: thumb, index: ext(8, 6), middle: ext(12, 10), ring: ext(16, 14), pinky: ext(20, 18) };
    }
    function handSize(hand) { return dist(hand.lm[0], hand.lm[9]) || 0.1; }
    function palm(hand) { var l = hand.lm; return avg([l[0], l[5], l[9], l[13], l[17]]); }

    /** 두 손 사이 거리 (어깨너비 = 1). 몸 모델 우선, 없으면 손 모델 두 개로 계산 */
    function twoHandDist(body, hands) {
        if (!body) return null;
        if (body.left && body.right) return dist(body.left, body.right) / body.shoulderW;
        if (hands && hands.length === 2) return dist(palm(hands[0]), palm(hands[1])) / body.shoulderW;
        return null;
    }

    /** 몸(포즈) 기준 정보: 어깨너비, 양손 중심 */
    function bodyInfo(pose) {
        if (!pose || !vis(pose[11]) || !vis(pose[12])) return null;
        var sw = dist(pose[11], pose[12]) || 0.2;
        function handCenter(ids) {
            // 빠르게 움직이는 손은 흐려져서 신뢰도가 낮게 나오므로 기준을 낮춘다
            var pts = ids.map(function (i) { return vis(pose[i], 0.15) ? pose[i] : null; });
            return avg(pts);
        }
        return {
            shoulderW: sw,
            shoulderY: (pose[11].y + pose[12].y) / 2,
            hipY: vis(pose[23]) && vis(pose[24]) ? (pose[23].y + pose[24].y) / 2 : (pose[11].y + pose[12].y) / 2 + sw * 1.4,
            // 몸 기준 왼손/오른손 = 손목·새끼·검지·엄지 평균 (손끼리 붙어도 포즈 모델은 잘 안 놓침)
            left: handCenter([15, 17, 19, 21]),
            right: handCenter([16, 18, 20, 22]),
            lWrist: vis(pose[15], 0.2) ? pose[15] : null, rWrist: vis(pose[16], 0.2) ? pose[16] : null,
            lElbow: vis(pose[13], 0.2) ? pose[13] : null, rElbow: vis(pose[14], 0.2) ? pose[14] : null
        };
    }

    // ---------------- 엔진 ----------------
    var registry = [];
    var history = [];        // [{t, body, hands}]
    var stateRuns = {};      // id → 연속으로 맞은 프레임 수
    var holdStart = {};      // id → hold 시작 시각
    var holdFired = {};      // id → 이미 hold 이벤트를 냈는지
    var memo = {};           // 제스처별 내부 상태 저장소
    var current = null;      // 현재 표시 중인 state 제스처
    var debug = { fps: 0, handDist: null, clapCount: 0, waveRev: 0 };   // 화면 "판정 수치"용

    function register(g) {
        if (!g || !g.id || typeof g.detect !== 'function') throw new Error('gesture needs id and detect()');
        registry = registry.filter(function (x) { return x.id !== g.id; });
        g.type = g.type || 'state';
        g.priority = g.priority || 0;
        registry.push(g);
        memo[g.id] = memo[g.id] || {};
        return g;
    }

    function fire(g, extra) {
        window.dispatchEvent(new CustomEvent('jebris:gesture', {
            detail: { id: g.id, label: g.label, emoji: g.emoji || '', t: performance.now(), extra: extra || null }
        }));
    }

    /** 매 프레임 호출. 반환: { current: 현재 state 제스처 or null, hands: n } */
    function update(frame) {
        var body = bodyInfo(frame.pose);
        var t = frame.t;
        history.push({ t: t, body: body, hands: frame.hands || [] });
        while (history.length && t - history[0].t > CFG.historyMs) history.shift();
        if (history.length > 1) debug.fps = Math.round((history.length - 1) * 1000 / (t - history[0].t));

        var hands = frame.hands || [];
        var ctx = {
            t: t, frame: frame, pose: frame.pose, body: body, hands: hands,
            hand: hands[0] || null,                  // 첫 번째 손 (state 제스처용)
            history: history, cfg: CFG,
            fingers: fingers, handSize: handSize, dist: dist, avg: avg
        };

        var best = null;
        registry.forEach(function (g) {
            var m = memo[g.id];
            var hit;
            try { hit = g.detect(ctx, m); } catch (e) { hit = false; }

            if (g.type === 'event') {
                if (hit) fire(g, hit === true ? null : hit);
                return;
            }
            // state 제스처: 연속 프레임으로 안정화
            stateRuns[g.id] = hit ? (stateRuns[g.id] || 0) + 1 : 0;
            var stable = stateRuns[g.id] >= CFG.stableFrames;
            if (stable && (!best || g.priority > best.priority)) best = g;

            if (g.hold) {
                if (stable) {
                    if (!holdStart[g.id]) holdStart[g.id] = t;
                    if (!holdFired[g.id] && t - holdStart[g.id] >= g.hold) { holdFired[g.id] = true; fire(g, { hold: true }); }
                } else { holdStart[g.id] = 0; holdFired[g.id] = false; }
            }
        });
        current = best;
        return { current: best, hands: hands.length };
    }

    function reset() { history = []; stateRuns = {}; holdStart = {}; holdFired = {}; current = null; for (var k in memo) memo[k] = {}; }

    // =====================================================================
    //  기본 제스처
    // =====================================================================

    // --- 박수 두 번 (동작으로 판정) ---
    //  두 손 거리 d가 최근 0.45초 안의 최대값보다 빠르게 크게 줄면 박수 1번.
    //  (맞닿는 순간 프레임을 못 잡아도, 줄어드는 도중 프레임만 있으면 인정)
    register({
        id: 'double_clap', label: '박수 두 번', emoji: '👏', type: 'event',
        detect: function (ctx, m) {
            var b = ctx.body, c = CFG.clap, t = ctx.t;
            var d = twoHandDist(b, ctx.hands);
            debug.handDist = d;
            m.series = (m.series || []).filter(function (p) { return t - p.t <= c.windowMs; });
            m.claps = m.claps || [];
            if (d === null) return false;
            m.series.push({ t: t, d: d });

            var aboveHip = !b.left || !b.right || Math.min(b.left.y, b.right.y) < b.hipY;
            var hi = 0;
            m.series.forEach(function (p) { if (p.d > hi) hi = p.d; });

            if (m.armed === undefined) m.armed = true;
            if (!m.armed) {
                if (d < m.minD) m.minD = d;
                if (d >= m.minD + c.rearm) m.armed = true;          // 다시 벌렸음 → 다음 박수 가능
            } else if (aboveHip && d <= c.maxClosed && hi - d >= c.minDrop && t >= (m.cooldownUntil || 0)) {
                m.armed = false; m.minD = d;
                m.claps = m.claps.filter(function (x) { return t - x <= c.maxGapMs; });
                m.claps.push(t);
                m.lastClap = t;
                m.series = [];                                    // 같은 박수를 두 번 세지 않게
                if (m.claps.length >= 3) { m.claps = []; m.cooldownUntil = t + 600; } // 박수갈채는 무시
            }
            debug.clapCount = m.claps.length;

            // 두 번째 박수 뒤 잠깐 기다렸다 확정
            if (m.claps.length === 2 && t - m.lastClap >= c.settleMs) {
                var gap = m.claps[1] - m.claps[0];
                m.claps = [];
                if (gap >= c.minGapMs) { m.cooldownUntil = t + c.cooldownMs; return { gap: Math.round(gap) }; }
            }
            if (m.claps.length === 1 && t - m.lastClap > c.maxGapMs) m.claps = [];
            return false;
        }
    });

    // --- 손 흔들기: 어깨 높이 이상으로 든 손이 좌우로 왕복 ---
    //  중간에 몇 프레임 손을 놓쳐도 끊기지 않게, 들고 있던 프레임만 모아서 본다.
    register({
        id: 'wave', label: '손 흔들기', emoji: '👋', type: 'event',
        detect: function (ctx, m) {
            var w = CFG.wave, t = ctx.t;
            var best = 0;
            if (t < (m.cooldownUntil || 0)) { debug.waveRev = 0; return false; }
            var sides = [['lWrist', 'lElbow'], ['rWrist', 'rElbow']];
            for (var s = 0; s < 2; s++) {
                var xs = [], total = 0;
                for (var i = 0; i < ctx.history.length; i++) {
                    var H = ctx.history[i];
                    if (t - H.t > w.windowMs) continue;
                    total++;
                    var B = H.body, wr = B && B[sides[s][0]], el = B && B[sides[s][1]];
                    if (!wr) continue;
                    var raised = wr.y < B.shoulderY + B.shoulderW * 0.25 && (!el || wr.y < el.y);
                    if (raised) xs.push(wr.x / B.shoulderW);
                }
                if (total < 6 || xs.length < 6 || xs.length / total < w.minRaisedRatio) continue;
                // 좌우 끝점(극값)을 따라가며 minSwing 이상 되돌아올 때마다 방향 전환 1회
                var rev = 0, dir = 0, lo = xs[0], hiX = xs[0], anchor = xs[0];
                for (var k = 1; k < xs.length; k++) {
                    var x = xs[k];
                    if (dir === 0) {
                        if (x < lo) lo = x;
                        if (x > hiX) hiX = x;
                        if (x - lo >= w.minSwing) { dir = 1; anchor = x; }
                        else if (hiX - x >= w.minSwing) { dir = -1; anchor = x; }
                    } else if (dir > 0) {
                        if (x > anchor) anchor = x;
                        else if (anchor - x >= w.minSwing) { rev++; dir = -1; anchor = x; }
                    } else {
                        if (x < anchor) anchor = x;
                        else if (x - anchor >= w.minSwing) { rev++; dir = 1; anchor = x; }
                    }
                }
                if (rev > best) best = rev;
                if (rev >= w.reversals) { m.cooldownUntil = t + w.cooldownMs; debug.waveRev = 0; return { side: s ? 'right' : 'left' }; }
            }
            debug.waveRev = best;
            return false;
        }
    });

    // --- 몸 자세 (포즈) ---
    register({
        id: 'both_hands_up', label: '양손 들기', emoji: '🙌', priority: 40,
        detect: function (ctx) {
            var b = ctx.body; if (!b || !b.lWrist || !b.rWrist) return false;
            var top = b.shoulderY - b.shoulderW * 0.25;
            return b.lWrist.y < top && b.rWrist.y < top;
        }
    });
    register({
        id: 'hand_up', label: '손 들기', emoji: '🙋', priority: 30,
        detect: function (ctx) {
            var b = ctx.body; if (!b) return false;
            var top = b.shoulderY - b.shoulderW * 0.25;
            return (b.lWrist && b.lWrist.y < top) || (b.rWrist && b.rWrist.y < top);
        }
    });
    register({
        id: 'hands_together', label: '손 모음', emoji: '🤲', priority: 20,
        detect: function (ctx) {
            var b = ctx.body; if (!b || !b.left || !b.right) return false;
            return dist(b.left, b.right) / b.shoulderW < 0.3 && Math.min(b.left.y, b.right.y) < b.hipY;
        }
    });

    // --- 손 모양 (손 관절 21개) ---
    function anyHand(ctx, test) {
        for (var i = 0; i < ctx.hands.length; i++) if (test(fingers(ctx.hands[i]), ctx.hands[i])) return true;
        return false;
    }
    register({
        id: 'open_palm', label: '손바닥 펴기', emoji: '✋', priority: 60, hold: 1000,
        detect: function (ctx) { return anyHand(ctx, function (f) { return f.thumb && f.index && f.middle && f.ring && f.pinky; }); }
    });
    register({
        id: 'fist', label: '주먹', emoji: '✊', priority: 60,
        detect: function (ctx) { return anyHand(ctx, function (f) { return !f.index && !f.middle && !f.ring && !f.pinky; }); }
    });
    register({
        id: 'v_sign', label: '브이', emoji: '✌️', priority: 65, hold: 800,
        detect: function (ctx) { return anyHand(ctx, function (f) { return f.index && f.middle && !f.ring && !f.pinky; }); }
    });
    register({
        id: 'point', label: '가리키기', emoji: '☝️', priority: 62,
        detect: function (ctx) { return anyHand(ctx, function (f) { return f.index && !f.middle && !f.ring && !f.pinky; }); }
    });
    register({
        id: 'thumbs_up', label: '엄지척', emoji: '👍', priority: 70, hold: 800,
        detect: function (ctx) {
            return anyHand(ctx, function (f, h) {
                return f.thumb && !f.index && !f.middle && !f.ring && !f.pinky &&
                    h.lm[4].y < h.lm[5].y - handSize(h) * 0.3;   // 엄지 끝이 위쪽
            });
        }
    });

    window.JebrisGestures = {
        register: register, update: update, reset: reset, config: CFG,
        list: function () { return registry.map(function (g) { return { id: g.id, label: g.label, emoji: g.emoji, type: g.type, hold: g.hold || 0 }; }); },
        get current() { return current; },
        debug: debug,
        _helpers: { fingers: fingers, bodyInfo: bodyInfo }
    };
})();
