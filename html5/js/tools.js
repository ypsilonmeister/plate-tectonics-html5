(function () {
  'use strict';
  const PT = window.PT = window.PT || {};
  const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finite = v => Number.isFinite(v) ? v : 0;

  function circle(ctx, x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  function polygon(ctx, points, fill) {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
  }

  // The glass instrument occupies 40 x 120; x is its left edge.
  function thermometer(ctx, x, liquid, probe) {
    ctx.save(); ctx.translate(x, 0);
    ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(11, 82); ctx.lineTo(11, 10);
    ctx.bezierCurveTo(11, -2, 29, -2, 29, 10);
    ctx.lineTo(29, 82);
    ctx.arc(20, 100, 19, -Math.acos(9 / 19), Math.PI + Math.acos(9 / 19));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fill(); ctx.stroke();
    const top = 94 - 90 * liquid;
    ctx.fillStyle = '#e32732';
    ctx.fillRect(16, top, 8, 101 - top);
    circle(ctx, 20, 100, 14); ctx.fill();
    ctx.strokeStyle = '#9c1720'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(16, top); ctx.lineTo(24, top); ctx.stroke();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      const y = 12 + i * 7.5;
      ctx.beginPath(); ctx.moveTo(27, y); ctx.lineTo(i % 3 === 0 ? 35 : 32, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(13.5, 14); ctx.lineTo(13.5, 76); ctx.stroke();
    if (probe) {
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
      // Far-left vertex is the sampling location, beside the bulb.
      polygon(ctx, [[-14, 100], [-3, 94], [-3, 106]], '#ef2936');
    }
    ctx.restore();
  }

  class Thermometer {
    constructor() {
      this.width = 54; this.height = 120;
      this.sensor = { x: 0, y: 100 };
      this.kelvin = 0;
    }
    setTemperature(kelvin) { this.kelvin = Math.max(0, finite(kelvin)); }
    draw(ctx) {
      const v = this.kelvin / 2000;
      thermometer(ctx, 14, clamp(0.2 + 0.7 * (v % 1), 0.2, 0.9), true);
      for (let i = 0; i < Math.floor(v); i++) {
        ctx.save(); ctx.translate(14 + 45 + i * 30, 0); ctx.scale(0.4, 0.4);
        thermometer(ctx, 0, 0.9, false); ctx.restore();
      }
    }
  }

  const ZERO = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;
  function gauge(ctx, fraction, readout, probe) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.5; ctx.strokeStyle = '#333';
    if (probe) {
      polygon(ctx, [[44, 93], [56, 93], [54, 116], [50, 125], [46, 116]], '#b7bdc4');
    }
    circle(ctx, 50, 50, 49); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    if (fraction > 0) {
      ctx.beginPath();
      ctx.arc(50, 50, 44, ZERO, ZERO + SWEEP * fraction);
      ctx.strokeStyle = 'rgb(255,200,80)'; ctx.lineWidth = 10; ctx.stroke();
    }
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
    circle(ctx, 50, 50, 49); ctx.stroke();
    for (let i = 0; i <= 28; i++) {
      const a = ZERO + SWEEP * i / 28;
      const inner = i % 4 === 0 ? 34 : 39;
      ctx.beginPath(); ctx.moveTo(50 + Math.cos(a) * inner, 50 + Math.sin(a) * inner);
      ctx.lineTo(50 + Math.cos(a) * 45, 50 + Math.sin(a) * 45); ctx.stroke();
    }
    ctx.fillStyle = '#222'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px ' + FONT; ctx.fillText('密度', 50, 30);
    const a = ZERO + SWEEP * fraction;
    const dx = Math.cos(a), dy = Math.sin(a);
    polygon(ctx, [[50 - dy * 2.5, 50 + dx * 2.5], [50 + dx * 35, 50 + dy * 35],
      [50 + dy * 2.5, 50 - dx * 2.5]], '#d62732');
    circle(ctx, 50, 50, 4); ctx.fillStyle = '#333'; ctx.fill();
    ctx.font = '10px ' + FONT;
    // Fit even unusually large target values inside the face.
    const w = ctx.measureText(readout).width;
    ctx.save(); ctx.translate(50, 70); ctx.scale(Math.min(1, 82 / Math.max(1, w)), 1);
    ctx.fillText(readout, 0, 0); ctx.restore(); ctx.restore();
  }

  class DensityMeter {
    constructor() {
      this.width = 100; this.height = 125;
      this.sensor = { x: 50, y: 125 };
      this.target = 0; this.p = 0; this.velocity = 0;
    }
    setDensity(value, dtSeconds) {
      this.target = Math.max(0, finite(value));
      const dt = Math.max(0, finite(dtSeconds));
      // Exact critically damped solution, mass=1, k=70, c=2*sqrt(70).
      const omega = Math.sqrt(70), error = this.p - this.target;
      const b = this.velocity + omega * error, decay = Math.exp(-omega * dt);
      this.p = this.target + (error + b * dt) * decay;
      this.velocity = (this.velocity - omega * b * dt) * decay;
    }
    draw(ctx) {
      const p = Math.max(0, this.p), n = Math.floor(p / 3500);
      const readout = this.inToolbox ? '' : Math.round(this.target).toLocaleString('en-US') + ' kg/m³';
      gauge(ctx, (p % 3500) / 3500, readout, true);
      for (let i = 0; i < n; i++) {
        ctx.save(); ctx.translate(110 + i * 50, 0); ctx.scale(0.4, 0.4);
        gauge(ctx, 1, '3,500 kg/m³', false); ctx.restore();
      }
    }
  }

  class Ruler {
    constructor() { this.width = 30; this.height = 300; this.multiplier = 1; }
    setMultiplier(m) { this.multiplier = Number.isFinite(m) && m > 0 ? m : 1; }
    draw(ctx) {
      ctx.save(); ctx.fillStyle = '#fff4ce'; ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
      ctx.fillRect(0.5, 0.5, 29, 299); ctx.strokeRect(0.5, 0.5, 29, 299);
      ctx.font = '9px ' + FONT; ctx.textAlign = 'right'; ctx.fillStyle = '#222';
      for (let k = 0; k <= 10; k++) {
        const y = 300 - 30 * k;
        ctx.beginPath(); ctx.moveTo(0, clamp(y, 0.5, 299.5));
        ctx.lineTo(9, clamp(y, 0.5, 299.5)); ctx.stroke();
        ctx.textBaseline = k === 0 ? 'bottom' : k === 10 ? 'top' : 'middle';
        ctx.fillText(String(k * 10 * this.multiplier), 28, clamp(y, 2, 298), 20);
        if (k < 10) {
          ctx.beginPath(); ctx.moveTo(0, y - 15); ctx.lineTo(5, y - 15); ctx.stroke();
        }
      }
      ctx.textBaseline = 'top'; ctx.fillText('km', 28, 13); ctx.restore();
    }
  }

  function crustStyle(type) {
    switch (type) {
      case 'CONTINENTAL': return { height: 100, gray: 0.8 };
      case 'YOUNG_OCEANIC': return { height: 35, gray: 0.5 };
      case 'OLD_OCEANIC': return { height: 35, gray: 0.4 };
      default: throw new RangeError('Unknown crust type: ' + type);
    }
  }
  const gray = g => { const v = Math.round(g * 255); return 'rgb(' + v + ',' + v + ',' + v + ')'; };
  function crustPieceSize(type) { return { width: 140, height: crustStyle(type).height }; }
  function drawCrustPiece(ctx, type) {
    const { height: f, gray: g } = crustStyle(type);
    ctx.save(); ctx.strokeStyle = 'rgb(51,51,51)'; ctx.lineWidth = 1; ctx.lineJoin = 'miter';
    polygon(ctx, [[0, 20], [110, 20], [110, f], [0, f]], gray(g));
    polygon(ctx, [[0, 20], [30, 0], [140, 0], [110, 20]], gray(1 - (1 - g) * 0.5));
    polygon(ctx, [[110, 20], [140, 0], [140, f - 20], [110, f]], gray(1 - (1 - g) * 0.3));
    ctx.restore();
  }
  function drawToolboxIcon(ctx, kind, x, y, h) {
    const widget = kind === 'ruler' ? new Ruler() : kind === 'thermometer' ? new Thermometer() :
      kind === 'density' ? new DensityMeter() : null;
    if (!widget) throw new RangeError('Unknown tool kind: ' + kind);
    if (kind === 'density') widget.inToolbox = true; // DensitySensorNode2D in the toolbox: needle at zero, no readout
    const scale = Math.max(0, finite(h)) / widget.height;
    ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); widget.draw(ctx); ctx.restore();
    return widget.width * scale;
  }

  PT.Tools = { Thermometer, DensityMeter, Ruler, drawCrustPiece, crustPieceSize, drawToolboxIcon };
})();
