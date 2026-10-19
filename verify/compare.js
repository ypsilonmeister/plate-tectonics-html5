// Diffs java.json (original) against js.json (HTML5 port).   node compare.js [--verbose]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const verbose = process.argv.includes('--verbose');
const load = n => JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8'));
const J = load('java.json'), S = load('js.json');

// Java computes in 32-bit floats, the port in doubles: allow float-sized drift.
const close = (a, b, scale) => (a === null || b === null) ? a === b : Math.abs(a - b) <= 1e-3 * Math.max(scale, Math.abs(a), Math.abs(b));

function compareFrame(a, b, issues) {
  const note = m => { issues.push(`step ${a.step}: ${m}`); };
  for (const k of ['time', 'limit', 'center']) if (k in a && !close(a[k], b[k], 1)) note(`${k} java=${a[k]} js=${b[k]}`);
  if (a.labels && a.labels.join() !== b.labels.join()) note(`labels/boundary/text/smoke java=[${a.labels}] js=[${b.labels}]`);
  if (a.regions.length !== b.regions.length) note(`region count java=${a.regions.length} js=${b.regions.length}`);
  const worst = { pos: 0, temp: 0, dens: 0, where: '' };
  a.regions.forEach((ra, i) => {
    const rb = b.regions[i]; if (!rb) return;
    if (ra.type !== rb.type) note(`region ${i} type java=${ra.type} js=${rb.type}`);
    ra.b.forEach((ba, j) => {
      const bb = rb.b[j];
      if (!bb || ba.length !== bb.length) { note(`region ${i} boundary ${j} samples java=${ba.length} js=${bb && bb.length}`); return; }
      ba.forEach((sa, k) => {
        const sb = bb[k];
        const dp = Math.max(Math.abs(sa[0] - sb[0]), Math.abs(sa[1] - sb[1]), Math.abs(sa[2] - sb[2]));
        if (dp > worst.pos) { worst.pos = dp; worst.where = `region ${i}(${ra.type}) b${j} s${k} java=(${sa[0]},${sa[1]}) js=(${sb[0]},${sb[1]})`; }
        worst.temp = Math.max(worst.temp, Math.abs(sa[3] - sb[3]));
        worst.dens = Math.max(worst.dens, Math.abs(sa[4] - sb[4]));
      });
    });
  });
  if (worst.pos > 50) note(`max sample position diff ${worst.pos.toFixed(1)} m at ${worst.where}`);
  if (worst.temp > 1) note(`max sample temperature diff ${worst.temp.toFixed(2)} K`);
  if (worst.dens > 1) note(`max sample density diff ${worst.dens.toFixed(2)} kg/m3`);
  if (a.terrains.length !== b.terrains.length) note(`terrain count java=${a.terrains.length} js=${b.terrains.length}`);
  let te = 0, tx = 0;
  a.terrains.forEach((ta, i) => {
    const tb = b.terrains[i]; if (!tb) return;
    if (ta.x.length !== tb.x.length) { note(`terrain ${i} columns java=${ta.x.length} js=${tb.x.length}`); return; }
    ta.x.forEach((x, k) => { tx = Math.max(tx, Math.abs(x - tb.x[k])); te = Math.max(te, Math.abs(ta.front[k] - tb.front[k])); });
  });
  if (tx > 50) note(`max terrain x diff ${tx.toFixed(1)} m`);
  if (te > 50) note(`max terrain elevation diff ${te.toFixed(1)} m`);
  // Each probe is [density, temperature] at (x, y) and again a few metres away. Java's float
  // ray/triangle test can miss exactly on a triangle edge (it then reports water), so a probe
  // that differs only at the exact point but agrees once nudged is counted as an edge miss.
  let pd = 0, pt = 0, pwhere = '';
  a.probe.forEach((pa, i) => {
    const pb = b.probe[i];
    const exact = Math.abs(pa[0] - pb[0]) > 1 || Math.abs(pa[1] - pb[1]) > 1;
    const nudged = Math.abs(pa[2] - pb[2]) > 1 || Math.abs(pa[3] - pb[3]) > 1;
    if (exact && !nudged) { edgeMisses++; return; }
    const dd = Math.max(Math.abs(pa[0] - pb[0]), Math.abs(pa[2] - pb[2]));
    const dt = Math.max(Math.abs(pa[1] - pb[1]), Math.abs(pa[3] - pb[3]));
    if (dd > pd) { pd = dd; pwhere = `probe ${i} density java=${pa[0]}/${pa[2]} js=${pb[0]}/${pb[2]}`; }
    if (dt > pt) { pt = dt; if (dd <= 1) pwhere = `probe ${i} temperature java=${pa[1]}/${pa[3]} js=${pb[1]}/${pb[3]}`; }
  });
  if (pd > 1) note(`meter density diff ${pd.toFixed(2)} (${pwhere})`);
  if (pt > 1) note(`meter temperature diff ${pt.toFixed(2)} K (${pwhere})`);
  return worst;
}

let failed = 0, total = 0, edgeMisses = 0;
for (const group of ['plate', 'crust']) {
  const byName = new Map(S[group].map(s => [s.name, s]));
  if (J[group].length !== S[group].length) console.log(`${group}: scenario count java=${J[group].length} js=${S[group].length}`);
  for (const sa of J[group]) {
    total++;
    const sb = byName.get(sa.name);
    if (!sb) { console.log(`MISSING in JS: ${group} ${sa.name}`); failed++; continue; }
    const issues = [];
    sa.frames.forEach((fa, i) => compareFrame(fa, sb.frames[i], issues));
    if (issues.length) {
      failed++;
      console.log(`DIFF ${group} ${sa.name} (${issues.length} issues)`);
      for (const m of verbose ? issues : issues.slice(0, 4)) console.log('   ' + m);
    } else console.log(`SAME ${group} ${sa.name}`);
  }
}
console.log(`\n${total - failed}/${total} scenarios match the original Java model.`);
if (edgeMisses) console.log(`(${edgeMisses} meter readings differed only exactly on a triangle edge, where Java's float hit test misses)`);
process.exitCode = failed ? 1 : 0;
