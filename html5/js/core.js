// Plate Tectonics HTML5 port - shared core (math, observables, model primitives).
// Ported from the PhET Java simulation "Plate Tectonics" (edu.colorado.phet.platetectonics).
// All model units are meters / kelvin-ish ("ZERO_CELSIUS" = 293.15 as in the original) / kg/m^3.
(function () {
  'use strict';
  const PT = (window.PT = window.PT || {});

  // ---------------------------------------------------------------- math
  class V2 {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    plus(v) { return new V2(this.x + v.x, this.y + v.y); }
    minus(v) { return new V2(this.x - v.x, this.y - v.y); }
    times(s) { return new V2(this.x * s, this.y * s); }
    negated() { return new V2(-this.x, -this.y); }
    dot(v) { return this.x * v.x + this.y * v.y; }
    magnitude() { return Math.sqrt(this.x * this.x + this.y * this.y); }
    normalized() { const m = this.magnitude(); return m === 0 ? new V2(0, 0) : new V2(this.x / m, this.y / m); }
    distance(v) { return this.minus(v).magnitude(); }
    getRotatedInstance(a) {
      const c = Math.cos(a), s = Math.sin(a);
      return new V2(this.x * c - this.y * s, this.x * s + this.y * c);
    }
  }
  V2.ZERO = new V2(0, 0);

  class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    plus(v) { return new V3(this.x + v.x, this.y + v.y, this.z + v.z); }
    minus(v) { return new V3(this.x - v.x, this.y - v.y, this.z - v.z); }
    times(s) { return new V3(this.x * s, this.y * s, this.z * s); }
    componentTimes(v) { return new V3(this.x * v.x, this.y * v.y, this.z * v.z); }
    negated() { return new V3(-this.x, -this.y, -this.z); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    cross(v) {
      return new V3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
    }
    magnitudeSquared() { return this.dot(this); }
    magnitude() { return Math.sqrt(this.dot(this)); }
    normalized() { const m = this.magnitude(); return m === 0 ? new V3(0, 0, 0) : this.times(1 / m); }
    angleBetween(v) {
      const d = this.normalized().dot(v.normalized());
      return Math.acos(Math.max(-1, Math.min(1, d)));
    }
  }
  V3.X_UNIT = new V3(1, 0, 0);
  V3.Y_UNIT = new V3(0, 1, 0);
  V3.Z_UNIT = new V3(0, 0, 1);

  const clamp = (min, v, max) => Math.max(min, Math.min(max, v));
  // linear function mapping [a1,a2] -> [b1,b2]
  const linear = (a1, a2, b1, b2) => (x) => b1 + (x - a1) * (b2 - b1) / (a2 - a1);
  const repeat = (fn, n) => { for (let i = 0; i < n; i++) fn(); };
  // PlateBehavior.recursiveSplitCall: splits a time step into halves until <= maxStep.
  // Java compares 32-bit floats; without fround a 0.1f step (0.10000000149) would split against 0.1.
  function recursiveSplitCall(fn, t, maxStep) {
    t = Math.fround(t); maxStep = Math.fround(maxStep);
    if (t > maxStep) {
      recursiveSplitCall(fn, t / 2, maxStep);
      recursiveSplitCall(fn, t / 2, maxStep);
    } else {
      fn(t);
    }
  }
  // Seeded RNG equivalent in spirit to java.util.Random(seed).nextFloat()
  class JavaRandom {
    constructor(seed) {
      this.seed = (BigInt(seed) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
    }
    next(bits) {
      this.seed = (this.seed * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
      return Number(this.seed >> BigInt(48 - bits));
    }
    nextFloat() { return this.next(24) / (1 << 24); }
  }

  // Ray / triangle intersection (Moller-Trumbore). Returns V3 point or null.
  function rayTriangle(rayPos, rayDir, a, b, c) {
    const e1 = b.minus(a), e2 = c.minus(a);
    const p = rayDir.cross(e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const s = rayPos.minus(a);
    const u = s.dot(p) * inv;
    if (u < 0 || u > 1) return null;
    const q = s.cross(e1);
    const v = rayDir.dot(q) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = e2.dot(q) * inv;
    if (t < 0) return null;
    return rayPos.plus(rayDir.times(t));
  }

  // ---------------------------------------------------------------- observables
  class Emitter {
    constructor() { this.listeners = []; }
    add(fn) { this.listeners.push(fn); return fn; }
    remove(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
    emit(arg) { for (const fn of this.listeners.slice()) fn(arg); }
  }

  class Property {
    constructor(value) { this.initial = value; this.value = value; this.observers = []; }
    get() { return this.value; }
    set(v) {
      const old = this.value;
      if (old === v) return;
      this.value = v;
      for (const fn of this.observers.slice()) fn(v, old);
    }
    reset() { this.set(this.initial); }
    // like PhET: observer called immediately unless callNow === false
    addObserver(fn, callNow = true) { this.observers.push(fn); if (callNow) fn(this.value, undefined); return fn; }
    removeObserver(fn) { const i = this.observers.indexOf(fn); if (i >= 0) this.observers.splice(i, 1); }
  }

  class ObservableList {
    constructor() { this.items = []; this.added = new Emitter(); this.removed = new Emitter(); }
    add(x) { this.items.push(x); this.added.emit(x); }
    remove(x) { const i = this.items.indexOf(x); if (i >= 0) { this.items.splice(i, 1); this.removed.emit(x); } }
    clear() { for (const x of this.items.slice()) this.remove(x); }
    contains(x) { return this.items.indexOf(x) >= 0; }
    isEmpty() { return this.items.length === 0; }
    get length() { return this.items.length; }
    [Symbol.iterator]() { return this.items[Symbol.iterator](); }
  }

  // ---------------------------------------------------------------- Side
  const sizeOf = (n) => (typeof n === 'number' ? n : n.length);
  class SideClass {
    constructor(name) { this.name = name; }
    getIndex(n) { return this === Side.LEFT ? 0 : sizeOf(n) - 1; }
    getFromIndex(n, i) { return this === Side.LEFT ? i : n - 1 - i; }
    getNewIndex(n) { return this === Side.LEFT ? 0 : sizeOf(n); }
    addToList(list, x) { list.splice(this.getNewIndex(list), 0, x); }
    removeFromList(list) { list.splice(this.getIndex(list), 1); }
    getEnd(list) { return list[this.getIndex(list)]; }
    getFromEnd(list, n) { return list[this.getIndex(list) - n * this.getSign()]; }
    isToSideOf(a, b) { return this === Side.LEFT ? a < b : a > b; }
    opposite() { return this === Side.LEFT ? Side.RIGHT : Side.LEFT; }
    getSign() { return this === Side.LEFT ? -1 : 1; }
  }
  const Side = { LEFT: new SideClass('LEFT'), RIGHT: new SideClass('RIGHT') };

  // ---------------------------------------------------------------- strings (Japanese, from the _ja properties)
  const STR = {
    title: 'プレートテクトニクス',
    crustTab: '地殻', plateMotionTab: 'プレート運動', myCrust: '地殻の組成',
    temperature: '温度', cool: '低め', warm: '高め', lessDense: '低密度', moreDense: '高密度',
    composition: '構成', moreIron: '鉄が多い', moreSilica: 'ケイ素が多い',
    thickness: '厚み', thin: '薄い', thick: '厚い',
    continentalCrust: '大陸地殻', oceanicCrust: '海洋地殻',
    youngOceanicCrust: '新しい海洋地殻', oldOceanicCrust: '古い海洋地殻',
    crust: '地殻', mantle: 'マントル', lithosphere: 'リソスフェア', lowerMantle: '下部マントル',
    outerCore: '外核', innerCore: '内核',
    options: '表示', densityView: '密度', temperatureView: '温度', bothView: '両方',
    showLabels: '名称を表示', showSeawater: '海水を表示', resetAll: '全てリセット',
    newCrust: '新しい地殻', rewind: '巻き戻し', automaticMode: '自動モード', manualMode: '手動モード',
    rulerUnits: 'km', timeSlow: '遅い', timeFast: '速い', millionYears: '百万年', timeElapsed: '経過時間',
    toolbox: 'ツールボックス (ドラッグします)', zoom: 'ズーム', legend: '凡例',
    convergent: '収束', divergent: '発散', transform: '変換'
  };

  // ---------------------------------------------------------------- constants
  const ZERO_CELSIUS = 293.15;
  const EARTH_RADIUS = 6371000;
  const TEMPS = {
    ZERO_CELSIUS,
    SIMPLE_MANTLE_TOP_TEMP: ZERO_CELSIUS + 700,
    SIMPLE_LITHOSPHERE_BOUNDARY_TEMP: ZERO_CELSIUS + 1100,
    SIMPLE_MANTLE_BOTTOM_TEMP: ZERO_CELSIUS + 1300,
    SIMPLE_CRUST_TOP_TEMP: ZERO_CELSIUS,
    SIMPLE_CRUST_BOTTOM_TEMP: ZERO_CELSIUS + 450,
    SIMPLE_MAGMA_TEMP: ZERO_CELSIUS + 1300
  };

  // ---------------------------------------------------------------- PlateType
  class PlateTypeClass {
    constructor(name, continental, oceanic, density, crustTopY, crustBottomY, mantleLithosphereThickness, labelKey) {
      Object.assign(this, { name, continental, oceanic, density, crustTopY, crustBottomY, mantleLithosphereThickness, labelKey });
    }
    isContinental() { return this.continental; }
    isOceanic() { return this.oceanic; }
    getDensity() { return this.density; }
    getCrustTopY() { return this.crustTopY; }
    getCrustBottomY() { return this.crustBottomY; }
    getMantleLithosphereThickness() { return this.mantleLithosphereThickness; }
    getLithosphereBottomY() { return this.crustBottomY - this.mantleLithosphereThickness; }
    getCrustThickness() { return this.crustTopY - this.crustBottomY; }
    getLithosphereThickness() { return this.crustTopY - this.getLithosphereBottomY(); }
    getSpecificLabel() { return STR[this.labelKey]; }
    toString() { return this.name; }
  }
  const PlateType = {
    CONTINENTAL: new PlateTypeClass('CONTINENTAL', true, false, 2750, 3500, -40000, 70000, 'continentalCrust'),
    YOUNG_OCEANIC: new PlateTypeClass('YOUNG_OCEANIC', false, true, 3000, -4000, -10000, 45000, 'youngOceanicCrust'),
    OLD_OCEANIC: new PlateTypeClass('OLD_OCEANIC', false, true, 3070, -4000, -10000, 55000, 'oldOceanicCrust')
  };

  // ---------------------------------------------------------------- TextureStrategy
  class TextureStrategy {
    constructor(frontScale) { this.frontScale = frontScale; }
    getFrontScale() { return this.frontScale; }
    getTopScale() { return this.frontScale * 0.25; }
    mapTop(v) { return v.times(this.getTopScale()); }
    mapTopDelta(v) { return v.times(this.getTopScale()); }
    mapFront(v) { return v.times(this.frontScale); }
    mapFrontDelta(v) { return v.times(this.frontScale); }
  }

  // ---------------------------------------------------------------- samples
  class Sample {
    constructor(position, temperature, density, textureCoordinates) {
      this.position = position; this.temperature = temperature; this.density = density;
      this.textureCoordinates = textureCoordinates; this.randomTerrainOffset = 0;
    }
    shiftWithTexture(delta, ts) {
      this.position = this.position.plus(delta);
      this.textureCoordinates = this.textureCoordinates.plus(ts.mapFrontDelta(new V2(delta.x, delta.y)));
    }
    getPosition() { return this.position; } setPosition(p) { this.position = p; }
    getTemperature() { return this.temperature; } setTemperature(t) { this.temperature = t; }
    getDensity() { return this.density; } setDensity(d) { this.density = d; }
    getTextureCoordinates() { return this.textureCoordinates; } setTextureCoordinates(t) { this.textureCoordinates = t; }
    getRandomTerrainOffset() { return this.randomTerrainOffset; } setRandomTerrainOffset(o) { this.randomTerrainOffset = o; }
  }

  class TerrainSample {
    constructor(elevation, textureCoordinates) {
      this.elevation = elevation; this.textureCoordinates = textureCoordinates; this.randomElevationOffset = 0;
    }
    getElevation() { return this.elevation; } setElevation(e) { this.elevation = e; }
    getTextureCoordinates() { return this.textureCoordinates; } setTextureCoordinates(t) { this.textureCoordinates = t; }
    getRandomElevationOffset() { return this.randomElevationOffset; } setRandomElevationOffset(o) { this.randomElevationOffset = o; }
  }

  // ---------------------------------------------------------------- Terrain (top surface grid: columns along x, rows along z)
  class Terrain {
    constructor(zSamples, minZ, maxZ) {
      this.xPositions = []; this.zPositions = []; this.samples = [];
      this.elevationChanged = new Emitter(); this.columnsModified = new Emitter(); this.disposed = new Emitter();
      this.isWaterValid = new Property(true);
      this.zSamples = zSamples;
      for (let i = 0; i < zSamples; i++) this.zPositions.push(minZ + (i / (zSamples - 1)) * (maxZ - minZ));
    }
    getFrontZIndex() { return this.zSamples - 1; }
    getNumColumns() { return this.samples.length; }
    getNumRows() { return this.zSamples; }
    getSample(col, row) { return this.samples[col][row]; }
    getNumberOfVertices() { return this.getNumColumns() * this.getNumRows(); }
    getColumn(i) { return this.samples[i]; }
    addColumn(side, x, column) {
      side.addToList(this.samples, column); side.addToList(this.xPositions, x); this.columnsModified.emit(this);
    }
    removeColumn(side) { side.removeFromList(this.samples); side.removeFromList(this.xPositions); this.columnsModified.emit(this); }
    getZSamples() { return this.zSamples; }
    hasWater() { return true; }
    getFrontVertices() {
      const n = this.getFrontZIndex();
      return this.xPositions.map((x, i) => new V2(x, this.getSample(i, n).getElevation()));
    }
    setToFlatElevation(e) { for (const col of this.samples) for (const s of col) s.setElevation(e); }
    shiftColumnElevation(i, d) { for (const s of this.getColumn(i)) s.setElevation(s.getElevation() + d); }
    shiftColumnXWithTexture(ts, i, d) {
      this.xPositions[i] += d;
      for (const s of this.getColumn(i)) s.setTextureCoordinates(s.getTextureCoordinates().plus(ts.mapTopDelta(new V2(d, 0))));
    }
    shiftZ(d) { for (let i = 0; i < this.zPositions.length; i++) this.zPositions[i] += d; }
    setColumnElevation(i, e) { for (const s of this.getColumn(i)) s.setElevation(e); }
    // ray in view space; mvt has transformPosition(V3)
    intersectWithRay(rayPos, rayDir, mvt) {
      const xr = this.xPositions.map((x) => PlateTectonicsModel.getXRadialVector(x));
      const row = (r) => {
        const zr = PlateTectonicsModel.getZRadialVector(this.zPositions[r]);
        return this.xPositions.map((x, i) => mvt.transformPosition(PlateTectonicsModel.convertToRadial3(xr[i], zr, this.getSample(i, r).getElevation())));
      };
      let r = this.zSamples - 1;
      let prev = row(r);
      while (r >= 1) {
        const cur = row(--r);
        for (let i = 1; i < this.xPositions.length; i++) {
          let p = rayTriangle(rayPos, rayDir, cur[i - 1], cur[i], prev[i]);
          if (p) return p;
          p = rayTriangle(rayPos, rayDir, prev[i], prev[i - 1], cur[i - 1]);
          if (p) return p;
        }
        prev = cur;
      }
      return null;
    }
  }

  class TerrainConnectorStrip extends Terrain {
    constructor(left, right, samples, minZ, maxZ) {
      super(left.getNumRows(), minZ, maxZ);
      this.left = left; this.right = right; this.numSamples = samples;
      this.update();
    }
    update() {
      const leftXIndex = this.left.getNumColumns() - 1;
      const lx = this.left.xPositions[leftXIndex];
      const rx = this.right.xPositions[0];
      this.samples.length = 0; this.xPositions.length = 0;
      for (let i = 0; i < this.numSamples; i++) {
        const r = i / (this.numSamples - 1);
        const col = [];
        for (let j = 0; j < this.left.getNumRows(); j++) {
          const zr = j / (this.left.getNumRows() - 1);
          const le = this.left.getSample(leftXIndex, j).getElevation();
          const re = this.right.getSample(0, j).getElevation();
          col.push(new TerrainSample(le + r * (re - le), new V2(r / 2, zr * 100)));
        }
        this.samples.push(col); this.xPositions.push(lx + r * (rx - lx));
      }
      if (this.left.zPositions[0] !== this.right.zPositions[0]) {
        const src = this.left.getSample(leftXIndex, 0).getElevation() > this.right.getSample(0, 0).getElevation()
          ? this.left.zPositions : this.right.zPositions;
        for (let i = 0; i < this.left.getNumRows(); i++) this.zPositions[i] = src[i];
      }
      this.columnsModified.emit(this); this.elevationChanged.emit(this);
    }
    hasWater() { return false; }
  }

  // ---------------------------------------------------------------- regions
  class Boundary {
    constructor() { this.samples = []; }
    addSample(side, s) { side.addToList(this.samples, s); }
    removeSample(side) { side.removeFromList(this.samples); }
    replaceSample(a, b) { const i = this.samples.indexOf(a); if (i >= 0) this.samples[i] = b; }
    getSample(i) { return this.samples[i]; }
    getEdgeSample(side, n) { return n === undefined ? side.getEnd(this.samples) : side.getFromEnd(this.samples, n); }
    getApproximateYFromX(x) {
      const L = this.getEdgeSample(Side.LEFT), R = this.getEdgeSample(Side.RIGHT);
      if (x <= L.position.x) return L.position.y;
      if (x >= R.position.x) return R.position.y;
      let lo = 0, hi = this.samples.length - 1;
      while (lo + 1 !== hi) {
        const mid = (lo + hi) >> 1;
        if (x >= this.samples[mid].position.x) lo = mid; else hi = mid;
      }
      const a = this.samples[lo], b = this.samples[hi];
      const r = (x - a.position.x) / (b.position.x - a.position.x);
      return r * b.position.y + (1 - r) * a.position.y;
    }
  }

  // A strip of quads between two lists of samples (rendered as a triangle strip)
  class CrossSectionStrip {
    constructor(top, bottom) {
      this.topPoints = []; this.bottomPoints = [];
      this.changed = new Emitter(); this.moveToFrontNotifier = new Emitter(); this.disposed = new Emitter();
      this.alpha = new Property(1);
      this.alwaysOnTop = false; // set once moved to front (rendered without depth test, like the original)
      if (top) for (let i = 0; i < top.length; i++) this.addPatch(Side.RIGHT, top[i], bottom[i]);
    }
    getLength() { return this.topPoints.length; }
    getNumberOfVertices() { return this.topPoints.length * 2; }
    addPatch(side, top, bottom) { side.addToList(this.topPoints, top); side.addToList(this.bottomPoints, bottom); }
    removePatch(side) { side.removeFromList(this.topPoints); side.removeFromList(this.bottomPoints); }
    update() { this.changed.emit(this); }
  }

  // Region: (numStrips + 1) boundaries of samples, fn(boundaryIndex, sampleIndex) => Sample
  class Region {
    constructor(numStrips, numSamples, fn) {
      this.disposed = new Emitter(); this.boundaries = []; this.strips = [];
      for (let i = 0; i < numStrips + 1; i++) {
        const b = new Boundary();
        this.boundaries.push(b);
        for (let j = 0; j < numSamples; j++) b.samples.push(fn(i, j));
      }
      for (let i = 0; i < numStrips; i++) this.strips.push(new CrossSectionStrip(this.boundaries[i].samples, this.boundaries[i + 1].samples));
    }
    addColumn(side, list) {
      for (let i = 0; i < list.length; i++) this.boundaries[i].addSample(side, list[i]);
      for (let i = 0; i < this.strips.length; i++) this.strips[i].addPatch(side, list[i], list[i + 1]);
    }
    removeColumn(side) {
      for (const b of this.boundaries) b.removeSample(side);
      for (const s of this.strips) s.removePatch(side);
    }
    getTopElevation(i) { return this.getTopBoundary().samples[i].position.y; }
    getBottomElevation(i) { return this.getBottomBoundary().samples[i].position.y; }
    layoutColumn(i, top, bottom, ts, updateTexture) {
      const n = this.boundaries.length;
      for (let b = 0; b < n; b++) {
        const s = this.boundaries[b].samples[i];
        const p = s.position;
        const r = b / (n - 1);
        const y = (1 - r) * top + r * bottom;
        s.position = new V3(p.x, y, p.z);
        if (updateTexture) s.textureCoordinates = s.textureCoordinates.plus(ts.mapFrontDelta(new V2(0, y - p.y)));
      }
    }
    moveToFront() { for (const s of this.strips) s.moveToFrontNotifier.emit(s); }
    getTopBoundary() { return this.boundaries[0]; }
    getBottomBoundary() { return this.boundaries[this.boundaries.length - 1]; }
    getBoundaries() { return this.boundaries; }
    getStrips() { return this.strips; }
    getSamples() { const out = []; for (const b of this.boundaries) for (const s of b.samples) out.push(s); return out; }
    setAllAlphas(a) { for (const s of this.strips) s.alpha.set(a); }
  }

  class MagmaRegion extends Region {
    constructor(ts, scale, angle, numSamples, position) {
      const texOffset = new V2(Math.random(), Math.random());
      super(1, numSamples, (b, i) => {
        const r = i / (numSamples - 1);
        const a = b === 0 ? (1 - r) * Math.PI : (1 - r) * -Math.PI;
        const v = MagmaRegion.computeTeardropShape(a).times(scale).getRotatedInstance(angle);
        return new Sample(new V3(v.x, v.y, 0), TEMPS.SIMPLE_MAGMA_TEMP, 2000, ts.mapFront(v).plus(texOffset));
      });
      this.alpha = new Property(1);
      this.position = new Property(position);
      for (const s of this.getSamples()) s.position = s.position.plus(new V3(position.x, position.y, 0));
      this.position.addObserver((nv, ov) => {
        if (!ov) return;
        const d = new V3(nv.x - ov.x, nv.y - ov.y, 0);
        for (const s of this.getSamples()) s.position = s.position.plus(d);
      }, false);
      this.alpha.addObserver((a) => this.setAllAlphas(a));
    }
    static computeTeardropShape(a) {
      const d = Math.max(0, Math.cos(a));
      return new V2(Math.cos(a) + d, Math.sin(a) * (1 - d * d)).minus(new V2(2, 0));
    }
  }

  // ---------------------------------------------------------------- Plate
  class Plate {
    constructor() {
      this.crust = null; this.lithosphere = null; this.mantle = null; this.terrain = null;
      this.disposed = new Emitter(); this.regions = new ObservableList();
    }
    addCrust(r) { this.crust = r; this.regions.add(r); }
    addLithosphere(r) { this.lithosphere = r; this.regions.add(r); }
    addMantle(r) { this.mantle = r; this.regions.add(r); }
    addTerrain(ts, zSamples, minZ, maxZ) {
      const region = this.crust == null ? this.mantle : this.crust;
      const t = new Terrain(zSamples, minZ, maxZ);
      const top = region.getTopBoundary().samples;
      for (let i = 0; i < top.length; i++) {
        const x = top[i].position.x;
        const col = [];
        for (let j = 0; j < zSamples; j++) col.push(new TerrainSample(top[i].position.y, ts.mapTop(new V2(x, t.zPositions[j]))));
        t.addColumn(Side.RIGHT, x, col);
      }
      this.terrain = t;
    }
    shiftZ(d) {
      for (const s of this.getSamples()) s.position = s.position.plus(new V3(0, 0, d));
      this.terrain.shiftZ(d);
    }
    getSamples() {
      const set = new Set();
      for (const r of this.regions) for (const s of r.getSamples()) set.add(s);
      return Array.from(set);
    }
    getCrust() { return this.crust; } getMantle() { return this.mantle; }
    getLithosphere() { return this.lithosphere; } getTerrain() { return this.terrain; }
  }

  // ---------------------------------------------------------------- view-space transform (model meters -> view units)
  class ModelViewTransform {
    constructor(scale) { this.scale = scale; }
    transformPosition(v) { return v.times(this.scale); }
    inversePosition(v) { return v.times(1 / this.scale); }
    transformDeltaX(x) { return x * this.scale; }
    transformDeltaY(y) { return y * this.scale; }
  }

  // ---------------------------------------------------------------- base model
  class PlateTectonicsModel {
    constructor(bounds, textureStrategy) {
      this.bounds = bounds; // {minX,maxX,minY,maxY,minZ,maxZ}
      this.textureStrategy = textureStrategy;
      this.modelChanged = new Emitter();
      this.plates = []; this.regions = []; this.crossSectionStrips = []; this.terrains = [];
      this.renderOrder = []; // strips in draw order (moveToFront => end)
      this._onRegionAdded = (r) => this.addRegion(r);
      this._onRegionRemoved = (r) => this.removeRegion(r);
      this._onMoveToFront = (s) => {
        const i = this.renderOrder.indexOf(s);
        if (i >= 0) { this.renderOrder.splice(i, 1); this.renderOrder.push(s); }
        s.alwaysOnTop = true;
      };
    }
    getDensity(x, y) { return 0; }
    getTemperature(x, y) { return 0; }
    getBounds() { return this.bounds; }
    update(dt) {}
    resetAll() {}
    getTextureStrategy() { return this.textureStrategy; }
    getCrossSectionStrips() { return this.crossSectionStrips; }
    getTerrains() { return this.terrains; }
    getRegions() { return this.regions; }
    getStripsInOrder() { return this.crossSectionStrips; }

    addPlate(p) {
      this.plates.push(p);
      p.regions.added.add(this._onRegionAdded);
      p.regions.removed.add(this._onRegionRemoved);
      for (const r of p.regions) this.addRegion(r);
      this.addTerrain(p.getTerrain());
    }
    removePlate(p) {
      const i = this.plates.indexOf(p); if (i >= 0) this.plates.splice(i, 1);
      p.regions.added.remove(this._onRegionAdded);
      p.regions.removed.remove(this._onRegionRemoved);
      p.disposed.emit(p);
      for (const r of p.regions) this.removeRegion(r);
      this.removeTerrain(p.getTerrain());
    }
    addRegion(r) { this.regions.push(r); for (const s of r.getStrips()) this.addStrip(s); }
    removeRegion(r) {
      const i = this.regions.indexOf(r); if (i >= 0) this.regions.splice(i, 1);
      r.disposed.emit(r);
      for (const s of r.getStrips()) this.removeStrip(s);
    }
    addStrip(s) {
      this.crossSectionStrips.push(s); this.renderOrder.push(s);
      s.moveToFrontNotifier.add(this._onMoveToFront);
    }
    removeStrip(s) {
      let i = this.crossSectionStrips.indexOf(s); if (i >= 0) this.crossSectionStrips.splice(i, 1);
      i = this.renderOrder.indexOf(s); if (i >= 0) this.renderOrder.splice(i, 1);
      s.moveToFrontNotifier.remove(this._onMoveToFront);
      s.disposed.emit(s);
    }
    addTerrain(t) { this.terrains.push(t); }
    removeTerrain(t) { const i = this.terrains.indexOf(t); if (i >= 0) this.terrains.splice(i, 1); t.disposed.emit(t); }

    // density along a view-space ray hitting the terrain (used by the density meter when pointing at air)
    rayTraceDensity(rayPos, rayDir, mvt, waterVisible) {
      for (const t of this.terrains) {
        const hit = t.intersectWithRay(rayPos, rayDir, mvt);
        if (!hit) continue;
        const p = PlateTectonicsModel.convertToPlanar(mvt.inversePosition(hit));
        if (p.y < 0 && waterVisible) return PlateTectonicsModel.getWaterDensity(0);
        return 2720;
      }
      return 0;
    }

    firstStripIntersection(x, y) {
      for (const strip of this.getStripsInOrder()) {
        const T = strip.topPoints, B = strip.bottomPoints;
        for (let i = 0; i < T.length - 1; i++) {
          let h = triangleXYHit(T[i], B[i], T[i + 1], x, y);
          if (h) return h;
          h = triangleXYHit(B[i], T[i + 1], B[i + 1], x, y);
          if (h) return h;
        }
      }
      return null;
    }

    static getAirTemperature(h) { return Math.max(0, ZERO_CELSIUS + 15 - (15 * h) / 2500); }
    static getAirDensity(h) {
      const p = 101.325 * Math.pow(1 - (0.0065 * h) / 288.15, 5.25221728828453);
      const d = (p * 0.0289644) / (8.31447 * PlateTectonicsModel.getAirTemperature(h));
      return isNaN(d) ? 0 : d;
    }
    static getWaterDensity(h) { return h > -1000 ? 1025 + 3 * (h / -1000) : 1028; }
    static getWaterTemperature(h) {
      if (h > -200) return PlateTectonicsModel.getAirTemperature(0);
      if (h > -1000) return linear(-1000, -200, ZERO_CELSIUS + 4, PlateTectonicsModel.getAirTemperature(0))(h);
      return ZERO_CELSIUS + 4;
    }
    static getXRadialVector(x) {
      const a = Math.PI / 2 - x / EARTH_RADIUS;
      return new V3(Math.cos(a), Math.sin(a), 1);
    }
    static getZRadialVector(z) {
      const a = Math.PI / 2 - z / EARTH_RADIUS;
      const s = Math.sin(a);
      return new V3(s, s, Math.cos(a));
    }
    static convertToRadial3(xRadial, zRadial, y) {
      return xRadial.componentTimes(zRadial).times(y + EARTH_RADIUS).plus(EARTH_CENTER);
    }
    // planar model point (x, y, z) -> curved-earth point
    static convertToRadial(v) {
      return PlateTectonicsModel.convertToRadial3(PlateTectonicsModel.getXRadialVector(v.x), PlateTectonicsModel.getZRadialVector(v.z), v.y);
    }
    static convertToRadialXY(x, y) {
      return PlateTectonicsModel.convertToRadial3(PlateTectonicsModel.getXRadialVector(x), RADIAL_Z_0, y);
    }
    static convertToPlanar(v) {
      const d = v.minus(EARTH_CENTER);
      const m = d.magnitude();
      const theta = Math.acos(d.z / m);
      const phi = Math.atan2(d.y, d.x);
      let a = Math.PI / 2 - phi;
      if (a > Math.PI) a -= Math.PI * 2;
      return new V3(a * EARTH_RADIUS, m - EARTH_RADIUS, (Math.PI / 2 - theta) * EARTH_RADIUS);
    }
  }
  const EARTH_CENTER = new V3(0, -EARTH_RADIUS, 0);
  const RADIAL_Z_0 = new V3(1, 1, 0);
  PlateTectonicsModel.ZERO_CELSIUS = ZERO_CELSIUS;
  PlateTectonicsModel.MAX_FLAT_X = EARTH_RADIUS * Math.PI;
  PlateTectonicsModel.DEEP_OCEAN_TEMPERATURE = ZERO_CELSIUS + 4;

  const area2 = (ax, ay, bx, by, cx, cy) => Math.abs(((ax - cx) * (by - cy) - (bx - cx) * (ay - cy)) / 2);
  function triangleXYHit(s1, s2, s3, x, y) {
    const a = s1.position, b = s2.position, c = s3.position;
    const total = area2(a.x, a.y, b.x, b.y, c.x, c.y);
    if (total <= 0) return null;
    const w1 = area2(x, y, b.x, b.y, c.x, c.y);
    const w2 = area2(x, y, c.x, c.y, a.x, a.y);
    const w3 = area2(x, y, a.x, a.y, b.x, b.y);
    if (w1 + w2 + w3 > total * (1 + 1e-6)) return null; // outside
    return {
      density: (w1 / total) * s1.density + (w2 / total) * s2.density + (w3 / total) * s3.density,
      temperature: (w1 / total) * s1.temperature + (w2 / total) * s2.temperature + (w3 / total) * s3.temperature
    };
  }

  Object.assign(PT, {
    V2, V3, clamp, linear, repeat, recursiveSplitCall, JavaRandom, rayTriangle,
    Emitter, Property, ObservableList, Side, STR, TEMPS, ZERO_CELSIUS, EARTH_RADIUS,
    PlateType, TextureStrategy, Sample, TerrainSample, Terrain, TerrainConnectorStrip,
    Boundary, CrossSectionStrip, Region, MagmaRegion, Plate, ModelViewTransform, PlateTectonicsModel
  });
})();
