// Run with: node html5/test/plate-motion.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.window = global;
for (const name of ['core.js', 'plate-motion-model.js']) {
  const file = path.join(__dirname, '..', 'js', name);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}
const { PlateMotionModel, TectonicsClock, PlateType, Side, MotionType, JavaRandom } = PT;
// Reproducible coverage of the Java model's otherwise unseeded magma/smoke paths.
const random = new JavaRandom(314159);
const originalRandom = Math.random;
Math.random = () => random.nextFloat();
// PlateMotionTab's original model bounds.
const bounds = { minX: -700000, maxX: 700000, minY: -300000, maxY: 15000, minZ: -1000000, maxZ: 0 };
const points = [[0, -50000], [-300000, -20000], [300000, -200000], [0, 1000]];
let steps = 0, scenarios = 0;

function finite(value, label) { assert(Number.isFinite(value), `${label}: ${value}`); }
function vector(v, label) { finite(v.x, label + '.x'); finite(v.y, label + '.y'); if ('z' in v) finite(v.z, label + '.z'); }
function check(model) {
  for (const region of model.getRegions()) for (const boundary of region.boundaries) for (const sample of boundary.samples) {
    vector(sample.position, 'sample.position'); vector(sample.textureCoordinates, 'sample.textureCoordinates');
    finite(sample.temperature, 'sample.temperature'); finite(sample.density, 'sample.density');
  }
  for (const terrain of model.getTerrains()) {
    assert.equal(terrain.xPositions.length, terrain.samples.length);
    for (const x of terrain.xPositions) finite(x, 'terrain.x');
    for (const z of terrain.zPositions) finite(z, 'terrain.z');
    for (const column of terrain.samples) for (const sample of column) {
      finite(sample.elevation, 'terrain.elevation'); vector(sample.textureCoordinates, 'terrain.textureCoordinates');
    }
  }
  for (const label of model.rangeLabels) { vector(label.top.get(), 'label.top'); vector(label.bottom.get(), 'label.bottom'); }
  for (const label of model.textLabels) vector(label.centerPosition.get(), 'label.center');
  for (const puff of model.smokePuffs) {
    vector(puff.position.get(), 'puff.position'); finite(puff.age, 'puff.age'); finite(puff.scale.get(), 'puff.scale'); finite(puff.alpha.get(), 'puff.alpha');
  }
}
function checkMeters(model) {
  for (const [x, y] of points) {
    finite(model.getDensity(x, y), 'density'); finite(model.getTemperature(x, y), 'temperature');
  }
}

function testClock() {
  const clock = new TectonicsClock(2), events = [];
  for (const name of ['ticked', 'timeChanged', 'started', 'paused', 'timeReset']) clock[name].add(dt => events.push([name, dt]));
  clock.stepByWallSeconds(1); assert.equal(clock.getSimulationTime(), 0);
  clock.start(); clock.stepByWallSeconds(1);
  assert.equal(clock.getSimulationTime(), 2); assert.equal(clock.getSimulationTimeChange(), 2);
  assert.equal(clock.isRunning(), true); assert.equal(clock.isPaused(), false);
  assert.deepEqual(events, [['started', undefined], ['timeChanged', 2], ['ticked', 2]]);
  clock.setTimeLimit(3); clock.stepByWallSeconds(1);
  assert.equal(clock.getSimulationTime(), 3); assert.equal(clock.getSimulationTimeChange(), 1);
  const length = events.length; clock.stepByWallSeconds(1); assert.equal(events.length, length);
  clock.pause(); clock.resetSimulationTime(); assert.equal(clock.getSimulationTime(), 0);
  assert.equal(events.at(-1)[0], 'timeReset');
  clock.stepClockWhilePaused(); assert.equal(clock.getSimulationTime(), 3);
  clock.resetSimulationTime(); clock.resetTimeLimit(); clock.setTimeMultiplier(0.5);
  assert.equal(clock.getTimeMultiplier(), 0.5);
  clock.stepByWallSecondsForced(2); assert.equal(clock.getSimulationTime(), 1);
  clock.setSimulationTime(8); assert.equal(clock.getSimulationTimeChange(), 7);
}

try {
  testClock();
  for (const left of Object.values(PlateType)) for (const right of Object.values(PlateType)) {
    for (const motion of Object.values(MotionType)) {
      const clock = new TectonicsClock(1), model = new PlateMotionModel(clock, bounds);
      model.dropCrust(Side.LEFT, left); model.dropCrust(Side.RIGHT, right);
      const allowed = motion === MotionType.CONVERGENT ? model.allowsConvergentMotion()
        : motion === MotionType.DIVERGENT ? model.allowsDivergentMotion() : model.allowsTransformMotion();
      const expectedAllowed = motion === MotionType.CONVERGENT
        ? left !== right || left.isContinental() && right.isContinental()
        : left.isContinental() === right.isContinental();
      assert.equal(allowed, expectedAllowed, 'Java motion compatibility rules');
      if (!allowed) continue;
      const name = `${left.name}/${right.name}/${motion.name}`;
      assert.equal(model.hasBothPlates.get(), true); assert.equal(model.hasAnyPlates.get(), true);
      assert.equal(model.rangeLabels.length, 4);
      // Exercise both public ways of selecting the first motion.
      if (scenarios % 2) model.motionType.set(motion); else model.motionTypeIfStarted.set(motion);
      const expectedLimit = motion === MotionType.TRANSFORM ? 25
        : motion === MotionType.CONVERGENT && !(left.isContinental() && right.isContinental()) ? 50 : 35;
      let emittedSteps = 0;
      clock.ticked.add(dt => {
        assert(dt >= 0 && dt <= 0.10000001);
        model.update(dt); check(model); emittedSteps++; steps++;
        if (emittedSteps % 50 === 0) checkMeters(model);
      });
      check(model); checkMeters(model); clock.start();
      // The first clock tick initializes the model's Java time limit.
      while (clock.getSimulationTime() < expectedLimit) clock.stepByWallSeconds(0.1);
      assert.equal(clock.getTimeLimit(), expectedLimit);
      const before = emittedSteps; clock.stepByWallSeconds(0.1); assert.equal(emittedSteps, before);
      assert.equal(model.motionType.get(), motion); checkMeters(model);
      if (motion === MotionType.DIVERGENT) {
        assert.equal(model.rangeLabels.length, 6, 'young oceanic crust labels added after 8.43664 My');
        for (const side of [Side.LEFT, Side.RIGHT]) assert(model.getPlate(side).getCrust().getTopBoundary().samples.some(s => s.position.x === 0));
      }
      if (motion === MotionType.TRANSFORM) assert.equal(model.textLabels.length, 0);
      const listeners = model.modelChanged.listeners.length;
      for (let i = 0; i < 2; i++) {
        model.rewind(); check(model); checkMeters(model);
        model.update(0.1); check(model); steps++;
      }
      assert(model.modelChanged.listeners.length <= listeners, 'rewind removes disposed observers');
      const order = model.getStripsInOrder(); assert.deepEqual(order, model.renderOrder.slice().reverse());
      order.pop(); assert.notEqual(order.length, model.renderOrder.length);
      const time = clock.getSimulationTime(); model.newCrust(); check(model); checkMeters(model);
      assert.equal(clock.getSimulationTime(), time);
      assert.equal(model.hasBothPlates.get(), false); assert.equal(model.hasAnyPlates.get(), false);
      assert.equal(model.animationStarted.get(), false); assert.equal(model.motionType.get(), null);
      assert.equal(model.rangeLabels.length + model.boundaryLabels.length + model.textLabels.length + model.smokePuffs.length, 0);
      assert.equal(model.modelChanged.listeners.length, 0);
      model.dropCrust(Side.LEFT, left); model.dropCrust(Side.RIGHT, right);
      model.motionTypeIfStarted.set(motion); model.update(0.1); check(model); steps++;
      model.resetAll(); check(model); checkMeters(model);
      assert.equal(clock.getTimeLimit(), Number.MAX_VALUE); assert.equal(clock.getTimeMultiplier(), 1);
      assert.equal(model.modelChanged.listeners.length, 0);
      scenarios++; console.log(`PASS ${name} (${expectedLimit} My)`);
    }
  }
  assert.equal(scenarios, 17);
  console.log(`PASS: ${scenarios} plate/motion combinations, ${steps} checked updates; clock, meters, rewind, newCrust, resetAll.`);
} finally { Math.random = originalRandom; }
