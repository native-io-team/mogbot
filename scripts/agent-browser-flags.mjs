// Agent browser research (docs/internal/agent-browser.md): which launch modes
// make navigator.webdriver true in the installed Chrome, and what that does.
//   node scripts/agent-browser-flags.mjs <scratch dir>                 webdriver per mode
//   MODE=google node scripts/agent-browser-flags.mjs <scratch dir>     + two Google searches per mode
//   MODE=turnstile node scripts/agent-browser-flags.mjs <scratch dir>  + nowsecure.nl and sannysoft
// A fresh temp profile per mode inside <scratch dir>, muted, deleted after. Signs in to nothing.
// The masking modes are measured, not recommended: see "Where the line is".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRATCH = process.argv[2];
const base = ['--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--window-position=-32000,-32000', '--window-size=1000,700'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(send) {
  let id = 0; const waiting = new Map();
  return {
    onMessage(m) { if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } },
    call(method, params = {}, sessionId) { const i = ++id; send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((res, rej) => { waiting.set(i, { res, rej }); setTimeout(() => rej(new Error('timeout ' + method)), 15000); }); },
  };
}

const MODE = process.env.MODE || 'webdriver';
async function probe(c, name) {
  const { targetId } = await c.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.call('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (e) => (await c.call('Runtime.evaluate', { expression: e, returnByValue: true }, sessionId)).result.value;
  const out = { webdriver: await ev('navigator.webdriver') };
  if (MODE === 'google') {
    const tries = [];
    for (let i = 0; i < 2; i++) {
      await c.call('Page.navigate', { url: 'https://www.google.com/' }, sessionId);
      await sleep(3000);
      await ev("(document.querySelector('textarea[name=q], input[name=q]')||{focus(){}}).focus()");
      for (const ch of 'chrome devtools protocol') { await c.call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, sessionId); await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId); await sleep(40); }
      await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, sessionId);
      await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
      await sleep(4000);
      tries.push(await ev("location.pathname + (location.pathname.startsWith('/sorry') || /unusual traffic/i.test(document.body.innerText) ? ' BLOCKED' : ' ok')"));
    }
    out.google = tries;
  }
  if (MODE === 'turnstile') {
    await c.call('Page.navigate', { url: 'https://nowsecure.nl/' }, sessionId);
    await sleep(12000);
    const shot = await c.call('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, sessionId);
    fs.writeFileSync(path.join(SCRATCH, `turnstile-${name}.jpg`), Buffer.from(shot.data, 'base64'));
    out.text = (await ev('document.body.innerText')).slice(0, 200).replace(/\s+/g, ' ');
    await c.call('Page.navigate', { url: 'https://bot.sannysoft.com/' }, sessionId);
    await sleep(4000);
    out.sannysoftFailed = await ev("[...document.querySelectorAll('td.failed')].map(td => (td.previousElementSibling||{}).innerText)");
  }
  return out;
}

async function pipeMode(name, extra) {
  const dir = path.join(SCRATCH, 'wd-' + name); fs.rmSync(dir, { recursive: true, force: true });
  const p = spawn(CHROME, [`--user-data-dir=${dir}`, '--remote-debugging-pipe', ...base, ...extra, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const out = p.stdio[3], inp = p.stdio[4];
  const c = client((s) => out.write(s + '\0'));
  let buf = '';
  inp.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\0')) >= 0) { c.onMessage(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  try { return await probe(c, name); } finally { try { await c.call('Browser.close'); } catch {} p.kill(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function portMode(name, port) {
  const dir = path.join(SCRATCH, 'wd-' + name); fs.rmSync(dir, { recursive: true, force: true });
  const p = spawn(CHROME, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, ...base, 'about:blank'], { stdio: 'ignore' });
  const f = path.join(dir, 'DevToolsActivePort');
  let url, prt = port;
  for (let i = 0; i < 150 && !url; i++) {
    await sleep(100);
    if (port === 0) { if (fs.existsSync(f)) { const [a, b] = fs.readFileSync(f, 'utf8').trim().split('\n'); if (b) { prt = a; url = `ws://127.0.0.1:${a}${b}`; } } }
    else { try { url = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch {} }
  }
  if (!url) { p.kill(); return { error: 'no debugging endpoint appeared' }; }
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const c = client((s) => ws.send(s));
  ws.onmessage = (e) => c.onMessage(JSON.parse(e.data));
  try { return { port: prt, ...(await probe(c, name)) }; } finally { try { await c.call('Browser.close'); } catch {} ws.close(); p.kill(); await sleep(500); fs.rmSync(dir, { recursive: true, force: true }); }
}

const results = {};
results.pipe = await pipeMode('pipe', []);
if (!process.env.SKIP_EXTRA) {
results['pipe+disable-blink-features=AutomationControlled'] = await pipeMode('pipe-dbf', ['--disable-blink-features=AutomationControlled']);
results['port=0'] = await portMode('port0', 0);
}
results['port=fixed'] = await portMode('portfixed', 20000 + Math.floor(Math.random() * 20000));
console.log(JSON.stringify(results, null, 2));
