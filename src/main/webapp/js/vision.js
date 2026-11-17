/*
 * 웹캠 + 사람(몸·손) 인식
 *
 *  - 노트북 웹캠 영상을 MediaPipe 로 분석한다. (브라우저 안에서만 처리, 서버로 보내지 않음)
 *      · PoseLandmarker : 몸 관절 33개
 *      · HandLandmarker : 손 관절 21개 × 최대 2손
 *  - 매 프레임 결과를 gestures.js(JebrisGestures.update)에 넘겨 제스처를 판정한다.
 *  - 화면 상태는 window 이벤트 'jebris:vision' 으로 알린다.
 *      detail = { running, present, activity, emoji, confidence, hands }
 *  - 제스처 이벤트(박수 두 번 등)는 gestures.js가 'jebris:gesture' 로 알린다.
 *  - window.JebrisVision.start() / stop() / state
 */
const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 몸 뼈대 (포즈 33점)
const BODY_BONES = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [0, 11], [0, 12]
];
const BODY_JOINTS = [0, 11, 12, 13, 14, 23, 24, 25, 26, 27, 28];
// 손 뼈대 (손 21점)
const HAND_BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],            // 엄지
    [0, 5], [5, 6], [6, 7], [7, 8],            // 검지
    [5, 9], [9, 10], [10, 11], [11, 12],       // 중지
    [9, 13], [13, 14], [14, 15], [15, 16],     // 약지
    [13, 17], [0, 17], [17, 18], [18, 19], [19, 20] // 새끼
];
const PRESENT_HOLD_MS = 1200;

const state = { running: false, present: false, activity: '카메라 꺼짐', emoji: '', confidence: 0, hands: 0, lastSeenAt: 0 };

let video, canvas, g2d, pose = null, hand = null, stream = null, raf = 0, lastVideoTime = -1;
let lastHands = [], frameNo = 0, lastEmitKey = '';

function emit() {
    const key = [state.running, state.present, state.activity, state.hands, Math.round(state.confidence * 20)].join('|');
    if (key === lastEmitKey) return;
    lastEmitKey = key;
    window.dispatchEvent(new CustomEvent('jebris:vision', {
        detail: { running: state.running, present: state.present, activity: state.activity, emoji: state.emoji, confidence: state.confidence, hands: state.hands }
    }));
}

async function loadModels() {
    if (pose && hand) return;
    const { PoseLandmarker, HandLandmarker, FilesetResolver } = await import(`${MP_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const make = async (Cls, model, extra) => {
        const opts = (delegate) => Object.assign({ baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO' }, extra);
        try { return await Cls.createFromOptions(fileset, opts('GPU')); }
        catch (e) { return await Cls.createFromOptions(fileset, opts('CPU')); }
    };
    [pose, hand] = await Promise.all([
        make(PoseLandmarker, POSE_MODEL, { numPoses: 1 }),
        make(HandLandmarker, HAND_MODEL, { numHands: 2, minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })
    ]);
}

function draw(lm, hands) {
    const w = canvas.width, h = canvas.height;
    g2d.clearRect(0, 0, w, h);
    const css = getComputedStyle(canvas);
    const bodyColor = css.getPropertyValue('--pose').trim() || '#6ff6ff';
    const handColor = css.getPropertyValue('--hand').trim() || '#b69cff';
    const X = (p) => (1 - p.x) * w;   // 거울처럼 좌우 반전
    const Y = (p) => p.y * h;
    const line = (a, b) => { g2d.beginPath(); g2d.moveTo(X(a), Y(a)); g2d.lineTo(X(b), Y(b)); g2d.stroke(); };
    const dot = (p, r) => { g2d.beginPath(); g2d.arc(X(p), Y(p), r, 0, Math.PI * 2); g2d.fill(); };
    g2d.lineCap = 'round';

    if (lm) {
        g2d.lineWidth = Math.max(2, w / 170);
        g2d.strokeStyle = bodyColor; g2d.shadowColor = bodyColor; g2d.shadowBlur = 10;
        for (const [a, b] of BODY_BONES) if ((lm[a].visibility ?? 1) > 0.4 && (lm[b].visibility ?? 1) > 0.4) line(lm[a], lm[b]);
        g2d.shadowBlur = 0; g2d.fillStyle = '#ffffff';
        for (const i of BODY_JOINTS) if ((lm[i].visibility ?? 1) > 0.4) dot(lm[i], Math.max(2.5, w / 120));
    }
    for (const hd of hands) {
        g2d.lineWidth = Math.max(1.5, w / 260);
        g2d.strokeStyle = handColor; g2d.shadowColor = handColor; g2d.shadowBlur = 8;
        for (const [a, b] of HAND_BONES) line(hd.lm[a], hd.lm[b]);
        g2d.shadowBlur = 0; g2d.fillStyle = '#ffffff';
        hd.lm.forEach((p, i) => dot(p, [4, 8, 12, 16, 20].includes(i) ? Math.max(2.5, w / 150) : Math.max(1.5, w / 240)));
    }
}

function loop() {
    if (!state.running) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }

    const now = performance.now();
    const poseRes = pose.detectForVideo(video, now);
    const lm = poseRes.landmarks && poseRes.landmarks[0] || null;

    // 손 모양 인식은 무거워서 3프레임에 한 번 (사이 프레임은 직전 결과 사용).
    // 박수·흔들기는 몸 모델로 판정하므로, 몸 모델이 최대한 자주 돌게 한다.
    if (frameNo++ % 3 === 0) {
        const handRes = hand.detectForVideo(video, now);
        lastHands = (handRes.landmarks || []).map((pts, i) => ({
            lm: pts,
            side: (handRes.handedness && handRes.handedness[i] && handRes.handedness[i][0] && handRes.handedness[i][0].categoryName) || ''
        }));
    }
    draw(lm, lastHands);

    const result = window.JebrisGestures ? window.JebrisGestures.update({ t: now, pose: lm, hands: lastHands }) : { current: null };

    const conf = lm ? ((lm[11].visibility ?? 1) + (lm[12].visibility ?? 1)) / 2 : 0;
    if (conf > 0.5 || lastHands.length) state.lastSeenAt = now;
    state.present = now - state.lastSeenAt < PRESENT_HOLD_MS;
    state.hands = lastHands.length;
    if (!state.present) { state.activity = '사람 없음'; state.emoji = ''; state.confidence = 0; }
    else {
        state.activity = result.current ? result.current.label : '정면 대기';
        state.emoji = result.current ? (result.current.emoji || '') : '';
        state.confidence = Math.max(conf, lastHands.length ? 0.9 : 0);
    }
    emit();
}

async function startInner() {
    video = document.getElementById('camVideo');
    canvas = document.getElementById('camCanvas');
    g2d = canvas.getContext('2d');

    state.activity = '카메라 켜는 중…'; lastEmitKey = ''; emit();
    stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        audio: false
    });
    video.srcObject = stream;
    await video.play();

    state.activity = 'AI 모델 불러오는 중…'; emit();
    await loadModels();

    if (window.JebrisGestures) window.JebrisGestures.reset();
    state.running = true;
    state.activity = '사람 찾는 중…'; emit();
    loop();
}

async function start() {
    if (state.running) return;
    try {
        await startInner();
    } catch (e) {
        stop();
        state.activity = '인식을 시작하지 못했어요';
        lastEmitKey = ''; emit();
        throw e;
    }
}

function stop() {
    state.running = false; state.present = false; state.activity = '카메라 꺼짐'; state.emoji = ''; state.confidence = 0; state.hands = 0;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; lastHands = [];
    if (g2d) g2d.clearRect(0, 0, canvas.width, canvas.height);
    lastEmitKey = ''; emit();
}

window.JebrisVision = { start, stop, state };
window.dispatchEvent(new Event('jebris:vision-ready'));
