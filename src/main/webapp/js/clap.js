/*
 * 박수 두 번(짝·짝) 감지기
 *
 *  마이크 소리를 계속 분석해서 "짧고 날카롭고 고음이 많은 큰 소리"(박수)를 찾는다.
 *  - 소리 크기가 직전보다 갑자기 커지고(onset), 주변 소음보다 충분히 크고,
 *  - 고음(1.5kHz 이상) 비율이 높으면 박수 한 번으로 본다. (말소리는 저음 위주라 걸러짐)
 *  - 박수 두 번이 0.15~0.7초 간격으로 나고, 그 뒤 0.45초 동안 또 안 치면 "짝·짝"으로 확정.
 *    (세 번 이상 연달아 치는 박수/소음은 무시)
 *
 *  사용법:
 *    var clap = new JebrisClap({ onDouble: fn, onClap: fn, onLevel: fn });
 *    clap.start();   // 사용자 클릭 안에서 호출해야 마이크/오디오가 켜진다
 *    clap.pause(); clap.resume(); clap.stop();
 */
(function () {
    'use strict';

    var DEFAULTS = {
        minPeak: 0.22,        // 이 크기(0~1)보다 작은 소리는 박수로 보지 않음
        noiseFactor: 6,       // 주변 소음(RMS)의 몇 배 이상이어야 하는지
        onsetRatio: 2.6,      // 직전 프레임 대비 몇 배 이상 갑자기 커져야 하는지
        highRatio: 0.32,      // 전체 에너지 중 고음(>1.5kHz) 비율 최소값
        refractoryMs: 110,    // 박수 한 번 뒤 이 시간 동안은 다음 박수로 안 봄 (울림 무시)
        minGapMs: 150,        // 두 박수 사이 최소 간격
        maxGapMs: 700,        // 두 박수 사이 최대 간격
        settleMs: 450,        // 두 번째 박수 뒤 이 시간 동안 조용해야 확정
        cooldownMs: 2500      // 한 번 반응한 뒤 쉬는 시간
    };

    function JebrisClap(opts) {
        opts = opts || {};
        this.cfg = {};
        for (var k in DEFAULTS) this.cfg[k] = (opts[k] !== undefined) ? opts[k] : DEFAULTS[k];
        this.onDouble = opts.onDouble || function () {};
        this.onClap = opts.onClap || function () {};
        this.onLevel = opts.onLevel || function () {};

        this.running = false;
        this.paused = false;
        this.ctx = null;
        this.stream = null;
        this.analyser = null;
        this.raf = 0;

        this.noise = 0.01;        // 주변 소음 RMS (천천히 따라감)
        this.prevRms = 0;
        this.lastClapAt = -1e9;
        this.claps = [];          // 최근 박수 시각들
        this.settleTimer = 0;
        this.cooldownUntil = 0;
    }

    JebrisClap.prototype.start = function () {
        var self = this;
        if (self.running) return Promise.resolve();
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return Promise.reject(new Error('unsupported'));
        }
        // 브라우저의 소음 제거/자동 볼륨은 박수 같은 순간 소리를 깎아 버리므로 끈다.
        return navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        }).then(function (stream) {
            var AC = window.AudioContext || window.webkitAudioContext;
            self.stream = stream;
            self.ctx = new AC();
            var src = self.ctx.createMediaStreamSource(stream);
            self.analyser = self.ctx.createAnalyser();
            self.analyser.fftSize = 1024;
            self.analyser.smoothingTimeConstant = 0;
            src.connect(self.analyser);
            self.time = new Float32Array(self.analyser.fftSize);
            self.freq = new Float32Array(self.analyser.frequencyBinCount);
            self.splitBin = Math.round(1500 / (self.ctx.sampleRate / self.analyser.fftSize));
            self.running = true;
            if (self.ctx.state === 'suspended') self.ctx.resume();
            self._loop();
        });
    };

    JebrisClap.prototype.stop = function () {
        this.running = false;
        cancelAnimationFrame(this.raf);
        clearTimeout(this.settleTimer);
        if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
        if (this.ctx) this.ctx.close();
        this.stream = this.ctx = this.analyser = null;
    };

    JebrisClap.prototype.pause = function () {
        this.paused = true;
        this.claps = [];
        clearTimeout(this.settleTimer);
    };

    JebrisClap.prototype.resume = function () {
        this.paused = false;
        this.claps = [];
        this.prevRms = 0;
    };

    JebrisClap.prototype._loop = function () {
        var self = this;
        if (!self.running) return;
        self.raf = requestAnimationFrame(function () { self._loop(); });

        var a = self.analyser, t = self.time;
        a.getFloatTimeDomainData(t);
        var peak = 0, sum = 0;
        for (var i = 0; i < t.length; i++) {
            var v = t[i] < 0 ? -t[i] : t[i];
            if (v > peak) peak = v;
            sum += t[i] * t[i];
        }
        var rms = Math.sqrt(sum / t.length);
        var now = performance.now();
        var c = self.cfg;

        // 화면 미터용: 0~1 크기와 현재 기준값
        var threshold = Math.max(c.minPeak, self.noise * c.noiseFactor);
        self.onLevel(Math.min(1, peak), Math.min(1, threshold));

        var isOnset = peak >= threshold &&
            rms > self.prevRms * c.onsetRatio &&
            now - self.lastClapAt > c.refractoryMs;

        if (isOnset && !self.paused && now >= self.cooldownUntil && self._highRatio() >= c.highRatio) {
            self.lastClapAt = now;
            self._onClap(now);
        } else if (peak < threshold) {
            // 조용한 구간에서만 주변 소음을 갱신 (박수 소리가 소음 기준을 올리지 않게)
            self.noise = self.noise * 0.98 + rms * 0.02;
        }
        self.prevRms = rms * 0.6 + self.prevRms * 0.4;
    };

    // 전체 에너지 중 1.5kHz 이상 비율 — 박수는 고음이 많고 말소리는 적다.
    JebrisClap.prototype._highRatio = function () {
        var f = this.freq;
        this.analyser.getFloatFrequencyData(f);
        var lo = 0, hi = 0;
        for (var i = 1; i < f.length; i++) {
            var p = Math.pow(10, f[i] / 10);
            if (i < this.splitBin) lo += p; else hi += p;
        }
        return hi / (lo + hi + 1e-12);
    };

    JebrisClap.prototype._onClap = function (now) {
        var self = this, c = self.cfg;
        self.onClap(now);
        clearTimeout(self.settleTimer);

        // 너무 오래된 박수는 버린다
        self.claps = self.claps.filter(function (t) { return now - t <= c.maxGapMs * 2; });
        self.claps.push(now);

        if (self.claps.length === 2) {
            var gap = self.claps[1] - self.claps[0];
            if (gap < c.minGapMs || gap > c.maxGapMs) {
                self.claps = [now]; // 간격이 안 맞으면 이번 것을 첫 박수로
                return;
            }
            // 잠깐 기다렸다가 세 번째 박수가 없으면 확정
            self.settleTimer = setTimeout(function () {
                if (self.claps.length === 2 && !self.paused) {
                    self.claps = [];
                    self.cooldownUntil = performance.now() + c.cooldownMs;
                    self.onDouble();
                }
            }, c.settleMs);
        } else if (self.claps.length > 2) {
            // 세 번 이상 = 박수갈채나 소음 → 무시하고 잠시 쉼
            self.claps = [];
            self.cooldownUntil = now + 800;
        }
    };

    window.JebrisClap = JebrisClap;
})();
