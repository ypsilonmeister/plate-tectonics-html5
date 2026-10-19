// Runs the HTML5 port's models through exactly the same steps as JavaDump.java and
// writes the same JSON shape.   node js-dump.js > js.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
global.window = global;
for (const name of ['core.js', 'crust-model.js', 'plate-motion-model.js']) {
  const file = path.join(__dirname, '..', 'html5', 'js', name);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}
const { PlateMotionModel, CrustModel, TectonicsClock, PlateType, Side, MotionType, MagmaRegion, JavaRandom } = PT;

// java.util.Random#nextDouble on top of the port's JavaRandom, so Math.random() replays Java's sequence.
let rnd = null;
Math.random = () => (rnd.next(26) * 134217728 + rnd.next(27)) / 9007199254740992;

const parts = [];
const w = s => parts.push(s);
const f = d => (Number.isFinite(d) ? String(d) : 'null');

function dumpModel(m, extra) {
  w('{' + extra + '"regions":[');
  m.getRegions().forEach((r, ri) => {
    if (ri) w(',');
    w(`{"type":"${r instanceof MagmaRegion ? 'magma' : 'region'}","b":[`);
    r.boundaries.forEach((b, bi) => {
      if (bi) w(',');
      w('[' + b.samples.map(s => `[${f(s.position.x)},${f(s.position.y)},${f(s.position.z)},${f(s.temperature)},${f(s.density)}]`).join(',') + ']');
    });
    w(']}');
  });
  w('],"terrains":[');
  m.getTerrains().forEach((t, ti) => {
    if (ti) w(',');
    const row = t.getFrontZIndex(), front = [];
    for (let i = 0; i < t.getNumColumns(); i++) front.push(f(t.getSample(i, row).getElevation()));
    w(`{"x":[${t.xPositions.map(f).join(',')}],"front":[${front.join(',')}]}`);
  });
  w('],"probe":[');
  const bb = m.getBounds(), probe = [];
  for (let i = 0; i < 15; i++) for (let j = 0; j < 11; j++) {
    const x = bb.minX + (bb.maxX - bb.minX) * (i + 0.5) / 15, y = bb.minY + (bb.maxY - bb.minY) * (j + 0.5) / 11;
    probe.push(`[${f(m.getDensity(x, y))},${f(m.getTemperature(x, y))},${f(m.getDensity(x + 3.7, y + 2.3))},${f(m.getTemperature(x + 3.7, y + 2.3))}]`);
  }
  w(probe.join(',') + ']}');
}

const TYPES = [PlateType.CONTINENTAL, PlateType.YOUNG_OCEANIC, PlateType.OLD_OCEANIC];
const MOTIONS = [MotionType.CONVERGENT, MotionType.DIVERGENT, MotionType.TRANSFORM];
const DT = Math.fround(0.1); // Java passes 0.1f

w('{"plate":[');
let first = true, seedValue = 1000;
for (let li = 0; li < 3; li++) for (let ri = 0; ri < 3; ri++) for (const mt of MOTIONS) {
  for (let ccw = 0; ccw < (mt === MotionType.TRANSFORM ? 2 : 1); ccw++) {
    seedValue++;
    rnd = new JavaRandom(seedValue);
    const clock = new TectonicsClock(1);
    const model = new PlateMotionModel(clock, { minX: -700000, maxX: 700000, minY: -300000, maxY: 15000, minZ: -1000000, maxZ: 0 });
    clock.ticked.add(() => model.update(clock.getSimulationTimeChange()));
    model.dropCrust(Side.LEFT, TYPES[li]);
    model.dropCrust(Side.RIGHT, TYPES[ri]);
    const allowed = mt === MotionType.CONVERGENT ? model.allowsConvergentMotion()
      : mt === MotionType.DIVERGENT ? model.allowsDivergentMotion() : model.allowsTransformMotion();
    if (!allowed) continue;
    if (ccw === 1) model.setTransformMotionCCW(false);
    model.motionType.set(mt);
    if (!first) w(','); first = false;
    w(`{"name":"${TYPES[li].name}/${TYPES[ri].name}/${mt.name}${ccw === 1 ? '/CW' : ''}","seed":${seedValue},"frames":[`);
    clock.start();
    let firstFrame = true;
    for (let step = 0; step <= 600; step++) {
      if (step % 50 === 0 || step === 600) {
        if (!firstFrame) w(','); firstFrame = false;
        dumpModel(model, `"step":${step},"time":${f(clock.getSimulationTime())},"limit":${f(clock.getTimeLimit())},` +
          `"labels":[${model.rangeLabels.length},${model.boundaryLabels.length},${model.textLabels.length},${model.smokePuffs.length}],`);
      }
      clock.stepByWallSeconds(DT);
    }
    w(']}');
  }
}
w('],"crust":[');
const settings = [[0.5, 0.5, 20000], [0, 0, 20000], [1, 1, 20000], [0.5, 0.5, 70000], [0.2, 0.9, 40000], [0.9, 0.1, 5000]];
settings.forEach(([t, c, h], k) => {
  const cm = new CrustModel({ minX: -1500000, maxX: 1500000, minY: -150000, maxY: 15000, minZ: -2000000, maxZ: 0 });
  cm.temperatureRatio.set(t); cm.compositionRatio.set(c); cm.thickness.set(h);
  if (k) w(',');
  const jf = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  w(`{"name":"T${jf(t)}/C${jf(c)}/H${jf(h)}","frames":[`);
  for (let step = 0; step <= 100; step++) {
    if (step % 20 === 0) { if (step) w(','); dumpModel(cm, `"step":${step},"center":${f(cm.getCenterCrustElevation())},`); }
    cm.update(1 / 60);
  }
  w(']}');
});
w(']}');
process.stdout.write(parts.join(''));
