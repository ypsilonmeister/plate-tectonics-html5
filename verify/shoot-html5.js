// Screenshots of the HTML5 port at the original sim's canvas size, for side-by-side
// comparison with the Java version.  Needs the html5 folder served on http://localhost:8765
// (python -m http.server 8765 --directory html5).   node verify/shoot-html5.js
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://localhost:8765/';
const W = 1165, H = 645, PORT = 9333;
const OUT = path.join(__dirname, 'shots');

// Each scene runs in the page; `A` is window.PT_APP.
const SCENES = {
  'crust-default': ``,
  'crust-temperature-labels': `
    const t = A.tabs.crust; t.colorMode.set(PT.ColorMode.TEMPERATURE); t.showLabels.set(true);`,
  'motion-empty': `document.querySelector('#tabs .tab[data-tab=motion]').click();`,
  'motion-cont-old-dropped': `
    document.querySelector('#tabs .tab[data-tab=motion]').click();
    const m = A.tabs.motion.model; m.dropCrust(PT.Side.LEFT, PT.PlateType.CONTINENTAL); m.dropCrust(PT.Side.RIGHT, PT.PlateType.OLD_OCEANIC);`,
  'motion-cont-old-50my': `
    document.querySelector('#tabs .tab[data-tab=motion]').click();
    const t = A.tabs.motion, m = t.model; m.dropCrust(PT.Side.LEFT, PT.PlateType.CONTINENTAL); m.dropCrust(PT.Side.RIGHT, PT.PlateType.OLD_OCEANIC);
    t.isAutoMode.set(true); m.motionType.set(PT.MotionType.CONVERGENT); t.clock.start();
    for (let i = 0; i < 600; i++) t.clock.stepByWallSeconds(0.1); t.clock.pause();`,
  'motion-cont-cont-divergent-35my': `
    document.querySelector('#tabs .tab[data-tab=motion]').click();
    const t = A.tabs.motion, m = t.model; m.dropCrust(PT.Side.LEFT, PT.PlateType.CONTINENTAL); m.dropCrust(PT.Side.RIGHT, PT.PlateType.CONTINENTAL);
    m.motionType.set(PT.MotionType.DIVERGENT); t.clock.start();
    for (let i = 0; i < 400; i++) t.clock.stepByWallSeconds(0.1); t.clock.pause();`,
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`, '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => { const msg = JSON.parse(e.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
    const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    for (const [name, code] of Object.entries(SCENES)) {
      await send('Page.navigate', { url: URL + '?scene=' + name });
      await new Promise(r => setTimeout(r, 2500));
      const res = await send('Runtime.evaluate', { expression: `(() => { const A = window.PT_APP; ${code}; return 'ok'; })()`, returnByValue: true });
      if (res.result.exceptionDetails) console.log(name, 'ERROR', res.result.exceptionDetails.exception?.description);
      await new Promise(r => setTimeout(r, 1500));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `html5-${name}.png`), Buffer.from(shot.result.data, 'base64'));
      console.log('saved', `html5-${name}.png`);
    }
    ws.close();
  } finally { chrome.kill(); }
}
main().catch(e => { console.error(e); process.exit(1); });
