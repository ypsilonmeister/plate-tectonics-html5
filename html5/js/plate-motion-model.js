// Plate Motion model, ported from the PhET Plate Tectonics Java simulation.
(function () {
  'use strict';
  const PT = window.PT;
  const { V2, V3, Property, Emitter, ObservableList, Side, PlateType, Sample,
    TerrainSample, Region, Boundary, MagmaRegion, TextureStrategy, TerrainConnectorStrip,
    TEMPS, STR, clamp, repeat, recursiveSplitCall } = PT;

  // The Java MortalUpdateListener lifetime is tied to its owner, not to a frame.
  function mortal(notifier, disposed, fn, callNow = false) {
    notifier.add(fn);
    const remove = () => { notifier.remove(fn); disposed.remove(remove); };
    disposed.add(remove);
    if (callNow) fn();
  }
  const MotionType = {
    CONVERGENT: { name: 'CONVERGENT', color: [0, 0.8, 0, 0.8] },
    DIVERGENT: { name: 'DIVERGENT', color: [0.8, 0, 0, 0.8] },
    TRANSFORM: { name: 'TRANSFORM', color: [0, 0, 1, 0.8] }
  };

  class TectonicsClock {
    constructor(timeMultiplier) {
      this.lastSimulationTime = 0; this.simulationTime = 0;
      this.lastWallTime = 0; this.wallTime = 0;
      this.timeMultiplier = timeMultiplier; this.timeLimit = Number.MAX_VALUE;
      this.running = new Property(false);
      for (const key of ['ticked', 'timeChanged', 'started', 'paused', 'timeReset']) this[key] = new Emitter();
      this.running.addObserver(running => (running ? this.started : this.paused).emit(), false);
    }
    stepByWallSeconds(dt) { if (this.running.get()) this.stepByWallSecondsForced(dt); }
    stepByWallSecondsForced(dt) { this.tick(dt); }
    tick(dt) {
      this.lastWallTime = this.wallTime; this.wallTime = Date.now();
      if (this.simulationTime >= this.timeLimit) return;
      this.setSimulationTime(Math.min(this.timeLimit, this.simulationTime + dt * this.timeMultiplier));
      this.ticked.emit(this.getSimulationTimeChange());
    }
    start() { this.running.set(true); }
    pause() { this.running.set(false); }
    isPaused() { return !this.running.get(); }
    isRunning() { return this.running.get(); }
    resetSimulationTime() { this.setSimulationTime(0); this.timeReset.emit(); }
    getSimulationTime() { return this.simulationTime; }
    getSimulationTimeChange() { return this.simulationTime - this.lastSimulationTime; }
    setSimulationTime(time) {
      this.lastSimulationTime = this.simulationTime; this.simulationTime = time;
      this.timeChanged.emit(this.getSimulationTimeChange());
    }
    stepClockWhilePaused() { this.tick(5); }
    stepClockBackWhilePaused() { this.tick(5); } // The Java method also advances.
    setTimeMultiplier(value) { this.timeMultiplier = value; }
    getTimeMultiplier() { return this.timeMultiplier; }
    getTimeLimit() { return this.timeLimit; }
    setTimeLimit(value) { this.timeLimit = value; }
    resetTimeLimit() { this.timeLimit = Number.MAX_VALUE; }
  }
  class SmokePuff {
    constructor() {
      this.position = new Property(new V3()); this.scale = new Property(1);
      this.alpha = new Property(0); this.age = 0;
    }
  }
  class RangeLabel {
    constructor(top, bottom, label, plate) {
      Object.assign(this, { top, bottom, label, plate });
      this.disposed = new Emitter(); this.limitToScreen = false;
    }
  }
  class BoundaryLabel {
    constructor(boundary, side) {
      Object.assign(this, { boundary, side }); this.disposed = new Emitter();
      this.minX = new Property(-Infinity); this.maxX = new Property(Infinity);
    }
    isReversed() { return false; }
    getBoundary() { return this.boundary; }
  }
  class TextLabel {
    constructor(centerPosition, label) {
      Object.assign(this, { centerPosition, label }); this.disposed = new Emitter();
    }
  }

  class BoundaryTrackingProperty extends Property {
    constructor(plate, boundary, index) {
      super(new V3());
      const sample = boundary.getSample(index), x = sample.position.x;
      mortal(plate.model.modelChanged, plate.disposed, () => {
        this.set(plate.behavior instanceof RiftingBehavior || plate.behavior instanceof TransformBehavior
          ? sample.position : new V3(x, boundary.getApproximateYFromX(x), 0));
      }, true);
    }
  }
  class PlateMotionPlate extends PT.Plate {
    constructor(model, textureStrategy, side) {
      super(); Object.assign(this, { model, textureStrategy, side });
      this.boundaryLabel = null; this.plateType = null; this.behavior = null;
      this.addMantle(new Region(6, 96, (b, i) => this.createMantleSample(i, b, 6,
        -10000, -600000, TEMPS.SIMPLE_MANTLE_TOP_TEMP, TEMPS.SIMPLE_MANTLE_BOTTOM_TEMP)));
      this.addTerrain(textureStrategy, 32, model.bounds.minZ, model.bounds.maxZ);
      this.terrain.isWaterValid.set(false);
    }
    createMantleSample(i, b, count, top, bottom, topTemp, bottomTemp) {
      const x = this.model.getStartingX(this.side, i), r = b / count;
      const y = top + (bottom - top) * r;
      return new Sample(new V3(x, y, 0), topTemp + (bottomTemp - topTemp) * r,
        3300, this.textureStrategy.mapFront(new V2(x, y)));
    }
    droppedCrust(type) {
      this.plateType = type;
      const top = type.getCrustTopY(), bottom = type.getCrustBottomY(), lithBottom = type.getLithosphereBottomY();
      this.addLithosphere(new Region(2, 96, (b, i) => this.createMantleSample(i, b, 2,
        bottom, lithBottom, TEMPS.SIMPLE_MANTLE_TOP_TEMP, TEMPS.SIMPLE_LITHOSPHERE_BOUNDARY_TEMP)));
      this.addCrust(new Region(2, 96, (b, i) => {
        const x = this.model.getStartingX(this.side, i), r = b / 2, y = top + (bottom - top) * r;
        return new Sample(new V3(x, y, 0), PlateMotionPlate.getCrustTemperatureFromYRatio(r),
          type.getDensity(), this.textureStrategy.mapFront(new V2(x, y)));
      }));
      this.mantle.boundaries.forEach((boundary, b) => boundary.samples.forEach((sample, i) => {
        const s = this.createMantleSample(i, b, 6, lithBottom, -600000,
          TEMPS.SIMPLE_LITHOSPHERE_BOUNDARY_TEMP, TEMPS.SIMPLE_MANTLE_BOTTOM_TEMP);
        sample.position = s.position; sample.temperature = s.temperature;
        sample.density = s.density; sample.textureCoordinates = s.textureCoordinates;
      }));
      const n = Math.trunc(this.crust.getTopBoundary().samples.length * (this.side === Side.LEFT ? 5 : 1) / 6);
      const n2 = Math.trunc(this.crust.getTopBoundary().samples.length * (this.side === Side.LEFT ? 4 : 2) / 6);
      this.model.rangeLabels.add(new RangeLabel(new BoundaryTrackingProperty(this, this.crust.getTopBoundary(), n),
        new BoundaryTrackingProperty(this, this.crust.getBottomBoundary(), n), type.getSpecificLabel(), this));
      this.model.rangeLabels.add(new RangeLabel(new BoundaryTrackingProperty(this, this.crust.getTopBoundary(), n2),
        new BoundaryTrackingProperty(this, this.lithosphere.getBottomBoundary(), n2), STR.lithosphere, this));
      this.boundaryLabel = new BoundaryLabel(this.lithosphere.getBottomBoundary(), this.side);
      this.boundaryLabel.isReversed = () => this.behavior instanceof RiftingBehavior;
      this.model.boundaryLabels.add(this.boundaryLabel);
      this.terrain.isWaterValid.set(true);
    }
    getSimpleChunkWidth() { return this.model.getStartingX(Side.LEFT, 1) - this.model.getStartingX(Side.LEFT, 0); }
    addSection(side, type) {
      const dx = (this.model.getStartingX(side, 1) - this.model.getStartingX(side, 0)) * side.getSign();
      const x = this.crust.getTopBoundary().getEdgeSample(side).position.x + dx;
      for (const region of [this.crust, this.lithosphere]) {
        const crust = region === this.crust;
        const top = crust ? type.getCrustTopY() : type.getCrustBottomY();
        const bottom = crust ? type.getCrustBottomY() : type.getLithosphereBottomY();
        const column = region.boundaries.map((b, i) => {
          const s = b.getEdgeSample(side), r = i / 2, y = top + (bottom - top) * r;
          return new Sample(new V3(s.position.x + dx, y, 0), crust
            ? PlateMotionPlate.getCrustTemperatureFromYRatio(r) : PlateMotionPlate.getLithosphereTemperatureFromYRatio(r),
          crust ? type.getDensity() : 3300, s.textureCoordinates.plus(this.textureStrategy.mapFrontDelta(new V2(dx, 0))));
        });
        region.addColumn(side, column);
      }
      const column = [];
      for (let j = 0; j < this.terrain.getZSamples(); j++) {
        const s = this.terrain.getSample(side.getIndex(this.terrain.getNumColumns()), j);
        column.push(new TerrainSample(this.crust.getTopBoundary().getEdgeSample(side).position.y,
          s.textureCoordinates.plus(this.textureStrategy.mapTopDelta(new V2(dx, 0)))));
      }
      this.terrain.addColumn(side, x, column);
    }
    removeSection(side) { this.crust.removeColumn(side); this.lithosphere.removeColumn(side); this.terrain.removeColumn(side); }
    fullSyncTerrain() {
      for (let i = 0; i < this.terrain.getNumColumns(); i++) {
        const p = (this.plateType ? this.crust : this.mantle).getTopBoundary().samples[i].position;
        this.terrain.setColumnElevation(i, p.y); this.terrain.xPositions[i] = p.x;
      }
      this.terrain.elevationChanged.emit();
    }
    static getCrustTemperatureFromYRatio(r) { return TEMPS.SIMPLE_CRUST_TOP_TEMP + (TEMPS.SIMPLE_CRUST_BOTTOM_TEMP - TEMPS.SIMPLE_CRUST_TOP_TEMP) * r; }
    static getLithosphereTemperatureFromYRatio(r) { return TEMPS.SIMPLE_MANTLE_TOP_TEMP + (TEMPS.SIMPLE_LITHOSPHERE_BOUNDARY_TEMP - TEMPS.SIMPLE_MANTLE_TOP_TEMP) * r; }
    addMiddleSide(other) {
      for (const source of [this.mantle, this.lithosphere]) {
        this.regions.add(new Region(source === this.mantle ? 6 : 2, this.terrain.getNumRows(), (b, j) => {
          const s = source.boundaries[b].samples[0], y = s.position.y;
          const z = this.terrain.zPositions[this.side === Side.LEFT ? this.terrain.getNumRows() - j - 1 : j];
          return new Sample(new V3(0, y, z), s.temperature, s.density,
            this.textureStrategy.mapFront(new V2(z * this.side.getSign(), y)));
        }));
      }
      const region = new Region(2, this.terrain.getNumRows(), this.createMiddleCrustSampleFactory(other));
      mortal(this.model.modelChanged, region.disposed, () => {
        const factory = this.createMiddleCrustSampleFactory(other);
        region.boundaries.forEach((b, i) => b.samples.forEach((s, j) => {
          s.position = new V3(s.position.x, factory(i, j).position.y, s.position.z);
        }));
      });
      this.regions.add(region);
    }
    createMiddleCrustSampleFactory(other) {
      const n = this.side.opposite().getIndex(this.terrain.getNumColumns());
      const n2 = this.side.getIndex(this.terrain.getNumColumns());
      const bottom = this.crust.getBottomBoundary().samples[0].position.y;
      return (b, j) => {
        const row = this.side.getFromIndex(this.terrain.getNumRows(), j);
        const top = this.terrain.getSample(n, row).elevation;
        const otherTop = other.terrain.getSample(n2, row).elevation;
        const ratio = (Math.min(top, otherTop) - bottom) / (top - bottom);
        const r = b / 2 * ratio + (1 - ratio), y = top + (bottom - top) * r;
        const z = this.terrain.zPositions[row], s = this.crust.boundaries[b].samples[0];
        return new Sample(new V3(0, y, z), PlateMotionPlate.getCrustTemperatureFromYRatio(r), s.density,
          this.textureStrategy.mapFront(new V2(z * this.side.getSign(), y)));
      };
    }
    getBehavior() { return this.behavior; }
    setBehavior(behavior) { this.behavior = behavior; }
    getSide() { return this.side; }
    getSign() { return this.side.getSign(); }
    getTextureStrategy() { return this.textureStrategy; }
    getPlateType() { return this.plateType; }
    getModel() { return this.model; }
    getBoundaryLabel() { return this.boundaryLabel; }
    randomizeTerrain() {
      const random = new PT.JavaRandom(0), t = this.terrain;
      const shared = Array.from({ length: t.getNumRows() }, () => random.nextFloat());
      const amplitude = this.plateType.isContinental() ? 2000 : 500;
      const offset = this.plateType.isContinental() ? -1000 : 0;
      for (let i = 0; i < t.getNumColumns(); i++) {
        const edge = i === this.side.opposite().getIndex(t.getNumColumns());
        for (let j = 0; j < t.getNumRows(); j++) {
          const delta = (edge ? shared[j] : random.nextFloat()) * amplitude + offset;
          const s = t.getSample(i, j); s.elevation += delta; s.randomElevationOffset = delta;
          if (j === t.getFrontZIndex()) {
            const y = this.crust.getTopElevation(i) + delta;
            this.crust.getTopBoundary().samples[i].randomTerrainOffset = delta;
            this.crust.layoutColumn(i, y, this.crust.getBottomElevation(i), this.textureStrategy, true);
          }
        }
      }
      t.elevationChanged.emit();
    }
  }
  PlateMotionPlate.BoundaryTrackingProperty = BoundaryTrackingProperty;

  class PlateBehavior {
    constructor(plate, otherPlate) {
      Object.assign(this, { plate, otherPlate }); this.magmaBlobs = [];
      this.magmaTarget = null; this.magmaChamber = null; this.magmaSpeed = 0;
      this.rangeLabels = plate.model.rangeLabels;
    }
    afterConstructionInit() {}
    getOtherPlate() { return this.otherPlate; }
    getPlate() { return this.plate; }
    getSide() { return this.plate.side; }
    getOppositeSide() { return this.getSide().opposite(); }
    getNumCrustXSamples() { return this.getCrust().getTopBoundary().samples.length; }
    getNumTerrainXSamples() { return this.getTerrain().getNumColumns(); }
    getTerrain() { return this.plate.terrain; }
    getCrust() { return this.plate.crust; }
    getLithosphere() { return this.plate.lithosphere; }
    getLithosphereRegions() { return [this.getCrust(), this.getLithosphere()]; }
    getTopCrustBoundary() { return this.getCrust().getTopBoundary(); }
    createEarthEdges() {
      while (this.getOppositeSide().isToSideOf(this.getTopCrustBoundary().getEdgeSample(this.getSide()).position.x,
        700000 * this.getSide().getSign())) this.plate.addSection(this.getSide(), this.plate.plateType);
    }
    removeEarthEdges() {
      while (this.getSide().isToSideOf(this.getTopCrustBoundary().getEdgeSample(this.getSide()).position.x,
        700000 * this.getSide().getSign())) this.plate.removeSection(this.getSide());
    }
    moveMantleTopTo(y) {
      for (const s of this.plate.mantle.getTopBoundary().samples) s.shiftWithTexture(new V3(0, y - s.position.y, 0), this.plate.textureStrategy);
      this.redistributeMantle();
    }
    redistributeMantle() {
      const region = this.plate.mantle;
      for (let i = 0; i < region.getTopBoundary().samples.length; i++) {
        const top = region.getTopElevation(i), bottom = region.getBottomElevation(i);
        for (let j = 1; j < region.boundaries.length - 1; j++) {
          const r = j / (region.boundaries.length - 1), s = region.boundaries[j].samples[i];
          // Preserve the Java displacement sign, including this unusual formula.
          s.shiftWithTexture(new V3(0, s.position.y - (top * (1 - r) + bottom * r), 0), this.plate.textureStrategy);
        }
      }
    }
    onMagmaRemoved() {}
    addMagma(position, alpha = 0) {
      const direction = this.magmaTarget.minus(position).normalized();
      const blob = new MagmaRegion(this.plate.textureStrategy, 1000, Math.atan2(direction.y, direction.x), 6, position);
      blob.alpha.set(alpha); this.plate.regions.add(blob); blob.moveToFront();
      this.magmaChamber.moveToFront(); this.magmaBlobs.push(blob); return blob;
    }
    animateMagma(dt) { for (const blob of this.magmaBlobs.slice()) this.animateMagmaBlob(blob, dt, true); }
    animateMagmaBlob(blob, dt, notify) {
      const position = blob.position.get();
      const next = position.plus(this.magmaTarget.minus(position).normalized().times(this.magmaSpeed * dt));
      if (next.y > this.magmaTarget.y) {
        this.plate.regions.remove(blob); this.magmaBlobs.splice(this.magmaBlobs.indexOf(blob), 1);
        blob.position.set(next); if (notify) this.onMagmaRemoved(blob);
      } else {
        if (blob.alpha.get() < 1) blob.alpha.set(Math.min(1, blob.alpha.get() + 0.25 * dt));
        blob.position.set(next);
      }
    }
    static recursiveSplitCall(fn, dt, max) { recursiveSplitCall(fn, dt, max); }
  }

  class CollidingBehavior extends PlateBehavior {
    constructor(plate, other) {
      super(plate, other); this.timeElapsed = 0;
      this.getLithosphere().moveToFront(); this.getCrust().moveToFront();
      plate.model.frontBoundarySideNotifier.emit(plate.side); this.moveMantleTopTo(0);
    }
    timeFormula(t) { return 10 * Math.log(t / 10 + 1); }
    timeModification(dt) { return this.timeFormula(this.timeElapsed) - this.timeFormula(this.timeElapsed - dt); }
    computeNewX(dt, sign, x) {
      dt = this.timeModification(dt);
      const contracted = x * Math.exp(-dt / 30), translation = sign * 30000 / 2 * dt;
      const blend = Math.min(1, Math.abs(x / 600000)) * 0.75;
      return x + (1 - blend) * (contracted - x) + blend * translation;
    }
    stepInTime(dt) {
      this.timeElapsed += dt; this.createEarthEdges();
      const sign = -this.plate.getSign(), top = this.getTopCrustBoundary().samples;
      const xs = top.map(s => s.position.x), nextX = xs.map(x => this.computeNewX(dt, sign, x));
      const ratios = xs.map((x, i) => {
        if (i === 0) return (nextX[1] - nextX[0]) / (xs[1] - xs[0]);
        if (i === xs.length - 1) return (nextX[i] - nextX[i - 1]) / (xs[i] - xs[i - 1]);
        return ((nextX[i] - nextX[i - 1]) / (xs[i] - xs[i - 1]) + (nextX[i + 1] - nextX[i]) / (xs[i + 1] - xs[i])) / 2;
      });
      const crust = this.getCrust(), t = this.getTerrain();
      for (const region of [this.getLithosphere(), crust]) {
        for (let i = 0; i < top.length; i++) {
          const center = (crust.getTopElevation(i) + crust.getBottomElevation(i)) / 2;
          for (const b of region.boundaries) {
            const s = b.samples[i], p = s.position;
            const x = p.x === 0 ? 0 : this.computeNewX(dt, sign, p.x);
            const y = (p.y - center) / ratios[i] + center, dy = y - p.y;
            s.position = p.plus(new V3(x - p.x, dy, 0));
            if (b === crust.getTopBoundary()) { t.xPositions[i] = x; t.shiftColumnElevation(i, dy); }
          }
        }
      }
      for (let i = 0; i < top.length; i++) for (let j = 0; j < t.getNumRows(); j++) {
        const s = t.getSample(i, j), dy = clamp(0, (s.elevation - 6000) / 7000, 1) * s.randomElevationOffset * dt / 5;
        s.elevation += dy;
        if (j === t.getFrontZIndex()) top[i].position = top[i].position.plus(new V3(0, dy, 0));
      }
      if (this.getSide() === Side.RIGHT) for (let j = 0; j < t.getNumRows(); j++) {
        const y = this.otherPlate.terrain.getSample(this.otherPlate.terrain.getNumColumns() - 1, j).elevation;
        t.getSample(0, j).elevation = y; const p = top[0].position; top[0].position = new V3(p.x, y, p.z);
      }
      t.elevationChanged.emit();
    }
  }
  class TransformBehavior extends PlateBehavior {
    constructor(plate, other, towardsFront) {
      super(plate, other); this.towardsFront = towardsFront; this.timeElapsed = 0;
      plate.model.boundaryLabels.remove(plate.model.joiningBoundaryLabel);
    }
    stepInTime(dt) {
      const before = this.timeElapsed; this.timeElapsed += dt;
      this.plate.shiftZ(15000 * (this.towardsFront ? dt : -dt));
      const dy = -(Math.exp(-before * 0.3) - Math.exp(-this.timeElapsed * 0.3)) * 5000;
      this.shiftIndexElevation(0, dy); this.shiftIndexElevation(1, dy / 4); this.shiftIndexElevation(2, -dy / 4);
      this.getTerrain().elevationChanged.emit();
    }
    shiftIndexElevation(index, dy) {
      this.getTerrain().shiftColumnElevation(this.getOppositeSide().getFromIndex(this.getNumTerrainXSamples(), index), dy);
      const s = this.getOppositeSide().getFromEnd(this.getTopCrustBoundary().samples, index);
      s.position = s.position.plus(new V3(0, dy, 0));
    }
  }

  class RiftingBehavior extends PlateBehavior {
    constructor(plate, other) {
      super(plate, other); this.timeElapsed = 0; this.addedLabels = false;
      this.getLithosphere().moveToFront(); this.getCrust().moveToFront();
      plate.model.frontBoundarySideNotifier.emit(plate.side);
      this.moveMantleTopTo(PlateType.OLD_OCEANIC.getCrustTopY() - 1000);
      this.magmaTarget = new V2(0, -500); this.magmaSpeed = 15000;
    }
    onMagmaRemoved(blob) { this.addMagmaBlob(true, blob.position.get().minus(this.magmaTarget).magnitude()); }
    addMagmaBlob(atBottom, overshoot = 0) {
      const angle = Math.PI / 2 + (Math.random() - 0.5) * 0.5;
      const direction = new V2(Math.cos(angle), Math.sin(angle)).negated();
      this.addMagma(new V2(0, -500).plus(direction.times(atBottom ? 100000 - overshoot : Math.random() * 100000)));
    }
    stepInTime(dt) {
      this.timeElapsed += dt;
      this.plate.model.boundaryLabels.remove(this.plate.model.joiningBoundaryLabel);
      this.removeEarthEdges();
      if (this.getSide() === Side.LEFT && this.magmaChamber === null) {
        this.magmaChamber = new MagmaRegion(this.plate.textureStrategy,
          PlateType.YOUNG_OCEANIC.getCrustThickness() / 3, 1.5707964, 16, new V2(0, -500));
        this.plate.regions.add(this.magmaChamber); this.magmaChamber.moveToFront();
        repeat(() => this.addMagmaBlob(false), 50);
      }
      const x = this.getSide().getSign() * 120000;
      this.moveSpreading(dt);
      if (!this.addedLabels && this.timeElapsed > 8.43664) {
        this.addedLabels = true;
        const tracking = boundary => {
          const property = new Property(new V3());
          mortal(this.plate.model.modelChanged, this.plate.disposed, () =>
            property.set(new V3(x, boundary.getApproximateYFromX(x), 0)), true);
          return property;
        };
        this.plate.model.rangeLabels.add(new RangeLabel(tracking(this.getCrust().getTopBoundary()),
          tracking(this.getCrust().getBottomBoundary()), STR.youngOceanicCrust, this.plate));
      }
      if (this.getSide() === Side.LEFT) this.animateMagma(dt);
    }
    moveSpreading(dt) {
      const width = this.plate.getSimpleChunkWidth(), sign = this.plate.getSign();
      let sunk = new Set();
      const dx = 15000 * sign * dt, crust = this.getCrust(), lithosphere = this.getLithosphere(), t = this.getTerrain();
      for (const region of [lithosphere, crust]) for (const s of region.getSamples()) s.position = s.position.plus(new V3(dx, 0, 0));
      for (let i = 0; i < this.getNumCrustXSamples(); i++) {
        const sample = crust.getTopBoundary().samples[i], terrainSample = t.getSample(i, t.getFrontZIndex());
        const x = t.xPositions[i], delta = sample.position.minus(new V3(x, terrainSample.elevation, 0));
        t.shiftColumnElevation(i, delta.y); t.xPositions[i] = x + delta.x;
      }
      const center = this.getSampleFromCenter(crust.getTopBoundary(), 0);
      const neighbor = this.getSampleFromCenter(crust.getTopBoundary(), 1);
      if (Math.abs(neighbor.position.x - center.position.x) < width * 1.001) {
        let newX = neighbor.position.x - width * sign;
        if (newX * sign < 0) newX = 0;
        const i = this.getOppositeSide().getIndex(crust.getTopBoundary().samples);
        this.shiftColumn(i, newX - center.position.x);
        if (newX !== 0 && crust.getTopBoundary().samples[i].density === PlateType.YOUNG_OCEANIC.getDensity()) {
          this.sinkOceanicCrust(Math.abs(newX) / 15000, i); sunk.add(i);
        }
      }
      const side = this.getOppositeSide();
      while (this.getSampleFromCenter(crust.getTopBoundary(), 0).position.x * sign > 1e-4) {
        this.plate.addSection(side, PlateType.YOUNG_OCEANIC);
        if (side === Side.LEFT) sunk = new Set(Array.from(sunk, i => i + 1));
        const i = side.getIndex(crust.getTopBoundary().samples);
        const bottom = -500 - PlateType.YOUNG_OCEANIC.getCrustThickness();
        crust.layoutColumn(i, -500, bottom, this.plate.textureStrategy, true);
        lithosphere.layoutColumn(i, bottom, bottom, this.plate.textureStrategy, true);
        for (const region of this.getLithosphereRegions()) for (const boundary of region.boundaries) {
          const s = boundary.samples[i], tex = this.plate.textureStrategy.mapFront(new V2(s.position.x, s.position.y));
          s.textureCoordinates = new V2(s.textureCoordinates.x, tex.y);
        }
        t.setColumnElevation(i, -500);
        const x = this.getSampleFromCenter(crust.getTopBoundary(), 0).position.x;
        if (x * sign > 0) { this.sinkOceanicCrust(Math.abs(x) / 15000, i); sunk.add(i); }
        else this.shiftColumn(i, -side.getEnd(crust.getTopBoundary().samples).position.x);
      }
      for (let i = 0; i < this.getNumCrustXSamples(); i++) {
        const s = crust.getTopBoundary().samples[i];
        if (s.density === PlateType.YOUNG_OCEANIC.getDensity() && s.position.x !== 0 && !sunk.has(i)) this.sinkOceanicCrust(dt, i);
      }
      recursiveSplitCall(step => {
        for (let i = 0; i < this.getNumCrustXSamples(); i++) {
          const s = crust.getTopBoundary().samples[i];
          if (s.density !== PlateType.CONTINENTAL.getDensity()) continue;
          let average = s.position.y - s.randomTerrainOffset, count = 1;
          if (i > 0) { const neighbor = crust.getTopBoundary().samples[i - 1]; average += neighbor.position.y - neighbor.randomTerrainOffset; count++; }
          if (i < this.getNumCrustXSamples() - 1) { const neighbor = crust.getTopBoundary().samples[i + 1]; average += neighbor.position.y - neighbor.randomTerrainOffset; count++; }
          average = average / count + s.randomTerrainOffset;
          const top = crust.getTopElevation(i), bottom = crust.getBottomElevation(i), lithBottom = lithosphere.getBottomElevation(i);
          const thickness = top - bottom;
          let factor = (thickness - 2 * (top - average)) / thickness;
          if (factor > 1) factor = 1;
          factor = Math.pow(factor, 2 * step);
          const middle = (top + bottom) / 2;
          const newTop = (top - middle) * factor + middle;
          const newBottom = (bottom - middle) * factor * factor + middle;
          const newLithBottom = (lithBottom - middle) * factor * factor + middle;
          crust.layoutColumn(i, newTop, newBottom, this.plate.textureStrategy, true);
          lithosphere.layoutColumn(i, newBottom, newLithBottom, this.plate.textureStrategy, true);
          t.shiftColumnElevation(i, newTop - top);
        }
      }, dt, 0.1);
      t.elevationChanged.emit();
    }
    sinkOceanicCrust(dt, i) {
      const crust = this.getCrust(), lithosphere = this.getLithosphere();
      const initial = -500, target = PlateType.OLD_OCEANIC.getCrustTopY(), top = crust.getTopElevation(i);
      const ratio = (top - initial) / (target - initial);
      const next = Math.atan(Math.tan(ratio * Math.PI / 2) + dt * 4) / (Math.PI / 2);
      const y = (1 - next) * initial + next * target, dy = y - top;
      for (const region of this.getLithosphereRegions()) for (const b of region.boundaries) {
        const s = b.samples[i]; s.position = s.position.plus(new V3(0, dy, 0));
      }
      this.getTerrain().shiftColumnElevation(i, dy);
      const lithTop = lithosphere.getTopElevation(i), lithBottom = lithosphere.getBottomElevation(i);
      const thickness = PlateType.YOUNG_OCEANIC.getMantleLithosphereThickness();
      const fraction = clamp(0, (lithTop - lithBottom) / thickness, 1);
      const newFraction = Math.atan(Math.tan(fraction * Math.PI / 2) + dt) / (Math.PI / 2);
      lithosphere.layoutColumn(i, lithTop, lithTop - thickness * newFraction, this.plate.textureStrategy, true);
    }
    shiftColumn(i, dx) {
      for (const region of this.getLithosphereRegions()) for (const b of region.boundaries)
        b.samples[i].shiftWithTexture(new V3(dx, 0, 0), this.plate.textureStrategy);
      this.getTerrain().shiftColumnXWithTexture(this.plate.textureStrategy, i, dx);
      this.getTerrain().columnsModified.emit();
    }
    getSampleFromCenter(boundary, n) { return boundary.getEdgeSample(this.getOppositeSide(), n); }
  }

  class ColumnResult {
    constructor(crustTop, crustBottom, lithosphereBottom, center) {
      Object.assign(this, { crustTop, crustBottom, lithosphereBottom, lithosphereCenter: center });
    }
  }
  class SubductingBehavior extends PlateBehavior {
    constructor(plate, other) {
      super(plate, other); this.timeElapsed = 0; this.regionToTerrainOffset = 0;
      const type = plate.plateType;
      this.y0 = type.getCrustTopY() - type.getLithosphereThickness() / 2;
      this.m = type.getLithosphereThickness() / 2; this.cb = this.m - type.getCrustThickness();
      this.totalAngle = Math.PI / 4 * (type === PlateType.OLD_OCEANIC ? 1.2 : 0.8);
      this.theta0 = this.totalAngle * 0.25; this.theta1 = this.totalAngle * 0.5; this.theta2 = this.totalAngle * 0.25;
      this.radius0 = 90000; this.radius1 = 40000; this.radius2 = 90000;
      this.t0 = 0; this.t1 = this.theta0 * 90000;
      this.t2 = this.t1 + this.theta1 * 40000; this.t3 = this.t2 + this.theta2 * 90000;
      this.center0 = new V2(0, this.y0 - 90000);
      this.center1 = this.p1(this.t1).plus(this.center0.minus(this.p1(this.t1)).normalized().times(40000));
      this.center2 = this.p2(this.t2).plus(this.center1.minus(this.p2(this.t2)).normalized().times(90000));
      this.dir4 = SubductingBehavior.vectorFromAngle(this.totalAngle + Math.PI); this.p3oft3 = this.p3(this.t3);
    }
    afterConstructionInit() {
      this.getLithosphere().moveToFront(); this.getCrust().moveToFront();
      this.plate.model.frontBoundarySideNotifier.emit(this.getSide());
    }
    stepInTime(dt) {
      this.timeElapsed += dt; this.createEarthEdges();
      const columns = Array.from({ length: this.getNumCrustXSamples() }, (_, i) =>
        this.computeSubductingPosition(this.getT(i), new V2(this.getOffsetSize(), 0)));
      const t = this.getTerrain();
      for (let i = 0; i < columns.length; i++) {
        const j = i + this.regionToTerrainOffset;
        if (j < 0 || j >= this.getNumTerrainXSamples()) continue;
        const p = this.getTopCrustBoundary().samples[i].position, next = columns[i].crustTop;
        t.xPositions[j] = next.x; t.shiftColumnElevation(j, next.y - p.y);
      }
      while (this.getOppositeSide().isToSideOf(t.xPositions[this.getCenterTerrainIndex(0)], 0)) {
        if (this.getOppositeSide().isToSideOf(t.xPositions[this.getCenterTerrainIndex(1)], 0)) {
          t.removeColumn(this.getOppositeSide()); if (this.getSide() === Side.RIGHT) this.regionToTerrainOffset--;
        } else {
          const i = this.getCenterTerrainIndex(0);
          t.shiftColumnXWithTexture(this.plate.textureStrategy, i, -t.xPositions[i]); break;
        }
      }
      for (const region of this.getLithosphereRegions()) {
        const crust = region === this.getCrust();
        for (let i = 0; i < columns.length; i++) {
          const top = crust ? columns[i].crustTop : columns[i].crustBottom;
          const bottom = crust ? columns[i].crustBottom : columns[i].lithosphereBottom;
          region.boundaries.forEach((b, j) => {
            const r = j / (region.boundaries.length - 1), s = b.samples[i];
            s.position = new V3((1 - r) * top.x + r * bottom.x, (1 - r) * top.y + r * bottom.y, s.position.z);
            if (s.position.y < -150000) {
              const blend = 1 - Math.exp(-dt * 0.08);
              s.density = s.density * (1 - blend) + 3300 * blend;
              s.temperature = s.temperature * (1 - blend) + TEMPS.SIMPLE_MANTLE_BOTTOM_TEMP * blend;
            }
          });
        }
      }
      t.setColumnElevation(this.getOppositeSide().getIndex(this.getNumTerrainXSamples()), this.getBoundaryElevation());
      t.elevationChanged.emit();
    }
    getLowestMeltingLocation() {
      let y = Number.MAX_VALUE, point = null;
      for (const s of this.getTopCrustBoundary().samples) if (s.position.y < -110000 && s.position.y > -150000 && s.position.y < y) {
        y = s.position.y; point = new V2(s.position.x, s.position.y);
      }
      return point;
    }
    getHighestMeltingLocation() {
      let y = -Number.MAX_VALUE, point = null;
      for (const s of this.getTopCrustBoundary().samples) if (s.position.y < -100000 && s.position.y > -150000 && s.position.y > y) {
        y = s.position.y; point = new V2(s.position.x, s.position.y);
      }
      return point;
    }
    getCenterTerrainIndex(n) { return this.getOppositeSide().getFromIndex(this.getNumTerrainXSamples(), n); }
    getBoundaryElevation() {
      let previous = null;
      for (const s of this.getTopCrustBoundary().samples) {
        if (s.position.x === 0) return s.position.y;
        if (previous && s.position.x * previous.position.x < 0)
          return SubductingBehavior.yInterceptAtX0BetweenPoints(s.position, previous.position);
        previous = s;
      }
      return this.getOppositeSide().getEnd(this.getTopCrustBoundary().samples).position.y;
    }
    static yInterceptAtX0BetweenPoints(a, b) { return a.y - a.x * (b.y - a.y) / (b.x - a.x); }
    getT(i) {
      const width = this.plate.getSimpleChunkWidth();
      return width * (this.getSide() === Side.LEFT ? -(this.getNumCrustXSamples() - 1 - i) : -i)
        + this.timeElapsed * 15000 + this.getOffsetSize();
    }
    getOffsetSize() {
      const value = this.timeElapsed * 15000 * 0.4 * (this.plate.plateType === PlateType.OLD_OCEANIC ? 1.7 : 1);
      if (value > 32000) return 32000;
      const r = value / 32000; return (-r * r + 2 * r) * 32000;
    }
    p0(t) { return new V2(-t, this.y0); }
    pd0() { return new V2(-1, 0); }
    p1(t) { return this.center0.plus(SubductingBehavior.vectorFromAngle(Math.PI / 2 + t / 90000).times(90000)); }
    pd1(t) { return SubductingBehavior.bottomFromTangent(this.p1(t).minus(this.center0).normalized()); }
    p2(t) { return this.center1.plus(SubductingBehavior.vectorFromAngle(Math.PI / 2 + this.theta0 + (t - this.t1) / 40000).times(40000)); }
    pd2(t) { return SubductingBehavior.bottomFromTangent(this.p2(t).minus(this.center1).normalized()); }
    p3(t) { return this.center2.plus(SubductingBehavior.vectorFromAngle(Math.PI / 2 + this.theta0 + this.theta1 + (t - this.t2) / 90000).times(90000)); }
    pd3(t) { return SubductingBehavior.bottomFromTangent(this.p3(t).minus(this.center2).normalized()); }
    p4(t) { return this.p3oft3.plus(this.dir4.times(t - this.t3)); }
    pd4() { return this.dir4; }
    computeSubductingPosition(t, offset) {
      const segment = t < 0 ? 0 : t < this.t1 ? 1 : t < this.t2 ? 2 : t < this.t3 ? 3 : 4;
      let position = this['p' + segment](t), normal = SubductingBehavior.topFromTangent(this['pd' + segment](t));
      position = position.plus(offset);
      if (this.getSide() === Side.LEFT) { position = new V2(-position.x, position.y); normal = new V2(-normal.x, normal.y); }
      return new ColumnResult(position.plus(normal.times(this.m)), position.plus(normal.times(this.cb)), position.plus(normal.times(-this.m)), position);
    }
    static topFromTangent(v) { return new V2(v.y, -v.x); }
    static bottomFromTangent(v) { return SubductingBehavior.topFromTangent(v).negated(); }
    static vectorFromAngle(angle) { return new V2(Math.cos(angle), Math.sin(angle)); }
  }
  SubductingBehavior.ColumnResult = ColumnResult;

  class OverridingBehavior extends PlateBehavior {
    constructor(plate, other) {
      super(plate, other); this.chamberFullness = 0; this.timeElapsed = 0; this.magmaTube = null;
      this.getLithosphere().moveToFront(); this.getCrust().moveToFront();
      plate.model.frontBoundarySideNotifier.emit(plate.side);
      this.magmaCenterX = this.getSide().getSign() * (other.plateType === PlateType.YOUNG_OCEANIC ? 162105.25 : 103157.875);
      this.magmaTarget = this.getMagmaChamberTop(); this.magmaSpeed = 10000;
      this.fakeUnderSubductionSample = new Sample(this.getFakeSubductionSamplePosition(), 0, 0, new V2());
      const sample = this.getLithosphere().getBottomBoundary().getEdgeSample(this.getOppositeSide());
      plate.model.joiningBoundaryLabel.getBoundary().replaceSample(sample, this.fakeUnderSubductionSample);
    }
    getFakeSubductionSamplePosition() {
      const y = this.getLithosphere().getBottomBoundary().getEdgeSample(this.getOppositeSide()).position.y;
      const p = this.otherPlate.lithosphere.getBottomBoundary().getEdgeSample(this.getSide()).position;
      return p.y < y ? p : new V3(p.x, y, p.z);
    }
    getMagmaChamberScale() { return this.plate.plateType.getCrustThickness() / (this.plate.plateType.isOceanic() ? 3 : 6); }
    getSubductingBehavior() { return this.otherPlate.behavior; }
    stepInTime(dt) {
      this.timeElapsed += dt;
      const ts = this.plate.textureStrategy, crust = this.getCrust(), t = this.getTerrain();
      if (this.magmaChamber === null) {
        this.magmaChamber = new MagmaRegion(ts, this.getMagmaChamberScale(), 1.5707964, 16, this.getMagmaChamberTop());
        this.plate.regions.add(this.magmaChamber); this.magmaChamber.moveToFront(); this.magmaChamber.setAllAlphas(0);
        this.magmaTube = new Region(1, 2, (b, i) => {
          const x = this.magmaCenterX + (i === 0 ? -0.5 : 0.5) * 1000, y = this.getMagmaChamberTop().y - 500;
          return new Sample(new V3(x, y, 0), TEMPS.SIMPLE_MAGMA_TEMP, 2000, ts.mapFront(new V2(x, y)));
        });
        this.plate.regions.add(this.magmaTube); this.magmaTube.moveToFront(); this.magmaTube.setAllAlphas(0);
      }
      this.animateMagma(dt);
      if (this.areMountainsRisingYet()) this.animateMountains(dt);
      const boundaryY = this.getSubductingBehavior().getBoundaryElevation();
      const edge = this.getTopCrustBoundary().getEdgeSample(this.getOppositeSide()), oldY = edge.position.y;
      const dy = (boundaryY - oldY) * (1 - Math.exp(-dt));
      const index = this.getOppositeSide().getIndex(this.getNumCrustXSamples());
      crust.layoutColumn(index, oldY + dy, crust.getBottomElevation(index) + dy, ts, true);
      t.shiftColumnElevation(index, dy);
      recursiveSplitCall(step => {
        for (let i = 0; i < this.getNumCrustXSamples(); i++) {
          const s = this.getTopCrustBoundary().samples[i];
          let average = s.position.y, count = 1;
          if (i > 0) { average += this.getTopCrustBoundary().samples[i - 1].position.y; count++; }
          if (i < this.getNumCrustXSamples() - 1) { average += this.getTopCrustBoundary().samples[i + 1].position.y; count++; }
          average /= count;
          const top = crust.getTopElevation(i), bottom = crust.getBottomElevation(i), thickness = top - bottom;
          let factor = (thickness - 2 * (top - average)) / thickness;
          if (factor > 1) factor = 1;
          const weight = Math.min(1, Math.abs(s.position.x) / 50000);
          factor = Math.pow(weight + (1 - weight) * factor, step);
          const center = (top + bottom) / 2, newTop = (top - center) * factor + center;
          crust.layoutColumn(i, newTop, bottom + (newTop - top), ts, true);
          t.shiftColumnElevation(i, newTop - top);
        }
      }, dt, 0.1);
      t.elevationChanged.emit();
      const lowMeltPoint = this.getSubductingBehavior().getLowestMeltingLocation();
      const highMeltPoint = this.getSubductingBehavior().getHighestMeltingLocation();
      if (lowMeltPoint !== null && highMeltPoint !== null) {
        repeat(() => {
          const position = lowMeltPoint.plus(highMeltPoint.minus(lowMeltPoint).times(Math.random()));
          const blob = this.addMagma(position, 0.7);
          this.animateMagmaBlob(blob, Math.random() * dt, false);
        }, this.samplePoisson(dt * 1e-4 * lowMeltPoint.distance(highMeltPoint)));
      }
      this.minElevationInTimestep = Number.MAX_VALUE; this.maxElevationInTimestep = -Number.MAX_VALUE;
      for (const s of this.getTopCrustBoundary().samples) {
        this.minElevationInTimestep = Math.min(this.minElevationInTimestep, s.position.y);
        this.maxElevationInTimestep = Math.max(this.maxElevationInTimestep, s.position.y);
      }
      if (this.areMountainsRisingYet()) {
        for (const puff of Array.from(this.plate.model.smokePuffs)) this.agePuff(dt, puff);
        // Twelve vents: the Java sequence repeats its three x offsets every 62831.85 m.
        for (let i = 0; i < 12; i++) {
          const x = this.magmaCenterX + (i % 3 === 0 ? 0 : this.plate.getSign() * 10000 * (i % 3 === 1 ? -1 : 1));
          const y = this.maxElevationInTimestep - (i === 0 ? 0 : Math.ceil(i / 3) * 2000);
          this.createSmokeAt(new V3(x, y, -i * 62831.85), dt);
        }
      }
      this.magmaTube.setAllAlphas(this.areMountainsRisingYet() ? 1 : this.getChamberFullness());
      if (this.areMountainsRisingYet()) {
        const dy = this.maxElevationInTimestep - 250 - this.magmaTube.getTopElevation(0);
        for (const s of this.magmaTube.getTopBoundary().samples) {
          s.position = s.position.plus(new V3(0, dy, 0));
          s.textureCoordinates = s.textureCoordinates.plus(ts.mapFrontDelta(new V2(0, dy)));
        }
        for (const s of this.magmaTube.getSamples()) s.textureCoordinates = s.textureCoordinates.plus(ts.mapFrontDelta(new V2(0, -10000 * dt)));
      }
      const label = this.plate.getBoundaryLabel(), property = this.getSide() === Side.LEFT ? label.maxX : label.minX;
      let x = this.otherPlate.lithosphere.getBottomBoundary().getEdgeSample(this.getSide()).position.x;
      if (Math.abs(x) > 55000) x = Math.sign(x) * 55000;
      property.set(x); this.fakeUnderSubductionSample.position = this.getFakeSubductionSamplePosition();
    }
    agePuff(dt, puff) {
      puff.age += dt;
      const alpha = -puff.age * puff.age / 4 + puff.age;
      if (alpha < 0) this.plate.model.smokePuffs.remove(puff);
      else {
        puff.scale.set(Math.sqrt(puff.age)); puff.alpha.set(alpha / 15);
        let count = 0, rx = 0, ry = 0;
        recursiveSplitCall(() => { count++; rx += Math.random(); ry += Math.random(); }, dt, 0.1);
        const noise = new V3((rx / count - 0.5) * 800, (ry / count - 0.5) * 100, 0).times(dt * 15);
        puff.position.set(puff.position.get().plus(new V3(0, dt * 2000, 0).plus(noise)));
      }
    }
    samplePoisson(mean) {
      const threshold = Math.exp(-mean); let n = 0, product = 1;
      do { n++; product *= Math.random(); } while (product > threshold);
      return n - 1;
    }
    getChamberFullness() {
      const young = this.otherPlate.plateType === PlateType.YOUNG_OCEANIC;
      const start = young ? 22 : 18.5; let end = young ? 26.5 : 24;
      if (this.plate.plateType.isOceanic()) end = (end - start) / 5 + start;
      if (this.timeElapsed < start) return 0;
      if (this.timeElapsed > end) return 1;
      return (this.timeElapsed - start) / (end - start);
    }
    areMountainsRisingYet() { return this.timeElapsed >= (this.otherPlate.plateType === PlateType.YOUNG_OCEANIC ? 26.5 : 24); }
    createSmokeAt(position, dt) {
      if (this.maxElevationInTimestep < 0) return;
      repeat(() => {
        const puff = new SmokePuff(); puff.position.set(position); puff.scale.set(0.1); puff.alpha.set(0);
        this.plate.model.smokePuffs.add(puff); this.agePuff(Math.random() * dt, puff);
      }, this.samplePoisson(dt * 8));
    }
    animateMountains(dt) {
      const t = this.getTerrain(), crust = this.getCrust(), lithosphere = this.getLithosphere();
      for (let i = 0; i < this.getNumTerrainXSamples(); i++) {
        const x = t.xPositions[i];
        for (let j = 0; j < t.getNumRows(); j++) {
          const z = t.zPositions[j] / 10000, weight = (Math.cos(z) + 1) / 2;
          const n = Math.trunc(Math.abs(z / Math.PI) + 0.5) % 3;
          const shiftedX = x + (n === 0 ? 0 : -this.plate.getSign() * 10000 * (n === 1 ? 1 : -1));
          const rise = Math.exp(-Math.abs(shiftedX - this.magmaCenterX) / 10000) * 400 * dt;
          const root = Math.exp(-Math.abs(shiftedX - this.magmaCenterX) / 30000) * 500 * dt;
          const dy = rise * weight * weight * weight;
          t.getSample(i, j).elevation += dy;
          if (j === t.getFrontZIndex()) {
            const top = crust.getTopElevation(i) + dy, bottom = crust.getBottomElevation(i) - root;
            const lithBottom = lithosphere.getBottomElevation(i) - root * 2;
            crust.layoutColumn(i, top, bottom, this.plate.textureStrategy, true);
            lithosphere.layoutColumn(i, bottom, lithBottom, this.plate.textureStrategy, true);
          }
        }
      }
    }
    getMagmaChamberTop() { return new V2(this.magmaCenterX, this.plate.plateType.getCrustTopY()); }
    onMagmaRemoved() {
      this.chamberFullness = Math.min(1, this.chamberFullness + (this.plate.plateType.isContinental() ? 0.05 : 0.25));
      this.magmaChamber.setAllAlphas(this.getChamberFullness());
    }
  }

  class PlateMotionModel extends PT.PlateTectonicsModel {
    constructor(clock, bounds) {
      super(bounds, new TextureStrategy(6e-6)); this.clock = clock;
      this.leftPlate = null; this.rightPlate = null; this.terrainConnector = null;
      this.transformMotionCCW = true; this.joiningBoundaryLabel = null;
      for (const key of ['rangeLabels', 'boundaryLabels', 'textLabels', 'smokePuffs']) this[key] = new ObservableList();
      this.frontBoundarySideNotifier = new Emitter();
      this.leftPlateType = new Property(null); this.rightPlateType = new Property(null);
      this.motionType = new Property(null); this.motionTypeIfStarted = new Property(MotionType.CONVERGENT);
      this.animationStarted = new Property(false); this.hasBothPlates = new Property(false); this.hasAnyPlates = new Property(false);
      const updatePresence = () => {
        this.hasBothPlates.set(this.hasLeftPlate() && this.hasRightPlate());
        this.hasAnyPlates.set(this.hasLeftPlate() || this.hasRightPlate());
      };
      this.leftPlateType.addObserver(updatePresence); this.rightPlateType.addObserver(updatePresence);
      this.resetPlates(); this.resetTerrain(); this.updateTerrain(); this.updateStrips();
      for (const labels of [this.rangeLabels, this.textLabels, this.boundaryLabels]) labels.removed.add(label => label.disposed.emit(label));
      this.animationStarted.addObserver(started => { if (started) this.initializeBehaviors(); });
      this.hasBothPlates.addObserver(both => {
        this.motionTypeIfStarted.set(this.allowsConvergentMotion() ? MotionType.CONVERGENT : this.allowsDivergentMotion() ? MotionType.DIVERGENT : MotionType.TRANSFORM);
        if (both) { this.addMantleLabel(); this.addJoinedBoundary(); }
      });
    }
    getCenterX() { return (this.bounds.minX + this.bounds.maxX) / 2; }
    addMantleLabel() {
      if (!this.hasBothPlates.get()) return;
      const position = new Property(new V3(0, -180000, 0)), label = new TextLabel(position, STR.mantle);
      this.textLabels.add(label);
      if (this.leftPlate.behavior instanceof CollidingBehavior) {
        const sample = this.leftPlate.lithosphere.getBottomBoundary().getEdgeSample(Side.RIGHT);
        const offset = -180000 - sample.position.y;
        mortal(this.modelChanged, label.disposed, () => position.set(new V3(0, offset + sample.position.y, 0)));
      }
    }
    initializeBehaviors() {
      const left = this.leftPlate, right = this.rightPlate, lt = this.leftPlateType.get(), rt = this.rightPlateType.get();
      switch (this.motionType.get()) {
        case MotionType.TRANSFORM:
          this.clock.setTimeLimit(25);
          left.setBehavior(new TransformBehavior(left, right, this.isTransformMotionCCW()));
          right.setBehavior(new TransformBehavior(right, left, !this.isTransformMotionCCW()));
          left.addMiddleSide(right); right.addMiddleSide(left); break;
        case MotionType.CONVERGENT:
          if (lt === PlateType.CONTINENTAL && rt === PlateType.CONTINENTAL) {
            this.clock.setTimeLimit(35); left.setBehavior(new CollidingBehavior(left, right)); right.setBehavior(new CollidingBehavior(right, left));
          } else if (lt.isContinental() || rt === PlateType.OLD_OCEANIC) {
            this.clock.setTimeLimit(50); left.setBehavior(new OverridingBehavior(left, right)); right.setBehavior(new SubductingBehavior(right, left));
            right.crust.moveToFront(); this.frontBoundarySideNotifier.emit(Side.RIGHT);
          } else if (rt.isContinental() || lt === PlateType.OLD_OCEANIC) {
            this.clock.setTimeLimit(50); left.setBehavior(new SubductingBehavior(left, right)); right.setBehavior(new OverridingBehavior(right, left));
            left.crust.moveToFront(); this.frontBoundarySideNotifier.emit(Side.LEFT);
          } else throw new Error('behavior type not supported: ' + lt + ', ' + rt);
          break;
        case MotionType.DIVERGENT:
          this.clock.setTimeLimit(35); left.setBehavior(new RiftingBehavior(left, right)); right.setBehavior(new RiftingBehavior(right, left)); break;
        default: throw new Error('Motion type must be selected before initializing behaviors');
      }
      left.behavior.afterConstructionInit(); right.behavior.afterConstructionInit();
      this.textLabels.clear();
      if (this.motionType.get() !== MotionType.TRANSFORM) this.addMantleLabel();
    }
    addJoinedBoundary() {
      const boundary = new Boundary();
      boundary.addSample(Side.LEFT, this.leftPlate.lithosphere.getBottomBoundary().getEdgeSample(Side.RIGHT));
      boundary.addSample(Side.RIGHT, this.rightPlate.lithosphere.getBottomBoundary().getEdgeSample(Side.LEFT));
      this.joiningBoundaryLabel = new BoundaryLabel(boundary, Side.LEFT); this.boundaryLabels.add(this.joiningBoundaryLabel);
    }
    resetPlates() {
      if (this.leftPlate !== null) this.removePlate(this.leftPlate);
      this.leftPlate = new PlateMotionPlate(this, this.textureStrategy, Side.LEFT);
      if (this.rightPlate !== null) this.removePlate(this.rightPlate);
      this.rightPlate = new PlateMotionPlate(this, this.textureStrategy, Side.RIGHT);
      this.addPlate(this.leftPlate); this.addPlate(this.rightPlate);
    }
    resetTerrain() {
      if (this.terrainConnector !== null) this.removeTerrain(this.terrainConnector);
      this.terrainConnector = new TerrainConnectorStrip(this.leftPlate.terrain, this.rightPlate.terrain, 3, this.bounds.minZ, this.bounds.maxZ);
      this.addTerrain(this.terrainConnector);
    }
    rewind() {
      this.joiningBoundaryLabel = null; this.resetPlates(); this.resetTerrain();
      this.rangeLabels.clear(); this.boundaryLabels.clear(); this.textLabels.clear();
      this.dropCrust(Side.LEFT, this.leftPlateType.get()); this.dropCrust(Side.RIGHT, this.rightPlateType.get());
      this.addJoinedBoundary(); this.initializeBehaviors(); this.smokePuffs.clear();
    }
    newCrust() { this.resetEverythingExceptTime(); }
    resetEverythingExceptTime() {
      super.resetAll(); this.joiningBoundaryLabel = null;
      this.leftPlateType.reset(); this.rightPlateType.reset(); this.resetPlates(); this.resetTerrain();
      this.motionType.reset(); this.motionTypeIfStarted.reset(); this.animationStarted.reset();
      this.updateStrips(); this.updateTerrain(); this.modelChanged.emit();
      this.smokePuffs.clear(); this.rangeLabels.clear(); this.boundaryLabels.clear(); this.textLabels.clear();
    }
    resetAll() { this.clock.resetTimeLimit(); this.clock.setTimeMultiplier(1); this.resetEverythingExceptTime(); }
    getStartingX(side, i) {
      return side === Side.LEFT ? this.bounds.minX + (this.getCenterX() - this.bounds.minX) * i / 95
        : this.getCenterX() + (this.bounds.maxX - this.getCenterX()) * i / 95;
    }
    dropCrust(side, type) {
      const plate = this.getPlate(side); plate.droppedCrust(type); this.getPlateTypeProperty(side).set(type);
      this.updateStrips(); plate.fullSyncTerrain(); plate.randomizeTerrain(); this.updateTerrain(); this.updateStrips(); this.modelChanged.emit();
    }
    updateStrips() { for (const strip of this.getCrossSectionStrips()) strip.update(); }
    updateTerrain() { this.terrainConnector.update(); }
    getPlateTypeProperty(side) { return side === Side.LEFT ? this.leftPlateType : this.rightPlateType; }
    getPlateType(side) { return this.getPlateTypeProperty(side).get(); }
    getPlate(side) { return side === Side.LEFT ? this.leftPlate : this.rightPlate; }
    hasPlate(side) { return this.getPlateType(side) !== null; }
    hasLeftPlate() { return this.hasPlate(Side.LEFT); }
    hasRightPlate() { return this.hasPlate(Side.RIGHT); }
    update(dt) {
      super.update(dt);
      if (this.hasLeftPlate() && this.hasRightPlate()) {
        if (this.motionType.get() === null) { this.setTransformMotionCCW(false); this.motionType.set(this.motionTypeIfStarted.get()); }
        this.animationStarted.set(true);
        this.leftPlate.behavior.stepInTime(dt); this.rightPlate.behavior.stepInTime(dt);
        this.updateStrips(); this.updateTerrain();
      }
      this.modelChanged.emit();
    }
    getDensity(x, y) {
      const hit = this.firstStripIntersection(x, y);
      return hit !== null ? hit.density : y < 0 ? PT.PlateTectonicsModel.getWaterDensity(y) : PT.PlateTectonicsModel.getAirDensity(y);
    }
    getTemperature(x, y) {
      const hit = this.firstStripIntersection(x, y);
      return hit !== null ? hit.temperature : y < 0 ? PT.PlateTectonicsModel.getWaterTemperature(y) : PT.PlateTectonicsModel.getAirTemperature(y);
    }
    getLeftDropAreaBounds() { return { minX: this.bounds.minX, maxX: this.getCenterX(), minY: -10000, maxY: 15000, minZ: this.bounds.minZ, maxZ: this.bounds.maxZ }; }
    getRightDropAreaBounds() { return { minX: this.getCenterX(), maxX: this.bounds.maxX, minY: -10000, maxY: 15000, minZ: this.bounds.minZ, maxZ: this.bounds.maxZ }; }
    allowsDivergentMotion() { return this.hasBothPlates.get() && this.leftPlateType.get().isContinental() === this.rightPlateType.get().isContinental(); }
    allowsTransformMotion() { return this.allowsDivergentMotion(); }
    allowsConvergentMotion() { return this.hasBothPlates.get() && (this.leftPlateType.get() !== this.rightPlateType.get() || this.leftPlateType.get().isContinental() && this.rightPlateType.get().isContinental()); }
    isTransformMotionCCW() { return this.transformMotionCCW; }
    setTransformMotionCCW(value) { this.transformMotionCCW = value; }
    getStripsInOrder() { return this.renderOrder.slice().reverse(); }
  }
  Object.assign(PlateMotionModel, TEMPS, { MotionType });
  Object.assign(PT, { MotionType, TectonicsClock, SmokePuff, RangeLabel, BoundaryLabel, TextLabel,
    PlateBehavior, CollidingBehavior, OverridingBehavior, RiftingBehavior, SubductingBehavior,
    TransformBehavior, PlateMotionPlate, PlateMotionModel });
})();
