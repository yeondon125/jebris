/*
 * 홀로그램 코어 + 배경 물결 그리기 (Figma 디자인과 같은 모양)
 *  - #holo 안에 와이어프레임 구체를 SVG로 만들고, 경선(세로 타원)을 매 프레임 바꿔 3D로 도는 것처럼 보이게 한다.
 *  - 색은 CSS의 currentColor(상태별 --holo 색)를 따른다.
 *  - 음성 크기는 #holo 의 CSS 변수 --level(0~1)로 받는다. (jarvis.js가 넣어줌)
 *  - #waves 에 배경 물결을 그린다.
 */
(function () {
    'use strict';
    var NS = 'http://www.w3.org/2000/svg';
    function el(tag, attrs, parent) {
        var e = document.createElementNS(NS, tag);
        for (var k in attrs) e.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(e);
        return e;
    }
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------------- 홀로그램 ----------------
    var host = document.getElementById('core');
    if (host) buildHolo(host);

    function buildHolo(host) {
        var W = 520, H = 580, cx = 260, cy = 250, R = 150;
        var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'holo-svg', 'aria-hidden': 'true', fill: 'none' }, host);
        var defs = el('defs', {}, svg);
        var beam = el('linearGradient', { id: 'holoBeam', x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
        el('stop', { offset: 0, 'stop-color': 'currentColor', 'stop-opacity': 0.4 }, beam);
        el('stop', { offset: 1, 'stop-color': 'currentColor', 'stop-opacity': 0 }, beam);
        var core = el('radialGradient', { id: 'holoCore' }, defs);
        el('stop', { offset: 0, 'stop-color': '#ffffff' }, core);
        el('stop', { offset: 0.38, 'stop-color': 'currentColor' }, core);
        el('stop', { offset: 1, 'stop-color': 'currentColor', 'stop-opacity': 0 }, core);

        // 프로젝터 빛기둥 + 받침
        el('path', { d: 'M' + (cx - 40) + ' 530 L' + (cx - 150) + ' ' + (cy + 60) + ' L' + (cx + 150) + ' ' + (cy + 60) + ' L' + (cx + 40) + ' 530 Z', fill: 'url(#holoBeam)', 'class': 'holo-beam' }, svg);
        for (var i = 0; i < 7; i++) {
            var x = cx - 36 + i * 12;
            el('path', { d: 'M' + x + ' 530 L' + (cx + (x - cx) * 3.6) + ' ' + (cy + 70), stroke: 'currentColor', 'stroke-opacity': 0.12 }, svg);
        }
        var base = el('g', { 'class': 'holo-base' }, svg);
        el('ellipse', { cx: cx, cy: 532, rx: 74, ry: 13, stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-opacity': 0.9 }, base);
        el('ellipse', { cx: cx, cy: 532, rx: 52, ry: 8, stroke: 'currentColor', 'stroke-opacity': 0.5, 'stroke-dasharray': '3 4' }, base);
        el('ellipse', { cx: cx, cy: 532, rx: 30, ry: 5, fill: 'currentColor', 'fill-opacity': 0.8 }, base);
        el('ellipse', { cx: cx, cy: 548, rx: 96, ry: 16, stroke: 'currentColor', 'stroke-opacity': 0.3 }, base);

        // 구체 그룹 (말할 때 소리에 맞춰 커짐)
        var sphere = el('g', { 'class': 'holo-sphere' }, svg);
        // 주사선
        var scan = el('g', { 'class': 'holo-scan' }, sphere);
        for (var y = cy - R + 3; y < cy + R; y += 5) {
            var dx = Math.sqrt(R * R - (y - cy) * (y - cy));
            el('path', { d: 'M' + (cx - dx).toFixed(1) + ' ' + y + 'H' + (cx + dx).toFixed(1), stroke: 'currentColor', 'stroke-opacity': 0.06 }, scan);
        }
        // 와이어프레임 (기울임)
        var wire = el('g', { transform: 'rotate(-14 ' + cx + ' ' + cy + ')' }, sphere);
        [-60, -40, -20, 0, 20, 40, 60].forEach(function (deg) {
            var p = deg * Math.PI / 180, rx = R * Math.cos(p);
            el('ellipse', { cx: cx, cy: (cy + R * Math.sin(p) * 0.98).toFixed(1), rx: rx.toFixed(1), ry: (rx * 0.22).toFixed(1),
                stroke: 'currentColor', 'stroke-opacity': deg === 0 ? 0.7 : 0.35, 'stroke-width': deg === 0 ? 1.4 : 1 }, wire);
        });
        var longs = [];
        for (var j = 0; j < 6; j++) {
            longs.push(el('ellipse', { cx: cx, cy: cy, rx: R, ry: R, stroke: 'currentColor', 'stroke-opacity': 0.32 }, wire));
        }
        el('circle', { cx: cx, cy: cy, r: R, stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-opacity': 0.95 }, sphere);

        // 표면 입자
        var seed = 7;
        function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
        var dots = el('g', { 'class': 'holo-dots' }, sphere);
        for (var d = 0; d < 46; d++) {
            var a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.97;
            el('circle', { cx: (cx + Math.cos(a) * rr).toFixed(1), cy: (cy + Math.sin(a) * rr).toFixed(1), r: (rnd() * 1.4 + 0.6).toFixed(1),
                fill: '#fff', 'fill-opacity': (rnd() * 0.6 + 0.3).toFixed(2) }, dots);
        }

        // 중심 코어 + 원형 오디오 바
        var ccy = cy - 20;
        var bars = [];
        var barG = el('g', { 'class': 'holo-bars' }, sphere);
        for (var b = 0; b < 64; b++) {
            var ang = b / 64 * Math.PI * 2;
            bars.push({ el: el('path', { stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-opacity': 0.85 }, barG), a: ang, seed: Math.abs(Math.sin(b * 0.7) * Math.cos(b * 0.23)) });
        }
        el('circle', { cx: cx, cy: ccy, r: 46, fill: 'url(#holoCore)', 'class': 'holo-core' }, sphere);
        el('circle', { cx: cx, cy: ccy, r: 26, stroke: '#fff', 'stroke-opacity': 0.7 }, sphere);

        // 눈금 링 (천천히 회전)
        var ticks = el('g', { 'class': 'holo-ticks' }, svg);
        var RT = 192;
        for (var t = 0; t < 120; t++) {
            var ta = t / 120 * Math.PI * 2, L = t % 10 === 0 ? 10 : 4;
            el('path', { d: 'M' + (cx + Math.cos(ta) * RT).toFixed(1) + ' ' + (cy + Math.sin(ta) * RT).toFixed(1) + 'L' + (cx + Math.cos(ta) * (RT - L)).toFixed(1) + ' ' + (cy + Math.sin(ta) * (RT - L)).toFixed(1),
                stroke: 'currentColor', 'stroke-opacity': t % 10 === 0 ? 0.7 : 0.25 }, ticks);
        }
        function arc(r, a0, a1) {
            function p(a) { return (cx + Math.cos(a) * r).toFixed(1) + ' ' + (cy + Math.sin(a) * r).toFixed(1); }
            return 'M' + p(a0) + 'A' + r + ' ' + r + ' 0 ' + (a1 - a0 > Math.PI ? 1 : 0) + ' 1 ' + p(a1);
        }
        var arcs = el('g', { 'class': 'holo-arcs' }, svg);
        el('path', { d: arc(206, -2.7, -1.7), stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round' }, arcs);
        el('path', { d: arc(206, -0.5, 0.3), stroke: 'currentColor', 'stroke-opacity': 0.6, 'stroke-width': 3, 'stroke-linecap': 'round' }, arcs);
        el('path', { d: arc(172, 1.9, 2.9), stroke: 'currentColor', 'stroke-opacity': 0.6, 'stroke-width': 1.5, 'stroke-dasharray': '2 5' }, arcs);

        // 궤도
        var orbit = el('g', { transform: 'rotate(-18 ' + cx + ' ' + cy + ')' }, svg);
        el('ellipse', { cx: cx, cy: cy, rx: 236, ry: 48, stroke: 'currentColor', 'stroke-opacity': 0.35 }, orbit);
        var sat = el('circle', { r: 4, fill: '#fff' }, orbit);

        // 애니메이션
        var t0 = performance.now();
        function frame(now) {
            var s = (now - t0) / 1000;
            var cs = getComputedStyle(host);
            var level = parseFloat(cs.getPropertyValue('--level')) || 0;
            var speed = parseFloat(cs.getPropertyValue('--spin')) || 1;
            var spin = s * 0.5 * speed;
            // 경선: 회전하는 구의 세로선 = 폭이 cos로 변하는 타원
            for (var k = 0; k < longs.length; k++) {
                var th = spin + k * Math.PI / longs.length;
                var w = Math.abs(R * Math.cos(th));
                longs[k].setAttribute('rx', Math.max(0.5, w).toFixed(1));
                longs[k].setAttribute('stroke-opacity', (0.15 + 0.35 * Math.abs(Math.sin(th))).toFixed(2));
            }
            // 오디오 바: 말할 때 크게, 평소엔 잔잔하게
            var amp = 0.25 + level * 1.6;
            for (var m = 0; m < bars.length; m++) {
                var B = bars[m];
                var len = 5 + (B.seed * 14 + Math.abs(Math.sin(s * 3 * speed + m * 0.55)) * 10) * amp;
                var r0 = 52;
                B.el.setAttribute('d', 'M' + (cx + Math.cos(B.a) * r0).toFixed(1) + ' ' + (ccy + Math.sin(B.a) * r0).toFixed(1) +
                    'L' + (cx + Math.cos(B.a) * (r0 + len)).toFixed(1) + ' ' + (ccy + Math.sin(B.a) * (r0 + len)).toFixed(1));
            }
            var oa = s * 0.6 * speed;
            sat.setAttribute('cx', (cx + Math.cos(oa) * 236).toFixed(1));
            sat.setAttribute('cy', (cy + Math.sin(oa) * 48).toFixed(1));
            sphere.setAttribute('transform', 'translate(' + cx + ' ' + cy + ') scale(' + (1 + level * 0.08).toFixed(3) + ') translate(' + (-cx) + ' ' + (-cy) + ')');
            if (!reduceMotion) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    // ---------------- 배경 물결 ----------------
    var waves = document.getElementById('waves');
    if (waves) {
        var ribbons = [
            ['M 0 40 C 360 20, 380 300, 610 330', '#3DDCFF', '#8A5CFF'],
            ['M 1460 160 C 1200 140, 1150 380, 945 400', '#8A5CFF', '#3DDCFF'],
            ['M 180 920 C 300 700, 480 640, 640 570', '#4F6BFF', '#3DDCFF'],
            ['M 1120 920 C 1020 760, 1040 640, 905 585', '#3DDCFF', '#4F6BFF'],
            ['M 760 -20 C 690 110, 860 160, 790 262', '#8A5CFF', '#3DDCFF'],
            ['M -20 540 C 400 440, 500 780, 740 700 S 1100 560, 1460 650', '#3DDCFF', '#8A5CFF'],
            ['M -20 300 C 300 400, 520 120, 1460 50', '#4F6BFF', '#8A5CFF']
        ];
        var svg = el('svg', { viewBox: '0 0 1440 900', preserveAspectRatio: 'xMidYMid slice', fill: 'none', 'aria-hidden': 'true' }, waves);
        var defs = el('defs', {}, svg);
        ribbons.forEach(function (rb, ri) {
            var gr = el('linearGradient', { id: 'wv' + ri, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
            el('stop', { offset: 0, 'stop-color': rb[1], 'stop-opacity': 0 }, gr);
            el('stop', { offset: 0.5, 'stop-color': rb[1], 'stop-opacity': 0.9 }, gr);
            el('stop', { offset: 1, 'stop-color': rb[2], 'stop-opacity': 0.6 }, gr);
            var g = el('g', { 'class': 'wave wave-' + ri }, svg);
            for (var i = 0; i < 6; i++) {
                el('path', { d: rb[0], transform: 'translate(' + i * 3 + ' ' + i * 6 + ')', stroke: 'url(#wv' + ri + ')',
                    'stroke-width': i === 0 ? 2 : 1, 'stroke-opacity': (1 - i * 0.15).toFixed(2) }, g);
            }
            // 물결 위로 흐르는 빛 알갱이
            el('path', { d: rb[0], stroke: '#ffffff', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': '2 40', 'class': 'wave-flow', style: 'animation-delay:-' + (ri * 1.3) + 's' }, g);
        });
    }
})();
