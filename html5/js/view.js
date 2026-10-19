// 3D rendering (three.js) + 2D overlay helpers.
// Mirrors the original LWJGL views: CrossSectionStripNode, TerrainNode, WaterStripNode, SmokeNode,
// labels (RangeLabelNode / BoundaryLabelNode / TextLabelNode) and BoxHighlightNode.
(function () {
  'use strict';
  const PT = window.PT;
  const { V3, clamp, PlateTectonicsModel, ZERO_CELSIUS } = PT;
  const toRadial = PlateTectonicsModel.convertToRadial;

  // ---------------------------------------------------------------- color modes (view/materials/*)
  function densityMap(d) {
    let g;
    const r = (d - 2500) / 1000;
    if (d <= 3300) {
      g = 100 + (1 - r) * 155;
    } else {
      const a = 100 + (1 - (3300 - 2500) / 1000) * 155;
      g = a + (50 - a) * ((d - 3300) / (13100 - 3300));
    }
    return clamp(0, g / 220, 1);
  }
  function temperatureMap(t) {
    let r = (t - ZERO_CELSIUS) / (6100 + 300);
    r = Math.pow(Math.max(0, r), 0.4);
    return clamp(0.08, r, 0.95);
  }
  const ColorMode = {
    DENSITY: {
      name: 'DENSITY', minKey: 'lessDense', maxKey: 'moreDense', min: [255, 255, 255], max: [0, 0, 0],
      color(d, t, out) { const g = densityMap(d); out[0] = g; out[1] = g; out[2] = g; }
    },
    TEMPERATURE: {
      name: 'TEMPERATURE', minKey: 'cool', maxKey: 'warm', min: [64, 64, 64], max: [255, 64, 64],
      color(d, t, out) { const v = temperatureMap(t); out[0] = 0.25 + 0.75 * v; out[1] = 0.25; out[2] = 0.25; }
    },
    COMBINED: {
      name: 'COMBINED', minKey: null, maxKey: null,
      color(d, t, out) {
        const v = temperatureMap(t);
        const k = densityMap(d) / 2 + 0.5;
        const red = k * v, base = k - red;
        out[0] = red + base; out[1] = base; out[2] = base;
      }
    }
  };

  // ---------------------------------------------------------------- noise texture (EarthTexture)
  function makeNoiseTexture(onReady) {
    const img = new Image();
    const tex = new THREE.Texture();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height);
      const p = data.data;
      for (let i = 0; i < p.length; i += 4) {
        p[i] = (p[i] & 0x7f) | 0x80; p[i + 1] = (p[i + 1] & 0x7f) | 0x80; p[i + 2] = (p[i + 2] & 0x7f) | 0x80; p[i + 3] = 255;
      }
      g.putImageData(data, 0, 0);
      tex.image = c;
      tex.needsUpdate = true;
      if (onReady) onReady();
    };
    img.src = window.PT_NOISE_PNG;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  // ---------------------------------------------------------------- dynamic buffer geometry helper
  function dynGeometry(capacity, colorSize) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    if (colorSize) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * colorSize), colorSize).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
    g.userData.capacity = capacity;
    return g;
  }
  function markDirty(g) {
    for (const k in g.attributes) g.attributes[k].needsUpdate = true;
    g.computeBoundingSphere();
  }

  // ---------------------------------------------------------------- SceneView
  const EARTH_GREEN = [0x52 / 255, 0x6f / 255, 0x35 / 255];

  class SceneView {
    constructor(model, mvt, opts) {
      this.model = model;
      this.mvt = mvt; // PT.ModelViewTransform
      this.colorMode = opts.colorMode; // Property of ColorMode
      this.isWaterVisible = opts.isWaterVisible; // () => bool
      this.texture = opts.texture;
      this.scene = new THREE.Scene();
      // PlateTectonicsTab.loadLighting: sun (1,3,2) and moon (-2,1,-1) in world space, no specular,
      // plus OpenGL's default global ambient 0.2 times the default material ambient 0.2.
      const sun = new THREE.DirectionalLight(0xffffff, 1.0);
      sun.position.set(1, 3, 2);
      const moon = new THREE.DirectionalLight(0xffffff, 1.0);
      moon.position.set(-2, 1, -1);
      this.scene.add(sun, moon);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.04));
      this.stripMeshes = new Map();
      this.terrainMeshes = new Map();
      this.smokeMeshes = new Map();
      this.extra = new THREE.Group(); // handles etc.
      this.scene.add(this.extra);
      this.smokeGeometry = SceneView.makeSmokeGeometry();
    }

    // -------- strips
    stripMesh(strip) {
      let m = this.stripMeshes.get(strip);
      const need = Math.max(10, strip.getNumberOfVertices());
      if (!m || m.geometry.userData.capacity < need) {
        if (m) { this.scene.remove(m); m.geometry.dispose(); }
        const cap = need + 64;
        const g = dynGeometry(cap, 4);
        const idx = new Uint32Array((cap / 2) * 6);
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, map: this.texture, transparent: true, side: THREE.DoubleSide });
        m = new THREE.Mesh(g, mat);
        m.frustumCulled = false;
        this.stripMeshes.set(strip, m);
        this.scene.add(m);
      }
      return m;
    }
    updateStrip(strip, order) {
      const m = this.stripMesh(strip);
      const g = m.geometry;
      const pos = g.attributes.position.array, col = g.attributes.color.array, uv = g.attributes.uv.array;
      const idx = g.index.array;
      const mode = this.colorMode.get();
      const alpha = strip.alpha.get();
      const c = [0, 0, 0];
      const n = strip.topPoints.length;
      let v = 0;
      const put = (s) => {
        const p = this.mvt.transformPosition(toRadial(s.position));
        pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
        mode.color(s.density, s.temperature, c);
        col[v * 4] = c[0]; col[v * 4 + 1] = c[1]; col[v * 4 + 2] = c[2]; col[v * 4 + 3] = alpha;
        uv[v * 2] = s.textureCoordinates.x; uv[v * 2 + 1] = s.textureCoordinates.y;
        v++;
      };
      for (let i = 0; i < n; i++) { put(strip.topPoints[i]); put(strip.bottomPoints[i]); }
      let k = 0;
      for (let i = 0; i < n - 1; i++) {
        const a = i * 2;
        idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + 2;
        idx[k++] = a + 1; idx[k++] = a + 3; idx[k++] = a + 2;
      }
      g.index.needsUpdate = true;
      g.setDrawRange(0, k);
      markDirty(g);
      m.material.depthTest = !strip.alwaysOnTop;
      m.visible = alpha > 0.001;
      m.renderOrder = order;
    }

    // -------- terrain (+ water)
    terrainEntry(t) {
      let e = this.terrainMeshes.get(t);
      const need = Math.max(10, t.getNumberOfVertices());
      if (!e || e.capacity < need) {
        if (e) { this.scene.remove(e.group); e.mesh.geometry.dispose(); if (e.water) e.water.geometry.dispose(); }
        const cap = need + t.getNumRows() * 16;
        const geo = dynGeometry(cap, 3);
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(cap * 6), 1));
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, map: this.texture, side: THREE.DoubleSide }));
        mesh.frustumCulled = false;
        const group = new THREE.Group();
        group.add(mesh);
        e = { capacity: cap, mesh, group };
        if (t.hasWater()) {
          const wg = dynGeometry(cap, 0);
          wg.setIndex(new THREE.BufferAttribute(new Uint32Array(cap * 6), 1));
          e.water = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.5, 0.8), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
          e.water.frustumCulled = false;
          e.water.renderOrder = 100000;
          const fg = dynGeometry(t.getNumColumns() * 4 + 64, 0);
          e.waterFront = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.3, 0.7), transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
          e.waterFront.frustumCulled = false;
          e.waterFront.renderOrder = 100001;
          group.add(e.water); group.add(e.waterFront);
        }
        this.terrainMeshes.set(t, e);
        this.scene.add(group);
      }
      return e;
    }
    gridPositions(t, elevationFn, pos) {
      const nc = t.getNumColumns(), nr = t.getNumRows();
      const xr = t.xPositions.map((x) => PlateTectonicsModel.getXRadialVector(x));
      for (let r = 0; r < nr; r++) {
        const zr = PlateTectonicsModel.getZRadialVector(t.zPositions[r]);
        for (let i = 0; i < nc; i++) {
          const p = this.mvt.transformPosition(PlateTectonicsModel.convertToRadial3(xr[i], zr, elevationFn(i, r)));
          const o = (r * nc + i) * 3;
          pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
        }
      }
    }
    gridIndex(nc, nr, idx) {
      let k = 0;
      for (let r = 0; r < nr - 1; r++) {
        for (let i = 0; i < nc - 1; i++) {
          const a = r * nc + i, b = a + 1, c = a + nc, d = c + 1;
          idx[k++] = a; idx[k++] = c; idx[k++] = b;
          idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
      }
      return k;
    }
    updateTerrain(t, order, showWater) {
      const e = this.terrainEntry(t);
      const nc = t.getNumColumns(), nr = t.getNumRows();
      const g = e.mesh.geometry;
      const pos = g.attributes.position.array, col = g.attributes.color.array, uv = g.attributes.uv.array;
      this.gridPositions(t, (i, r) => t.getSample(i, r).getElevation(), pos);
      const [gr, gg, gb] = EARTH_GREEN;
      for (let r = 0; r < nr; r++) {
        for (let i = 0; i < nc; i++) {
          const s = t.getSample(i, r);
          const el = s.getElevation();
          const o = (r * nc + i) * 3;
          let R, G, B;
          if (el < 1000) {
            const f = clamp(0, (el + 7000) / 10000, 1);
            if (el < -500) { R = G = B = f; } else {
              const w = clamp(0, -(el - 1000) / 1500, 1);
              R = f * w + gr * (1 - w); G = f * w + gg * (1 - w); B = f * w + gb * (1 - w);
            }
          } else if (el < 3000) { R = gr; G = gg; B = gb; } else {
            const f = Math.min(1, (el - 3000) / 7000);
            R = gr + (0.8 - gr) * f; G = gg + (0.8 - gg) * f; B = gb + (0.8 - gb) * f;
          }
          col[o] = R; col[o + 1] = G; col[o + 2] = B;
          const tc = s.getTextureCoordinates();
          uv[(r * nc + i) * 2] = tc.x; uv[(r * nc + i) * 2 + 1] = tc.y;
        }
      }
      const k = this.gridIndex(nc, nr, g.index.array);
      g.index.needsUpdate = true;
      g.setDrawRange(0, k);
      markDirty(g);
      g.computeVertexNormals();
      e.mesh.renderOrder = order;

      if (e.water) {
        const visible = showWater && t.isWaterValid.get();
        e.water.visible = e.waterFront.visible = visible;
        if (visible) {
          const wg = e.water.geometry;
          this.gridPositions(t, () => 0, wg.attributes.position.array);
          const wk = this.gridIndex(nc, nr, wg.index.array);
          wg.index.needsUpdate = true; wg.setDrawRange(0, wk); markDirty(wg);
          this.updateWaterFront(t, e);
        }
      }
    }
    // WaterFrontMesh: triangle strip between sea level and the front terrain edge where it is under water
    updateWaterFront(t, e) {
      let fg = e.waterFront.geometry;
      const need = t.getNumColumns() * 4 + 8;
      if (fg.userData.capacity < need) { fg.dispose(); fg = e.waterFront.geometry = dynGeometry(need + 64, 0); }
      const pos = fg.attributes.position.array;
      const front = t.getFrontZIndex();
      const z = t.zPositions[front];
      const pts = []; // pairs [top(sea), bottom(terrain)]
      let wasAbove = t.getSample(0, front).getElevation() >= 0;
      let px = 0, pe = 0;
      const P = (x, y) => this.mvt.transformPosition(toRadial(new V3(x, y, z)));
      for (let i = 0; i < t.getNumColumns(); i++) {
        const x = t.xPositions[i];
        const el = t.getSample(i, front).getElevation();
        if (el >= 0) {
          if (!wasAbove) { const cx = px - pe * (x - px) / (el - pe); const p = P(cx, 0); pts.push(p, p); }
        } else {
          if (wasAbove && i > 0) { const cx = px - pe * (x - px) / (el - pe); const p = P(cx, 0); pts.push(p, p); }
          pts.push(P(x, 0), P(x, el));
        }
        px = x; pe = el; wasAbove = el >= 0;
      }
      // convert the strip into triangles (non-indexed)
      let v = 0;
      const put = (p) => { pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z; v++; };
      for (let i = 0; i + 3 < pts.length; i += 2) {
        put(pts[i]); put(pts[i + 1]); put(pts[i + 2]);
        put(pts[i + 1]); put(pts[i + 3]); put(pts[i + 2]);
        if (v + 6 > fg.userData.capacity) break;
      }
      fg.setDrawRange(0, v);
      markDirty(fg);
    }

    // -------- smoke (volcano puffs)
    static makeSmokeGeometry() {
      const shape = new THREE.Shape();
      const N = 80;
      for (let i = 0; i < N; i++) {
        const a = (Math.PI * 2 * i) / (N - 1);
        const f = 1 + Math.cos(20 * a) / 20;
        const d = Math.max(0, Math.cos(a));
        const x = f * Math.cos(a) + d - 2, y = Math.sin(a) * (f - d * d);
        // original vertex = (y, -x)
        if (i === 0) shape.moveTo(y, -x); else shape.lineTo(y, -x);
      }
      return new THREE.ShapeGeometry(shape);
    }
    updateSmoke() {
      const puffs = this.model.smokePuffs;
      const alive = new Set();
      if (puffs) {
        for (const p of puffs) {
          alive.add(p);
          let m = this.smokeMeshes.get(p);
          if (!m) {
            m = new THREE.Mesh(this.smokeGeometry, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
            m.renderOrder = 200000;
            this.smokeMeshes.set(p, m);
            this.scene.add(m);
          }
          const v = this.mvt.transformPosition(toRadial(p.position.get()));
          m.position.set(v.x, v.y, v.z);
          m.scale.setScalar(p.scale.get());
          m.material.opacity = clamp(0, p.alpha.get(), 1);
        }
      }
      for (const [p, m] of this.smokeMeshes) {
        if (!alive.has(p)) { this.scene.remove(m); m.material.dispose(); this.smokeMeshes.delete(p); }
      }
    }

    // sync the whole scene with the model; call once per frame before rendering
    sync() {
      const showWater = this.isWaterVisible();
      const terrains = new Set(this.model.terrains);
      let order = 0;
      for (const t of this.model.terrains) this.updateTerrain(t, order++, showWater);
      for (const [t, e] of this.terrainMeshes) {
        if (!terrains.has(t)) { this.scene.remove(e.group); e.mesh.geometry.dispose(); this.terrainMeshes.delete(t); }
      }
      const strips = new Set(this.model.renderOrder);
      order = 1000;
      for (const s of this.model.renderOrder) this.updateStrip(s, order++);
      for (const [s, m] of this.stripMeshes) {
        if (!strips.has(s)) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); this.stripMeshes.delete(s); }
      }
      this.updateSmoke();
    }
  }

  // ---------------------------------------------------------------- camera (PlateTectonicsTab.getScene*Matrix)
  const rowMajor = (...a) => new THREE.Matrix4().set(...a);
  function gluPerspective(halfFovY, aspect, near, far) {
    const f = Math.cos(halfFovY) / Math.sin(halfFovY);
    return rowMajor(f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), (2 * far * near) / (near - far), 0, 0, -1, 0);
  }
  const STAGE_W = 1008, STAGE_H = 676;
  function fieldOfViewYFactor(w, h) {
    const sx = w / STAGE_W, sy = h / STAGE_H;
    if (sx === 0 || sy === 0) return 1;
    return sy > sx ? sy / sx : 1;
  }
  function projectionMatrix(w, h) {
    const half = Math.atan(fieldOfViewYFactor(w, h) * Math.tan(0.34906584));
    return gluPerspective(half, w / h, 1, 21000);
  }
  // effectiveZoom = (1 - zoomRatio)^2 ; scaleY = transformDeltaY(earth radius / 2)
  function baseViewMatrix(zoomRatio, mvtScale) {
    const z = Math.pow(1 - zoomRatio, 2);
    const tilt = 13 + z * (0 - 13);
    const f4 = 3185500 * mvtScale;
    return new THREE.Matrix4().makeRotationX((tilt / 180) * Math.PI)
      .multiply(new THREE.Matrix4().makeTranslation(0, -80 + z * z * (f4 + 80), -400 + z * (-18000 + 400)));
  }
  function sceneDistanceZoomFactor(zoomRatio) { return 1 + Math.pow(1 - zoomRatio, 2) * 34; }
  const PLATE_MOTION_PRE = rowMajor(0.99994993, -3.9991664e-4, -0.009994832, 0, 1.9998333e-4, 0.9998, -0.019996665, 0, 0.010000832, 0.01999366, 0.99975, 0, 0, 0, 0, 1)
    .multiply(rowMajor(0.99955106, -5.982099e-4, 0.029960573, 0, -2.248562e-6, 0.9997994, 0.02003758, 0, -0.029966524, -0.020028654, 0.99935055, 0, 0, 0, 0, 1))
    .multiply(rowMajor(1, 0, 0, 12, 0, 1, 0, 0, 0, 0, 1, 78, 0, 0, 0, 1))
    .multiply(rowMajor(0.9939557, 7.9941313e-4, -0.109775305, -58.643387, -0.0018950196, 0.9999494, -0.0098764775, 0.11180614, 0.109761804, 0.010024817, 0.9939069, -6.4759464, 0, 0, 0, 1));

  class CameraRig {
    constructor() {
      this.camera = new THREE.PerspectiveCamera();
      this.camera.matrixAutoUpdate = false;
      this.view = new THREE.Matrix4();
      this.proj = new THREE.Matrix4();
      this.viewProj = new THREE.Matrix4();
      this.invViewProj = new THREE.Matrix4();
      this.w = 1; this.h = 1;
    }
    set(view, w, h) {
      this.w = w; this.h = h;
      this.view.copy(view);
      this.proj.copy(projectionMatrix(w, h));
      const cam = this.camera;
      cam.projectionMatrix.copy(this.proj);
      cam.projectionMatrixInverse.copy(this.proj).invert();
      cam.matrix.copy(view).invert();
      cam.matrixWorld.copy(cam.matrix);
      cam.matrixWorldInverse.copy(view);
      this.viewProj.multiplyMatrices(this.proj, this.view);
      this.invViewProj.copy(this.viewProj).invert();
    }
    // world (view-unit) point -> CSS px
    project(v) {
      const p = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(this.viewProj);
      return { x: (p.x / p.w * 0.5 + 0.5) * this.w, y: (1 - (p.y / p.w * 0.5 + 0.5)) * this.h, w: p.w };
    }
    // CSS px -> ray {pos, dir} (PT.V3)
    ray(sx, sy) {
      const nx = (sx / this.w) * 2 - 1, ny = 1 - (sy / this.h) * 2;
      const a = new THREE.Vector4(nx, ny, -1, 1).applyMatrix4(this.invViewProj);
      const b = new THREE.Vector4(nx, ny, 1, 1).applyMatrix4(this.invViewProj);
      const pa = new V3(a.x / a.w, a.y / a.w, a.z / a.w), pb = new V3(b.x / b.w, b.y / b.w, b.z / b.w);
      return { pos: pa, dir: pb.minus(pa).normalized() };
    }
    cameraPosition() { const m = this.camera.matrixWorld.elements; return new V3(m[12], m[13], m[14]); }
    // intersection of the screen ray with the plane z = z0 (default: front plane z=0)
    onPlaneZ(sx, sy, z0 = 0) {
      const r = this.ray(sx, sy);
      const t = (z0 - r.pos.z) / r.dir.z;
      return r.pos.plus(r.dir.times(t));
    }
    // screen px per world unit at point v (horizontal)
    pxPerUnit(v) {
      const a = this.project(v), b = this.project(new V3(v.x + 1, v.y, v.z));
      return Math.hypot(b.x - a.x, b.y - a.y);
    }
  }

  // ---------------------------------------------------------------- overlay helpers (labels etc.)
  const FONT = '"Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';
  const DARK_LABEL = 'rgb(0,0,0)', LIGHT_LABEL = 'rgb(230,230,230)';
  function labelColor(colorMode, dark) {
    const m = colorMode.get();
    const hasDark = dark === (m === ColorMode.DENSITY || m === ColorMode.COMBINED);
    return hasDark ? DARK_LABEL : LIGHT_LABEL;
  }

  // RangeLabelNode: top/bottom/labelLocation in world (view-unit) coordinates; scale = label scale property
  function drawRangeLabel(ctx, rig, top, bottom, text, scale, color, labelLocation) {
    const loc = labelLocation || top.plus(bottom).times(0.5);
    const dir = bottom.minus(top).normalized();
    const perp = dir.cross(V3.Z_UNIT).normalized();
    const cap = perp.times((scale * 7) / 2);
    const textWorldH = 18 * 3 * 0.15 * scale; // PText(18) scaled 3 then 0.15*scale
    const pxu = rig.pxPerUnit(loc);
    const fontPx = textWorldH * pxu;
    ctx.font = `bold ${fontPx}px ${FONT}`;
    const textW = ctx.measureText(text).width / pxu; // in world units
    const halfGap = (textWorldH / 2) * 1.3 * 0.9; // ~ f in the original
    const g1 = loc.minus(dir.times(halfGap)), g2 = loc.plus(dir.times(halfGap));
    const fits = g1.minus(top).dot(dir) >= 0;
    const P = (v) => rig.project(v);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (fits) {
      const lines = [[top.plus(cap), top.minus(cap)], [bottom.plus(cap), bottom.minus(cap)], [top, g1], [g2, bottom]];
      for (const [a, b] of lines) { const pa = P(a), pb = P(b); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
      ctx.stroke();
      const pl = P(loc);
      const pt = P(top), pb = P(bottom);
      let ang = Math.atan2(pb.y - pt.y, pb.x - pt.x) - Math.PI / 2; // align text with the range direction
      if (Math.abs(ang) < 0.02) ang = 0;
      ctx.save(); ctx.translate(pl.x, pl.y); ctx.rotate(ang);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    } else {
      const a = P(loc), b = P(loc.plus(new V3(10, 10, 0).times(scale))), c = P(loc.plus(new V3(30, 10, 0).times(scale)));
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, c.x + 4, c.y);
    }
    return textW;
  }

  function drawTextLabel(ctx, rig, pos, text, scale, color) {
    const pxu = rig.pxPerUnit(pos);
    const p = rig.project(pos);
    ctx.font = `bold ${18 * 3 * 0.15 * scale * pxu}px ${FONT}`;
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x, p.y);
  }

  // dashed polyline through model samples (planar model coords), clipped to [minX, maxX]
  function drawBoundaryLabel(ctx, rig, mvt, samples, minX, maxX, color) {
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prev = null, started = false;
    const pt = (v) => {
      const p = rig.project(mvt.transformPosition(toRadial(v)));
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    };
    for (const s of samples) {
      const v = s.position;
      if (!(v.x < minX)) {
        if (v.x > maxX) {
          if (prev) { const r = (maxX - prev.x) / (v.x - prev.x); pt(v.times(r).plus(prev.times(1 - r))); }
        } else {
          if (prev && prev.x < minX) { const r = (minX - prev.x) / (v.x - prev.x); pt(v.times(r).plus(prev.times(1 - r))); }
          pt(v);
        }
      }
      prev = v;
    }
    ctx.stroke();
    ctx.restore();
  }

  // BoxHighlightNode: translucent top face + black outline of a model-space box (planar coordinates)
  function drawBoxHighlight(ctx, rig, mvt, b, rgba) {
    const P = (x, y, z) => rig.project(mvt.transformPosition(toRadial(new V3(x, y, z))));
    const line = (a, c, n) => {
      const out = [];
      for (let i = 0; i < n; i++) { const r = i / (n - 1); out.push(P(a[0] + (c[0] - a[0]) * r, a[1] + (c[1] - a[1]) * r, a[2] + (c[2] - a[2]) * r)); }
      return out;
    };
    const N = 20;
    // top face (y = maxY) and front face (z = maxZ)
    const faces = [
      line([b.minX, b.maxY, b.maxZ], [b.maxX, b.maxY, b.maxZ], N).concat(line([b.maxX, b.maxY, b.minZ], [b.minX, b.maxY, b.minZ], N)),
      line([b.minX, b.maxY, b.maxZ], [b.maxX, b.maxY, b.maxZ], N).concat(line([b.maxX, b.minY, b.maxZ], [b.minX, b.minY, b.maxZ], N))
    ];
    ctx.save();
    ctx.fillStyle = `rgba(${rgba[0] * 255},${rgba[1] * 255},${rgba[2] * 255},${rgba[3]})`;
    for (const f of faces) {
      ctx.beginPath(); f.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
    }
    // BoxHighlightNode: all 12 edges in black with glLineStipple(1, 0xFF00) = 8px on / 8px off
    ctx.strokeStyle = 'black'; ctx.lineWidth = 1; ctx.setLineDash([8, 8]);
    const edges = [
      [[b.minX, b.minY, b.minZ], [b.minX, b.maxY, b.minZ], 2], [[b.minX, b.maxY, b.minZ], [b.maxX, b.maxY, b.minZ], N],
      [[b.maxX, b.maxY, b.minZ], [b.maxX, b.minY, b.minZ], 2], [[b.maxX, b.minY, b.minZ], [b.minX, b.minY, b.minZ], N],
      [[b.minX, b.minY, b.maxZ], [b.minX, b.maxY, b.maxZ], 2], [[b.minX, b.maxY, b.maxZ], [b.maxX, b.maxY, b.maxZ], N],
      [[b.maxX, b.maxY, b.maxZ], [b.maxX, b.minY, b.maxZ], 2], [[b.maxX, b.minY, b.maxZ], [b.minX, b.minY, b.maxZ], N],
      [[b.minX, b.minY, b.minZ], [b.minX, b.minY, b.maxZ], 10], [[b.minX, b.maxY, b.minZ], [b.minX, b.maxY, b.maxZ], 10],
      [[b.maxX, b.minY, b.minZ], [b.maxX, b.minY, b.maxZ], 10], [[b.maxX, b.maxY, b.minZ], [b.maxX, b.maxY, b.maxZ], 10]
    ];
    for (const [a, c, n] of edges) {
      const pts = line(a, c, n);
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    }
    ctx.restore();
  }

  Object.assign(PT, {
    ColorMode, densityMap, temperatureMap, makeNoiseTexture, SceneView, CameraRig,
    baseViewMatrix, sceneDistanceZoomFactor, PLATE_MOTION_PRE, STAGE_W, STAGE_H, FONT,
    labelColor, drawRangeLabel, drawTextLabel, drawBoundaryLabel, drawBoxHighlight
  });
})();
