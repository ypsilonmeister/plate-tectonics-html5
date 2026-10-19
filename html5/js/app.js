// Application: tabs, GUI panels, tools, pointer interaction, frame loop.
// Ported from PlateTectonicsTab / CrustTab / PlateMotionTab and the control/* panels.
(function () {
  'use strict';
  const PT = window.PT;
  const { V3, Side, Property, STR, PlateTectonicsModel, ColorMode, ModelViewTransform } = PT;
  const $ = (id) => document.getElementById(id);
  const toRadial = PlateTectonicsModel.convertToRadial;

  // ================================================================ renderer / layout
  const wrap = $('stageWrap'), glCanvas = $('gl'), overlay = $('overlay'), stage = $('stage');
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
  renderer.setClearColor(new THREE.Color(0.85, 0.95, 1.0), 1);
  const octx = overlay.getContext('2d');
  const texture = PT.makeNoiseTexture();
  let W = 1, H = 1, DPR = 1, stageScale = 1, stageOX = 0, stageOY = 0;

  function resize() {
    W = wrap.clientWidth; H = wrap.clientHeight; DPR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(DPR);
    renderer.setSize(W, H, false);
    overlay.width = Math.round(W * DPR); overlay.height = Math.round(H * DPR);
    stageScale = Math.min(W / PT.STAGE_W, H / PT.STAGE_H);
    stageOX = (W - PT.STAGE_W * stageScale) / 2; stageOY = (H - PT.STAGE_H * stageScale) / 2;
    stage.style.transform = `translate(${stageOX}px, ${stageOY}px) scale(${stageScale})`;
  }
  window.addEventListener('resize', resize);
  resize();

  // pointer position relative to the 3D canvas (CSS px)
  const localXY = (e) => { const r = wrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const isOver = (el, e) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const show = (el, on) => { if (el.classList.contains('hidden') === on) el.classList.toggle('hidden', !on); };
  const visible = (el, on) => { if (el.classList.contains('invisible') === on) el.classList.toggle('invisible', !on); };

  // ================================================================ shared GUI builders
  function buildViewOptions(el, colorMode, showLabels, showWater) {
    const name = 'cm' + Math.random().toString(36).slice(2);
    el.innerHTML = `<div class="panelTitle">${STR.options}</div>
      <label><input type="radio" name="${name}" value="DENSITY"> ${STR.densityView}</label>
      <label><input type="radio" name="${name}" value="TEMPERATURE"> ${STR.temperatureView}</label>
      <label><input type="radio" name="${name}" value="COMBINED"> ${STR.bothView}</label>
      <div style="height:5px"></div>
      <label><input type="checkbox" data-k="labels"> ${STR.showLabels}</label>
      ${showWater ? `<label class="waterLabel"><input type="checkbox" data-k="water"> ${STR.showSeawater}</label>` : ''}`;
    const radios = el.querySelectorAll('input[type=radio]');
    radios.forEach((r) => r.addEventListener('change', () => colorMode.set(ColorMode[r.value])));
    colorMode.addObserver((m) => radios.forEach((r) => (r.checked = r.value === m.name)));
    const cb = el.querySelector('[data-k=labels]');
    cb.addEventListener('change', () => showLabels.set(cb.checked));
    showLabels.addObserver((v) => (cb.checked = v));
    if (showWater) {
      const wcb = el.querySelector('[data-k=water]');
      wcb.addEventListener('change', () => showWater.set(wcb.checked));
      showWater.addObserver((v) => (wcb.checked = v));
    }
  }

  function buildLegend(el, colorMode) {
    const render = (m) => {
      if (!m.minKey) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      const c = (a) => `rgb(${a[0]},${a[1]},${a[2]})`;
      el.innerHTML = `<div class="panelTitle">${STR.legend}</div><div class="legendRow"><span>${STR[m.minKey]}</span>
        <div class="legendBar" style="background:linear-gradient(to right, ${c(m.min)}, ${c(m.max)})"></div><span>${STR[m.maxKey]}</span></div>`;
    };
    colorMode.addObserver(render);
  }

  // ================================================================ tools (ruler / thermometer / density meter)
  // RulerNode3D.getScale(): power-of-1-2.5-5 multiplier for the ruler labels when zoomed out
  function rulerZoomMultiplier(zoomFactor) {
    let n = 1, f = 1.3, z = zoomFactor;
    while (z > f) {
      n *= 2;
      if ((z /= 2) < f) break;
      z /= 2.5; n = Math.round(n * 2.5);
      if (z < f) break;
      z /= 2; n *= 2;
      f = 1 + (f - 1) * (f - 1);
    }
    return n;
  }

  class ToolSet {
    constructor(tab, toolboxEl) {
      this.tab = tab;
      this.toolboxEl = toolboxEl;
      this.tools = [];
      if (!PT.Tools) { toolboxEl.classList.add('hidden'); return; }
      // ToolboxNode layout: the ruler (0.5 scale) runs down the left edge, the title sits to
      // its right, and the thermometer and density meter (0.75 scale) are bottom-aligned with it.
      toolboxEl.innerHTML = `<div class="tbRuler"></div><div class="tbRight"><div class="panelTitle">${STR.toolbox}</div><div class="icons"></div></div>`;
      const icons = toolboxEl.querySelector('.icons');
      const make = (kind, widget) => {
        const c = document.createElement('canvas');
        const scale = kind === 'ruler' ? 0.5 : 0.75;
        const h = Math.round(widget.height * scale), w = Math.ceil(widget.width * scale);
        c.width = w * 2; c.height = h * 2; c.style.width = w + 'px'; c.style.height = h + 'px';
        const g = c.getContext('2d'); g.scale(2, 2); PT.Tools.drawToolboxIcon(g, kind, 0, 0, h);
        (kind === 'ruler' ? toolboxEl.querySelector('.tbRuler') : icons).appendChild(c);
        const tool = { kind, widget, active: false, pos: new V3(), icon: c };
        c.addEventListener('pointerdown', (e) => { e.preventDefault(); this.pullOut(tool, e); });
        this.tools.push(tool);
      };
      make('ruler', new PT.Tools.Ruler());
      make('thermometer', new PT.Tools.Thermometer());
      make('density', new PT.Tools.DensityMeter());
    }
    // view units per logical px of each tool widget (see *Node3D in the original)
    unitsPerPx(kind) {
      const tab = this.tab, f = tab.mvt.scale * 1000, zf = tab.zoomFactor();
      const isMotion = tab.isMotion;
      if (kind === 'thermometer') return (f * (isMotion ? 3 : 1) * zf) / 3;
      if (kind === 'density') return f * (isMotion ? 3 : 1) * zf * 0.25;
      return ((4 * f) / 3) * (isMotion ? 4 : 1) * rulerZoomMultiplier(zf) / 4;
    }
    sensorOf(tool) { const w = tool.widget; return tool.kind === 'ruler' ? { x: 0, y: w.height } : w.sensor; }
    screenScale(tool) { return this.unitsPerPx(tool.kind) * this.tab.rig.pxPerUnit(tool.pos); }
    screenRect(tool) {
      const a = this.tab.rig.project(tool.pos), k = this.screenScale(tool), s = this.sensorOf(tool), w = tool.widget;
      return { x: a.x - s.x * k, y: a.y - s.y * k, w: w.width * k, h: w.height * k };
    }
    pullOut(tool, e) {
      if (tool.active) return;
      tool.active = true;
      tool.icon.classList.add('out');
      const p = localXY(e);
      const u = this.unitsPerPx(tool.kind), w = tool.widget, s = this.sensorOf(tool);
      const plane = this.tab.rig.onPlaneZ(p.x, p.y);
      tool.pos = plane.plus(new V3((s.x - w.width / 2) * u, -(s.y - w.height / 2) * u, 0));
      // move it to the top of the drawing order
      this.tools.splice(this.tools.indexOf(tool), 1); this.tools.push(tool);
      startToolDrag(this, tool, e);
    }
    putBack(tool) { tool.active = false; tool.icon.classList.remove('out'); }
    hit(p) {
      for (let i = this.tools.length - 1; i >= 0; i--) {
        const t = this.tools[i];
        if (!t.active) continue;
        const r = this.screenRect(t);
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return t;
      }
      return null;
    }
    inBounds(tool) { const a = this.tab.rig.project(tool.pos); return a.x > 0 && a.x < W && a.y > 0 && a.y < H; }
    putBackOutOfBounds() { for (const t of this.tools) if (t.active && !this.inBounds(t)) this.putBack(t); }
    resetAll() { for (const t of this.tools) this.putBack(t); }
    update(dt) {
      const tab = this.tab, model = tab.model;
      for (const t of this.tools) {
        if (!t.active) continue;
        if (t.kind === 'ruler') { t.widget.setMultiplier((tab.isMotion ? 4 : 1) * rulerZoomMultiplier(tab.zoomFactor())); continue; }
        const m = PlateTectonicsModel.convertToPlanar(tab.mvt.inversePosition(t.pos));
        if (t.kind === 'thermometer') {
          t.widget.setTemperature(model.getTemperature(m.x, m.y));
        } else {
          let d = model.getDensity(m.x, m.y);
          if (d < 50) {
            const cam = tab.rig.cameraPosition();
            d = model.rayTraceDensity(cam, t.pos.minus(cam).normalized(), tab.mvt, tab.isWaterVisible());
          }
          t.widget.setDensity(d, dt);
        }
      }
    }
    draw(ctx) {
      for (const t of this.tools) {
        if (!t.active) continue;
        const a = this.tab.rig.project(t.pos), k = this.screenScale(t), s = this.sensorOf(t);
        ctx.save(); ctx.translate(a.x, a.y); ctx.scale(k, k); ctx.translate(-s.x, -s.y);
        t.widget.draw(ctx);
        ctx.restore();
      }
    }
  }

  // ================================================================ global drag routing
  let drag = null; // {move(e), up(e)}
  function startToolDrag(toolSet, tool, e) {
    let last = localXY(e);
    drag = {
      move(ev) {
        const p = localXY(ev);
        const rig = toolSet.tab.rig;
        tool.pos = tool.pos.plus(rig.onPlaneZ(p.x, p.y).minus(rig.onPlaneZ(last.x, last.y)));
        tool.pos = new V3(tool.pos.x, tool.pos.y, 0);
        last = p;
      },
      up(ev) { if (isOver(toolSet.toolboxEl, ev) || !toolSet.inBounds(tool)) toolSet.putBack(tool); }
    };
  }
  window.addEventListener('pointermove', (e) => { if (drag) { e.preventDefault(); drag.move(e); } else if (current.onHover) current.onHover(e); });
  const endDrag = (e) => { if (drag) { const d = drag; drag = null; d.up(e); } };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = localXY(e);
    const t = current.toolSet.hit(p);
    if (t) {
      current.toolSet.tools.splice(current.toolSet.tools.indexOf(t), 1); current.toolSet.tools.push(t);
      startToolDrag(current.toolSet, t, e);
      return;
    }
    if (current.onPointerDown) current.onPointerDown(e, p);
  });

  // ================================================================ base tab
  class BaseTab {
    constructor(uiEl, scale) {
      this.ui = uiEl;
      this.mvt = new ModelViewTransform(scale / 1000);
      this.rig = new PT.CameraRig();
      this.colorMode = new Property(ColorMode.DENSITY);
      this.zoomRatio = new Property(1);
      this.showLabels = new Property(false);
    }
    zoomFactor() { return PT.sceneDistanceZoomFactor(this.zoomRatio.get()); }
    viewMatrix() { return PT.baseViewMatrix(this.zoomRatio.get(), this.mvt.scale); }
    radial(v) { return this.mvt.transformPosition(toRadial(v)); }
    frame(dt) {
      this.rig.set(this.viewMatrix(), W, H);
      this.update(dt);
      this.toolSet.update(dt);
      this.sceneView.sync();
      renderer.render(this.sceneView.scene, this.rig.camera);
      octx.setTransform(DPR, 0, 0, DPR, 0, 0);
      octx.clearRect(0, 0, W, H);
      this.drawOverlay(octx);
      this.toolSet.draw(octx);
    }
    // PlateTectonicsTab.getLabelPosition: keep the label on screen when the range goes below the bottom edge
    labelPosition(top, bottom) {
      const bc = this.rig.onPlaneZ(W / 2, H, top.z);
      if (bottom.y < bc.y) {
        const f = (bc.y + top.y) / 2;
        const r = (f - top.y) / (bottom.y - top.y);
        return top.times(1 - r).plus(bottom.times(r));
      }
      return top.plus(bottom).times(0.5);
    }
  }

  // ================================================================ 地殻 tab
  class CrustTab extends BaseTab {
    constructor() {
      super($('crustUI'), 2);
      this.isMotion = false;
      this.model = new PT.CrustModel({ minX: -1500000, maxX: 1500000, minY: -150000, maxY: 15000, minZ: -2000000, maxZ: 0 });
      this.sceneView = new PT.SceneView(this.model, this.mvt, { colorMode: this.colorMode, isWaterVisible: () => true, texture });
      this.toolSet = new ToolSet(this, $('crustToolbox'));
      const m = this.model;
      // My Crust sliders (0..4096 like the JSlider in MyCrustPanel)
      const bind = (el, prop, min, max) => {
        const toSlider = () => (el.value = Math.round(((prop.get() - min) / (max - min)) * 4096));
        el.addEventListener('input', () => prop.set(min + (el.value / 4096) * (max - min)));
        prop.addObserver(toSlider);
      };
      bind($('sTemp'), m.temperatureRatio, 0, 1);
      bind($('sComp'), m.compositionRatio, 0, 1);
      bind($('sThick'), m.thickness, 4000, 70000);
      const z = $('sZoom');
      z.addEventListener('input', () => this.zoomRatio.set(Number(z.value)));
      this.zoomRatio.addObserver((v) => {
        z.value = v;
        const atOne = v === 1;
        visible($('myCrustPanel'), atOne); visible($('oceanicLabel'), atOne); visible($('continentalLabel'), atOne);
        // tools that left the screen go back into the toolbox (CrustTab zoom observer)
        if (this.toolSet) this.toolSet.putBackOutOfBounds();
      });
      buildViewOptions($('crustOptions'), this.colorMode, this.showLabels, null);
      buildLegend($('crustLegend'), this.colorMode);
      $('crustReset').querySelector('button').addEventListener('click', () => this.resetAll());
    }
    resetAll() {
      this.zoomRatio.reset();
      this.model.resetAll();
      this.colorMode.reset();
      this.showLabels.reset();
      this.toolSet.resetAll();
    }
    isWaterVisible() { return true; }
    update(dt) { this.model.update(dt); }
    drawOverlay(ctx) {
      if (!this.showLabels.get()) return;
      const m = this.model, scale = this.zoomFactor();
      const R = (x, y) => this.radial(new V3(x, y, 0));
      const lab = (top, bottom, text, dark, auto) => {
        PT.drawRangeLabel(ctx, this.rig, top, bottom, text, scale, PT.labelColor(this.colorMode, dark), auto ? this.labelPosition(top, bottom) : null);
      };
      lab(R(-10000, m.getCenterCrustElevation()), R(-10000, m.getCenterCrustBottomY()), STR.crust, true, false);
      lab(R(0, m.getCenterCrustBottomY()), R(0, -750000), STR.mantle, true, true);
      lab(R(150000, -750000), R(150000, -2921000), STR.lowerMantle, true, true);
      lab(R(-250000, -2921000), R(-250000, -5180000), STR.outerCore, false, true);
      lab(R(250000, -5180000), R(250000, -6371000), STR.innerCore, false, true);
    }
  }

  // ================================================================ handles (manual mode; Handle + HandleNode)
  const MAX_ANGLE = 1.2566370801612687;
  class HandleCtl {
    constructor(tab, isRight, offset) {
      this.tab = tab; this.isRight = isRight; this.offset = offset;
      this.orientation = new PT.V2(0, 0);
      this.group = new THREE.Group();
      tab.sceneView.extra.add(this.group);
      this.stick = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 40, 24, 1, true),
        new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      this.stick.renderOrder = 300000;
      this.ball = new THREE.Mesh(new THREE.SphereGeometry(8, 25, 25), new THREE.MeshLambertMaterial({ color: new THREE.Color(0.6, 0, 0) }));
      this.ballGlow = new THREE.Mesh(new THREE.SphereGeometry(8, 25, 25),
        new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false }));
      this.ballGlow.renderOrder = 300001;
      this.group.add(this.stick, this.ball, this.ballGlow);
      const MT = PT.MotionType;
      this.arrows = [
        this.makeArrow('front', MT.TRANSFORM, -Math.PI / 2),
        this.makeArrow('left', isRight ? MT.CONVERGENT : MT.DIVERGENT, Math.PI),
        this.makeArrow('right', isRight ? MT.DIVERGENT : MT.CONVERGENT, 0),
        this.makeArrow('back', MT.TRANSFORM, Math.PI / 2)
      ];
      this.updateGeometry();
    }
    convertRadial(v) { const mvt = this.tab.mvt; return mvt.transformPosition(toRadial(mvt.inversePosition(v))); }
    makeArrow(name, type, angle) {
      // Arrow2F (5,0)->(50,0), head 14x14, tail width 8
      const s = new THREE.Shape();
      const pts = [[5, -4], [36, -4], [36, -7], [50, 0], [36, 7], [36, 4], [5, 4]];
      pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
      const geo = new THREE.ShapeGeometry(s);
      const c = type.color;
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]), transparent: true, opacity: c[3], side: THREE.DoubleSide, depthWrite: false }));
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0))), new THREE.LineBasicMaterial({ color: 0x000000 }));
      const g = new THREE.Group();
      g.add(mesh, outline);
      mesh.renderOrder = outline.renderOrder = 300002;
      const base = this.offset.plus(V3.Y_UNIT.times(57));
      const b = this.convertRadial(base);
      g.position.set(b.x, b.y, b.z);
      const dir = new THREE.Vector3(45, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
      const tip = this.convertRadial(base.plus(new V3(dir.x, dir.y, dir.z))).minus(b).normalized();
      let slope = Math.atan2(tip.y, Math.sqrt(tip.x * tip.x + tip.z * tip.z));
      const isTransform = type === PT.MotionType.TRANSFORM;
      if (isTransform && angle < 0) slope = -0.06283186;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), slope));
      // front/back arrows are laid flat so they are readable from the front camera
      if (isTransform) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      g.quaternion.copy(q);
      this.group.add(g);
      return { name, type, group: g, mesh };
    }
    rotation() {
      return new THREE.Matrix4().makeRotationZ(-this.orientation.x).multiply(new THREE.Matrix4().makeRotationX(this.orientation.y));
    }
    ballCenter() {
      const v = new THREE.Vector3(0, 40, 0).applyMatrix4(this.rotation());
      return this.convertRadial(new V3(v.x, v.y, v.z).plus(this.offset));
    }
    base() { return this.convertRadial(this.offset); }
    updateGeometry() {
      const b = this.base(), c = this.ballCenter();
      this.ball.position.set(c.x, c.y, c.z); this.ballGlow.position.set(c.x, c.y, c.z);
      const mid = b.plus(c).times(0.5);
      this.stick.position.set(mid.x, mid.y, mid.z);
      const d = c.minus(b).normalized();
      this.stick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(d.x, d.y, d.z));
    }
    isVisible() {
      const m = this.tab.model;
      if (!(m.hasBothPlates.get() && !this.tab.isAutoMode.get())) return false;
      const mine = (this.isRight ? m.rightPlateType : m.leftPlateType).get();
      const other = (this.isRight ? m.leftPlateType : m.rightPlateType).get();
      return !((mine.isContinental() && other.isOceanic()) || (mine === PT.PlateType.YOUNG_OCEANIC && other === PT.PlateType.OLD_OCEANIC));
    }
    arrowVisible(a) {
      const m = this.tab.model, mt = m.motionType.get(), MT = PT.MotionType;
      if (a.name === 'back') return mt === MT.TRANSFORM && this.isRight === m.isTransformMotionCCW();
      if (a.name === 'front') return (mt == null && m.allowsTransformMotion()) || (mt === MT.TRANSFORM && this.isRight !== m.isTransformMotionCCW());
      if (a.type === MT.DIVERGENT) return (mt == null && m.allowsDivergentMotion()) || mt === MT.DIVERGENT;
      return (mt == null && m.allowsConvergentMotion()) || mt === MT.CONVERGENT;
    }
    sync() {
      const vis = this.isVisible();
      this.group.visible = vis;
      if (!vis) return;
      const mv = this.tab.motionVectorRight;
      this.orientation = this.isRight ? mv : mv.negated();
      this.updateGeometry();
      for (const a of this.arrows) a.group.visible = this.arrowVisible(a);
    }
    hitBall(ray) {
      const c = this.ballCenter();
      const oc = ray.pos.minus(c);
      const b = ray.dir.dot(oc);
      return b * b - (oc.magnitudeSquared() - 64) >= 0;
    }
    hitArrow(ray) {
      const rc = new THREE.Raycaster(new THREE.Vector3(ray.pos.x, ray.pos.y, ray.pos.z), new THREE.Vector3(ray.dir.x, ray.dir.y, ray.dir.z));
      for (const name of ['front', 'left', 'right', 'back']) {
        const a = this.arrows.find((x) => x.name === name);
        if (!a.group.visible) continue;
        a.group.updateMatrixWorld(true);
        if (rc.intersectObject(a.mesh, false).length) return a.type;
      }
      return null;
    }
    // ---- Handle.java logic
    xyHit(ray) { const t = (this.offset.z - ray.pos.z) / ray.dir.z; return ray.pos.plus(ray.dir.times(t)); }
    yzHit(ray) { const t = (this.offset.x - ray.pos.x) / ray.dir.x; return ray.pos.plus(ray.dir.times(t)); }
    getRightMotionType() { return this.isRight ? PT.MotionType.DIVERGENT : PT.MotionType.CONVERGENT; }
    startArrowPress(type) {
      const m = this.tab.model, MT = PT.MotionType;
      if (m.motionType.get() == null) {
        if (type === MT.TRANSFORM) m.setTransformMotionCCW(!this.isRight);
        m.motionType.set(type);
      }
      if (type === MT.TRANSFORM) {
        let v = new PT.V2(0, MAX_ANGLE);
        if (m.isTransformMotionCCW()) v = v.negated();
        this.tab.motionVectorRight = v;
      } else {
        let v = new PT.V2(MAX_ANGLE, 0);
        if ((this.getRightMotionType() === type) !== this.isRight) v = v.negated();
        this.tab.motionVectorRight = v;
      }
    }
    checkInitialMotion(delta) {
      const m = this.tab.model, MT = PT.MotionType;
      if (!(delta.magnitude() > 5)) return false;
      const fx = delta.x, fy = Math.abs(delta.y);
      if (m.allowsTransformMotion() && fy > Math.abs(fx)) {
        m.setTransformMotionCCW(!this.isRight); m.motionType.set(MT.TRANSFORM); return true;
      }
      const leftward = delta.x < 0;
      if (m.allowsDivergentMotion() && leftward !== this.isRight) { m.motionType.set(MT.DIVERGENT); return true; }
      if (!m.allowsConvergentMotion() || leftward !== this.isRight) return false;
      m.motionType.set(MT.CONVERGENT);
      return true;
    }
    dragHandle(ray) {
      const m = this.tab.model;
      if (m.motionType.get() == null && !this.checkInitialMotion(this.xyHit(ray).minus(this.xyHit(this.startRay)))) return;
      if (m.motionType.get() !== PT.MotionType.TRANSFORM) {
        const f = this.horizontalAngle(ray);
        this.tab.motionVectorRight = new PT.V2(this.isRight ? f : -f, 0);
      } else {
        const f = this.verticalAngle(ray);
        this.tab.motionVectorRight = new PT.V2(0, this.isRight ? f : -f);
      }
    }
    horizontalAngle(ray) {
      const base = this.base();
      const a = this.xyHit(ray).minus(base), b = this.xyHit(this.startRay).minus(base);
      let f = Math.sign(a.x - b.x) * Math.min(MAX_ANGLE, Math.acos(PT.clamp(-1, a.normalized().dot(b.normalized()), 1)));
      const mt = this.tab.model.motionType.get();
      if (mt === PT.MotionType.CONVERGENT) f = this.isRight ? Math.min(0, f) : Math.max(0, f);
      else if (mt === PT.MotionType.DIVERGENT) f = this.isRight ? Math.max(0, f) : Math.min(0, f);
      return f;
    }
    verticalAngle(ray) {
      const base = this.base();
      const a = this.yzHit(ray).minus(base), b = this.yzHit(this.startRay).minus(base);
      let f = Math.min(MAX_ANGLE, Math.acos(PT.clamp(-1, a.normalized().dot(b.normalized()), 1)));
      if (a.z < b.z) f = 0;
      return f;
    }
  }

  // ================================================================ プレート運動 tab
  class MotionTab extends BaseTab {
    constructor() {
      super($('motionUI'), 0.5);
      this.isMotion = true;
      this.isAutoMode = new Property(false);
      this.showWater = new Property(false);
      this.speed = new Property(1);
      this.motionVectorRight = new PT.V2(0, 0);
      this.clock = new PT.TectonicsClock(1);
      this.model = new PT.PlateMotionModel(this.clock, { minX: -700000, maxX: 700000, minY: -300000, maxY: 15000, minZ: -1000000, maxZ: 0 });
      this.clock.ticked.add(() => this.model.update(this.clock.getSimulationTimeChange()));
      this.sceneView = new PT.SceneView(this.model, this.mvt, { colorMode: this.colorMode, isWaterVisible: () => this.showWater.get(), texture });
      this.toolSet = new ToolSet(this, $('motionToolbox'));
      this.leftHandle = new HandleCtl(this, false, new V3(-120, 0, -62));
      this.rightHandle = new HandleCtl(this, true, new V3(120, 0, -62));
      this.activeHandle = null; this.draggingHandle = false; this.pressingArrow = false;
      this.dragPieceSide = null; // side highlighted while dragging a crust piece

      buildViewOptions($('motionOptions'), this.colorMode, this.showLabels, this.showWater);
      this.buildPlayMode();
      this.buildTimeControl();
      this.buildCrustChooser();
      const btn = (a) => $('motionReset').querySelector(`[data-action=${a}]`);
      btn('rewind').addEventListener('click', () => { this.model.rewind(); this.clock.pause(); this.clock.resetSimulationTime(); });
      btn('newCrust').addEventListener('click', () => this.newCrust());
      btn('resetAll').addEventListener('click', () => this.resetAll());
      this.btnRewind = btn('rewind'); this.btnNewCrust = btn('newCrust');
      this.motionPanelKey = null;
    }
    viewMatrix() { return PT.PLATE_MOTION_PRE.clone().multiply(super.viewMatrix()); }
    isWaterVisible() { return this.showWater.get(); }

    buildPlayMode() {
      const radios = document.querySelectorAll('input[name=playMode]');
      radios.forEach((r) => r.addEventListener('change', () => this.isAutoMode.set(r.value === 'auto')));
      this.isAutoMode.addObserver((auto) => {
        radios.forEach((r) => (r.checked = (r.value === 'auto') === auto));
        document.querySelectorAll('#timePanel .autoOnly').forEach((el) => show(el, auto));
        this.clock.setTimeMultiplier(auto ? this.speed.get() : 1);
        if (!auto) this.clock.pause();
      });
    }
    buildTimeControl() {
      // TimeSlider: linear HSliderNode from 0.1x to 10x, starting at 1x (near the slow end)
      const s = $('sSpeed');
      s.addEventListener('input', () => this.speed.set(Number(s.value)));
      this.speed.addObserver((v) => {
        s.value = v;
        if (this.isAutoMode && this.isAutoMode.get()) this.clock.setTimeMultiplier(v);
      });
      $('playPause').addEventListener('click', () => { if (this.clock.isPaused()) this.clock.start(); else this.clock.pause(); });
      $('stepBtn').addEventListener('click', () => this.clock.stepClockWhilePaused());
    }
    buildCrustChooser() {
      const el = $('crustChooser');
      this.pieces = [];
      const types = [['CONTINENTAL', STR.continentalCrust], ['YOUNG_OCEANIC', STR.youngOceanicCrust], ['OLD_OCEANIC', STR.oldOceanicCrust]];
      for (const [type, label] of types) {
        const slot = document.createElement('div');
        slot.className = 'crustSlot';
        slot.innerHTML = `<div>${label}</div><div class="pieceArea"></div>`;
        el.appendChild(slot);
        const area = slot.querySelector('.pieceArea');
        for (let i = 0; i < 2; i++) {
          const c = this.makePieceCanvas(type);
          c.classList.add('crustPiece');
          c.style.top = (100 - parseFloat(c.style.height)) / 2 + 'px';
          area.appendChild(c);
          const piece = { type, el: c, placed: false };
          c.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.startPieceDrag(piece, e); });
          this.pieces.push(piece);
        }
      }
    }
    makePieceCanvas(type) {
      const c = document.createElement('canvas');
      const size = PT.Tools ? PT.Tools.crustPieceSize(type) : { width: 140, height: type === 'CONTINENTAL' ? 100 : 35 };
      c.width = (size.width + 2) * 2; c.height = (size.height + 2) * 2;
      c.style.width = size.width + 2 + 'px'; c.style.height = size.height + 2 + 'px';
      const g = c.getContext('2d');
      g.scale(2, 2); g.translate(1, 1);
      if (PT.Tools) PT.Tools.drawCrustPiece(g, type); else { g.fillStyle = '#aaa'; g.fillRect(0, 0, size.width, size.height); }
      return c;
    }
    startPieceDrag(piece, e) {
      const chooser = $('crustChooser');
      const r = piece.el.getBoundingClientRect();
      const grabX = (e.clientX - r.left) / stageScale, grabY = (e.clientY - r.top) / stageScale;
      const ghost = this.makePieceCanvas(piece.type);
      ghost.classList.add('dragPiece');
      stage.appendChild(ghost);
      piece.el.style.visibility = 'hidden';
      const place = (ev) => {
        const p = localXY(ev);
        ghost.style.left = (p.x - stageOX) / stageScale - grabX + 'px';
        ghost.style.top = (p.y - stageOY) / stageScale - grabY + 'px';
        this.dragPieceSide = isOver(chooser, ev) ? null : (this.rig.onPlaneZ(p.x, p.y).x < 0 ? Side.LEFT : Side.RIGHT);
      };
      place(e);
      drag = {
        move: place,
        up: (ev) => {
          ghost.remove();
          piece.el.style.visibility = '';
          const side = this.dragPieceSide;
          this.dragPieceSide = null;
          if (side && !this.model.hasPlate(side)) {
            this.model.dropCrust(side, PT.PlateType[piece.type]);
            piece.placed = true;
            piece.el.classList.add('hidden');
          }
        }
      };
    }
    restorePieces() { for (const p of this.pieces) { p.placed = false; p.el.classList.remove('hidden'); } }
    newCrust() {
      this.model.newCrust();
      this.clock.pause();
      this.clock.resetSimulationTime();
      this.model.resetAll();
      this.clock.setTimeMultiplier(this.isAutoMode.get() ? this.speed.get() : 1);
      this.restorePieces();
    }
    resetAll() {
      this.model.resetAll();
      this.colorMode.reset();
      this.toolSet.resetAll();
      this.showLabels.reset();
      this.showWater.reset();
      this.isAutoMode.reset();
      this.clock.pause();
      this.clock.resetTimeLimit();
      this.clock.resetSimulationTime();
      this.speed.reset();
      this.clock.setTimeMultiplier(1);
      this.restorePieces();
    }

    // MotionTypeChooserPanel (automatic mode, both plates present)
    updateMotionTypePanel() {
      const m = this.model, el = $('motionTypePanel'), MT = PT.MotionType;
      const want = m.hasBothPlates.get() && this.isAutoMode.get();
      const key = want ? [m.allowsConvergentMotion(), m.allowsDivergentMotion(), m.allowsTransformMotion()].join() : null;
      if (key !== this.motionPanelKey) {
        this.motionPanelKey = key;
        el.innerHTML = '';
        if (want) {
          const choices = [];
          if (m.allowsConvergentMotion()) choices.push([MT.CONVERGENT, STR.convergent]);
          if (m.allowsDivergentMotion()) choices.push([MT.DIVERGENT, STR.divergent]);
          if (m.allowsTransformMotion()) choices.push([MT.TRANSFORM, STR.transform]);
          for (const [type, label] of choices) {
            const d = document.createElement('div');
            d.className = 'motionChoice';
            d.appendChild(motionIcon(type));
            d.insertAdjacentHTML('beforeend', `<label><input type="radio" name="motionType"> ${label}</label>`);
            const input = d.querySelector('input');
            input.addEventListener('change', () => m.motionTypeIfStarted.set(type));
            d.dataset.type = type.name;
            el.appendChild(d);
          }
        }
      }
      show(el, want);
      if (!want) return;
      const selected = m.animationStarted.get() && m.motionType.get() ? m.motionType.get() : m.motionTypeIfStarted.get();
      el.querySelectorAll('.motionChoice').forEach((d) => {
        const input = d.querySelector('input');
        input.checked = selected && d.dataset.type === selected.name;
        input.disabled = m.animationStarted.get();
        d.querySelector('label').classList.toggle('disabled', input.disabled);
      });
    }

    // The original pins the time control's left edge at stageWidth - (width of the auto-mode
    // control) - 10, so the narrower manual-mode readout sits where the full control would start.
    placeTimePanel() {
      const panel = $('timePanel');
      if (!panel.offsetWidth) return;
      const autos = [...panel.querySelectorAll('.autoOnly')], wasShown = autos.map((el) => !el.classList.contains('hidden'));
      autos.forEach((el) => show(el, true));
      this.autoTimeWidth = panel.offsetWidth;
      autos.forEach((el, i) => show(el, wasShown[i]));
      panel.style.right = 'auto';
      panel.style.left = (PT.STAGE_W - this.autoTimeWidth - 10) + 'px';
    }

    updateGui() {
      const m = this.model;
      const both = m.hasBothPlates.get();
      show($('timePanel'), both);
      if (both && this.autoTimeWidth == null) this.placeTimePanel();
      visible($('crustChooser'), !both);
      $('timeValue').textContent = Math.round(this.clock.getSimulationTime());
      const atLimit = this.clock.getSimulationTime() >= this.clock.getTimeLimit();
      const pp = $('playPause');
      pp.disabled = atLimit;
      pp.textContent = this.clock.isRunning() && !atLimit ? '❚❚' : '▶';
      $('stepBtn').disabled = !(this.clock.isPaused() && !atLimit);
      this.btnRewind.disabled = !m.animationStarted.get();
      this.btnNewCrust.disabled = !m.hasAnyPlates.get();
      const water = $('motionOptions').querySelector('.waterLabel');
      if (water) { water.classList.toggle('disabled', !both); water.querySelector('input').disabled = !both; }
      this.updateMotionTypePanel();
    }

    update(dt) {
      // TectonicsTab.loop: the clock only advances by itself in automatic mode
      if (this.draggingHandle && this.lastPointer) this.activeHandle.dragHandle(this.rig.ray(this.lastPointer.x, this.lastPointer.y));
      const mt = this.model.motionType.get();
      if ((this.draggingHandle || this.pressingArrow) && mt) {
        const c = mt === PT.MotionType.TRANSFORM ? this.motionVectorRight.y : this.motionVectorRight.x;
        if (c !== 0) this.clock.stepByWallSecondsForced(dt * c * c * 2.5);
      }
      if (this.isAutoMode.get()) this.clock.stepByWallSeconds(dt);
      this.leftHandle.sync(); this.rightHandle.sync();
      this.updateGui();
    }

    onPointerDown(e, p) {
      if (this.isAutoMode.get()) return;
      const ray = this.rig.ray(p.x, p.y);
      for (const h of [this.leftHandle, this.rightHandle]) {
        if (!h.isVisible()) continue;
        if (h.hitBall(ray)) {
          this.draggingHandle = true; this.activeHandle = h; h.startRay = ray; this.lastPointer = p;
          break;
        }
        const type = h.hitArrow(ray);
        if (type) { this.pressingArrow = true; this.activeHandle = h; h.startArrowPress(type); break; }
      }
      if (this.draggingHandle || this.pressingArrow) {
        drag = {
          move: (ev) => { this.lastPointer = localXY(ev); },
          up: () => {
            this.draggingHandle = false; this.pressingArrow = false; this.activeHandle = null;
            this.motionVectorRight = new PT.V2(0, 0);
          }
        };
      }
    }
    onHover(e) {
      const p = localXY(e);
      let cursor = '';
      if (current.toolSet.hit(p)) cursor = 'grab';
      else if (!this.isAutoMode.get() && this.model.hasBothPlates.get()) {
        const ray = this.rig.ray(p.x, p.y);
        for (const h of [this.leftHandle, this.rightHandle]) if (h.isVisible() && (h.hitBall(ray) || h.hitArrow(ray))) cursor = 'pointer';
      }
      overlay.style.cursor = cursor;
    }

    drawOverlay(ctx) {
      const m = this.model;
      const yellow = [1, 1, 0.5, 0.3], gray = [0.5, 0.5, 0.5, 0.3];
      if (m.leftPlateType.get() == null) PT.drawBoxHighlight(ctx, this.rig, this.mvt, m.getLeftDropAreaBounds(), this.dragPieceSide === Side.LEFT ? yellow : gray);
      if (m.rightPlateType.get() == null) PT.drawBoxHighlight(ctx, this.rig, this.mvt, m.getRightDropAreaBounds(), this.dragPieceSide === Side.RIGHT ? yellow : gray);
      if (!this.showLabels.get()) return;
      const color = PT.labelColor(this.colorMode, true);
      for (const bl of m.boundaryLabels) PT.drawBoundaryLabel(ctx, this.rig, this.mvt, bl.boundary.samples, bl.minX.get(), bl.maxX.get(), color);
      for (const rl of m.rangeLabels) PT.drawRangeLabel(ctx, this.rig, this.radial(rl.top.get()), this.radial(rl.bottom.get()), rl.label, 1, color);
      for (const tl of m.textLabels) PT.drawTextLabel(ctx, this.rig, this.radial(tl.centerPosition.get()), tl.label, 1, color);
    }
  }

  // small arrow icons for the motion type chooser (MotionTypeChooserPanel.IconArrow)
  function motionIcon(type) {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 100; c.style.width = '100px'; c.style.height = '50px';
    const g = c.getContext('2d');
    g.scale(2, 2);
    const col = `rgba(${type.color[0] * 255},${type.color[1] * 255},${type.color[2] * 255},${type.color[3]})`;
    const arrow = (x1, y1, x2, y2, tail = 8) => {
      const a = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1), hl = 14, hw = 14;
      g.save(); g.translate(x1, y1); g.rotate(a);
      g.beginPath();
      g.moveTo(0, -tail / 2); g.lineTo(len - hl, -tail / 2); g.lineTo(len - hl, -hw / 2); g.lineTo(len, 0);
      g.lineTo(len - hl, hw / 2); g.lineTo(len - hl, tail / 2); g.lineTo(0, tail / 2); g.closePath();
      g.fillStyle = col; g.fill(); g.strokeStyle = 'black'; g.lineWidth = 1; g.stroke();
      g.restore();
    };
    if (type === PT.MotionType.CONVERGENT) { arrow(2, 25, 45, 25); arrow(98, 25, 55, 25); }
    else if (type === PT.MotionType.DIVERGENT) { arrow(45, 25, 2, 25); arrow(55, 25, 98, 25); }
    else {
      g.transform(1, 0, -0.6, 1, 15, 0); // skewed like the original IconArrow transform
      arrow(50, 20, 50, 2, 8); arrow(50, 30, 50, 48, 8);
    }
    return c;
  }

  // ================================================================ tabs + loop
  const tabs = { crust: new CrustTab(), motion: new MotionTab() };
  let current = tabs.crust;
  document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
    current = tabs[b.dataset.tab];
    show($('crustUI'), current === tabs.crust);
    show($('motionUI'), current === tabs.motion);
    overlay.style.cursor = '';
  }));

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    current.frame(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.PT_APP = { tabs, get current() { return current; } };
})();
