#!/usr/bin/env node
/**
 * Agents UI under load: the numbers behind the perf targets.
 *
 * Drives the `agents-stress` harness scenario (40 agents, a 2,000-line chat,
 * `window.__stress` for live events) in headless Chrome over CDP and reports
 * main-thread time, long tasks and React render counts for each situation the
 * Agents view has to survive. It measures a *production* React build — the
 * dev server's development React is several times slower and would measure
 * React, not the app.
 *
 *   node scripts/perf-agents.mjs --build                 # build, serve, measure everything
 *   node scripts/perf-agents.mjs --port 1805             # measure an already-served perf build
 *   node scripts/perf-agents.mjs --build open,stream     # some phases only
 *   node scripts/perf-agents.mjs --build --profile       # also write .cpuprofile files
 *   node scripts/perf-agents.mjs --build --trace         # and a main-thread breakdown per phase
 *
 * Phases: open, background, openEvents, stream, reopened, idle (default: all);
 * not in all: cold, scroll, typing, arrive, switch (18 agents in turn), usage.
 * Options: --port (served harness, default 1805), --cdp (debugging port,
 * default 9711), --out (results directory, default $TMPDIR/perf-agents),
 * --css (rules added to the page, to try a change without rebuilding),
 * --ipc-ms (every command answers that late, as the Mac's round trip would).
 *
 * Method and targets: docs/ui-harness.md, "Measuring performance".
 * Chrome is not WKWebView: Chrome composites `filter` animations and WebKit
 * does not, so animation costs here understate the app's.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CHROME } from './headless-chrome.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(opt('port', 1805));
const CDP_PORT = Number(opt('cdp', 9711));
const OUT = opt('out', path.join(os.tmpdir(), 'perf-agents'));
const LINES = Number(opt('lines', 2000));
// Every command answers this late (the harness's `?ipcMs=`): the Mac's round trip.
const IPC_MS = Number(opt('ipc-ms', 0));
const VALUE_FLAGS = new Set(['--port', '--cdp', '--out', '--css', '--lines', '--ipc-ms']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const PHASES = (positional[0] ?? 'all').split(',');
const want = (p) => PHASES.includes('all') || PHASES.includes(p);
const PROFILE = flag('profile');
const TRACE = flag('trace');
fs.mkdirSync(OUT, { recursive: true });

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

const children = [];
let profileDir = null;
const cleanup = () => {
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
};
process.once('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, () => process.exit(130));

// ---------- the perf build, served
if (flag('build')) {
  if (!(await portFree(PORT))) throw new Error(`Port ${PORT} is taken; pick another with --port.`);
  console.log('building the harness (production React, unminified)…');
  await new Promise((resolve, reject) => {
    const b = spawn(
      'npx',
      ['vite', 'build', '--config', 'vite.harness.config.ts', '--logLevel', 'warn'],
      {
        stdio: 'inherit',
      }
    );
    b.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`))
    );
  });
  const preview = spawn('npx', ['vite', 'preview', '--config', 'vite.harness.config.ts'], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, SHIPSTUDIO_HARNESS_PORT: String(PORT) },
  });
  children.push(preview);
  for (let i = 0; i < 100 && (await portFree(PORT)); i++) await sleep(100);
}

// ---------- Chrome
if (!(await portFree(CDP_PORT)))
  throw new Error(`CDP port ${CDP_PORT} is taken; pick another with --cdp.`);
profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-agents-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1440,900',
    '--force-device-scale-factor=2',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-precise-memory-info',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: true }
);
children.push(chrome);
let targets = null;
for (let i = 0; i < 100 && !targets; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
let traceEvents = [];
let traceDone = null;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === 'Tracing.dataCollected') {
    traceEvents.push(...msg.params.value);
  } else if (msg.method === 'Tracing.tracingComplete') {
    traceDone?.();
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('page exception:', JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
};

/**
 * Injected before any page script.
 *
 * Long tasks come from a PerformanceObserver. Render counts come from a
 * stand-in DevTools hook: on each commit it walks only the subtrees React
 * marked as having done work (`PerformedWork`, bubbled through
 * `subtreeFlags`), so a bailed-out tree costs nothing to skip. Counting is
 * off unless `__rcOn` is set, and CPU is measured with it off.
 */
const PRELUDE = `
(() => {
  const w = window;
  w.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push({ s: e.startTime, d: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
  w.__rc = {};
  w.__rcOn = false;
  const PERFORMED = 1;
  // The bundler suffixes clashing names (Icon2); the suffix is not the component.
  const name = (f) => { const t = f.type; const n = t && (t.displayName || t.name); return n ? n.replace(/[0-9]+$/, '') : null; };
  const walk = (f) => {
    while (f) {
      if (f.flags & PERFORMED && (f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15)) {
        const n = name(f.tag === 11 ? { type: f.type.render } : f) || '(anon)';
        w.__rc[n] = (w.__rc[n] || 0) + 1;
      }
      if (f.child && (f.subtreeFlags & PERFORMED)) walk(f.child);
      f = f.sibling;
    }
  };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {},
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) { if (w.__rcOn) walk(root.current.child); },
  };
  w.__marks = {};
  // When the chat's first rows appear after navigation (cold open).
  const mo = new MutationObserver(() => {
    if (w.__firstRows === undefined && document.querySelector('.agent-chat [data-message-ids]')) {
      w.__firstRows = performance.now();
      mo.disconnect();
    }
  });
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
  // Input to next paint, per key event (Event Timing; 16 ms is its floor).
  w.__evt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__evt.push({ n: e.name, d: e.duration, s: e.startTime }); })
      .observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
})();
`;
await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable', { timeDomain: 'timeTicks' });
await send('HeapProfiler.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
// `--css "<rules>"`: added to every page, for trying a change without a rebuild.
const EXTRA_CSS = opt('css', '');
if (EXTRA_CSS) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(EXTRA_CSS)}; document.head.append(s); });`,
  });
}

const URL = `http://127.0.0.1:${PORT}/harness.html?scenario=agents-stress&chrome=off&freeze=off&lines=${LINES}${IPC_MS ? `&ipcMs=${IPC_MS}` : ''}`;
const metrics = async () =>
  Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const pct = (a, z, key, secs) => +(((z[key] - a[key]) / secs) * 100).toFixed(1);
const now = () => ev('performance.now()');
// Any task still running at t0 counts: the click that starts a measurement
// runs inside a task that began a moment earlier.
const longTasksSince = (t0) =>
  ev(`(() => { const l = window.__lt.filter(e => e.s + e.d >= ${t0});
    return { count: l.length, max: Math.round(Math.max(0, ...l.map(e => e.d))) }; })()`);
const rows = () => ev(`document.querySelectorAll('.agent-chat [data-message-ids]').length`);
const renders = async (fn) => {
  await ev('window.__rc = {}; window.__rcOn = true');
  await fn();
  const rc = await ev('(window.__rcOn = false, JSON.parse(JSON.stringify(window.__rc)))');
  return Object.fromEntries(Object.entries(rc).sort((x, y) => y[1] - x[1]));
};
const pick = (rc, names) => Object.fromEntries(names.map((n) => [n, rc[n] ?? 0]));
const WATCH = [
  'AgentsModeView',
  'AgentsSidebar',
  'AgentChat',
  'ResultCardView',
  'ApprovalCard',
  'WorkTimeline',
  'Prose',
  'CodeBlock',
];

async function load() {
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 200; i++) {
    if (
      await ev(
        '!!window.__harnessReady && !!document.querySelector(".agent-chat [data-message-ids]")'
      ).catch(() => false)
    )
      break;
    await sleep(100);
  }
  await sleep(800);
}
async function loadAllRows() {
  for (let p = 0; p < Math.ceil(LINES / 100) + 5; p++) {
    const n = await rows();
    await ev(
      // A wheel first: the chat follows the bottom unless the reader moved it.
      `(() => { const el = document.querySelector('.agent-chat__scroll'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); })()`
    );
    for (let i = 0; i < 30 && (await rows()) === n; i++) await sleep(50);
    if ((await rows()) === n) break;
  }
  await ev(
    `(() => { const el = document.querySelector('.agent-chat__scroll'); el.scrollTop = el.scrollHeight; })()`
  );
  await sleep(800);
  return rows();
}
/** Wait until the mounted row count holds still for 3 s, past the let-go delay (up to 20 s). */
async function settleRows() {
  let last = await rows();
  for (let i = 0, still = 0; i < 80 && still < 12; i++) {
    await sleep(250);
    const now = await rows();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}
async function startProfile(interval = 200) {
  if (TRACE) {
    traceEvents = [];
    await send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
      transferMode: 'ReportEvents',
    });
  }
  if (!PROFILE) return;
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval });
  await send('Profiler.start');
}
/** Where the renderer's main thread spent the traced time, by trace event (nested ones overlap). */
async function stopTrace() {
  const done = new Promise((r) => (traceDone = r));
  await send('Tracing.end');
  await done;
  const main = traceEvents.find(
    (e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain'
  );
  const by = {};
  const styled = [];
  let timerFires = 0;
  for (const e of traceEvents) {
    if (!main || e.tid !== main.tid || e.ph !== 'X' || !e.dur) continue;
    by[e.name] = (by[e.name] ?? 0) + e.dur / 1000;
    if (e.name === 'UpdateLayoutTree' && e.args?.elementCount) styled.push(e.args.elementCount);
    if (e.name === 'TimerFire') timerFires++;
  }
  styled.sort((a, b) => a - b);
  return {
    ...Object.fromEntries(
      Object.entries(by)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([k, v]) => [k, Math.round(v)])
    ),
    styleRecalcs: styled.length,
    elementsStyledP50: styled[Math.floor(styled.length / 2)] ?? 0,
    elementsStyledMax: styled[styled.length - 1] ?? 0,
    timerFires,
  };
}
async function stopProfile(name) {
  if (TRACE) traceSummary = await stopTrace();
  if (!PROFILE) return;
  const { profile } = await send('Profiler.stop');
  fs.writeFileSync(path.join(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
}
let traceSummary = null;
/** Main-thread share of wall time while `fn` runs plus `secs` of settling. */
async function cpu(label, fn, secs) {
  const a = await metrics();
  const t0 = await now();
  await startProfile();
  await fn();
  await sleep(secs * 1000);
  await stopProfile(label);
  const z = await metrics();
  const wall = ((await now()) - t0) / 1000;
  return {
    secs: +wall.toFixed(1),
    mainThreadPct: pct(a, z, 'TaskDuration', wall),
    scriptPct: pct(a, z, 'ScriptDuration', wall),
    stylePct: pct(a, z, 'RecalcStyleDuration', wall),
    layoutPct: pct(a, z, 'LayoutDuration', wall),
    longTasks: await longTasksSince(t0),
    ...(traceSummary ? { traceMs: traceSummary } : {}),
  };
}

const results = {};
const report = (k, v) => {
  results[k] = v;
  console.log(`\n${k}\n${JSON.stringify(v, null, 1)}`);
};
const clickAndWait = (selector, until) =>
  ev(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: 'no ${selector}' };
    const t0 = performance.now();
    el.click();
    const start = Date.now();
    while (!(${until})) { await new Promise(r => setTimeout(r, 0)); if (Date.now() - start > 20000) return { error: 'timeout' }; }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ms: Math.round(performance.now() - t0), t0 };
  })()`);
const OTHER = `[data-agent-id="a0"]`;
const CHIEF = `[data-agent-id="chief"]`;
const otherOpen = `document.querySelector('.agent-chat')?.getAttribute('aria-label')?.includes('Agent 01')`;

// ---------- 1. opening the chat with 2,000 lines loaded
if (want('open')) {
  await load();
  const n = await loadAllRows();
  const runs = [];
  for (let i = 0; i < 4; i++) {
    await clickAndWait(OTHER, otherOpen);
    await sleep(400);
    if (i === 1) await startProfile(100);
    // Open = the Chief's conversation is on screen with a screenful and more
    // of its newest lines. All 2,000 stay loaded in the store either way; a
    // build that mounts only the newest lines is timed to the same moment.
    const t = await clickAndWait(
      CHIEF,
      `document.querySelector('.agent-chat')?.getAttribute('aria-label')?.includes('Chief') && document.querySelectorAll('.agent-chat [data-message-ids]').length >= 100`
    );
    if (i === 1) await stopProfile('open-2000');
    if (t.error) throw new Error(t.error);
    await sleep(600);
    runs.push({ ms: t.ms, maxLongTask: (await longTasksSince(t.t0)).max, mounted: await rows() });
  }
  const warm = runs.slice(1);
  report('open_2000', {
    rows: n,
    runs,
    worstMs: Math.max(...warm.map((r) => r.ms)),
    worstLongTask: Math.max(...warm.map((r) => r.maxLongTask)),
  });
}

// ---------- 2. 10 status/s on other agents, chat open at 2,000 lines
const STATUS_SECS = 20;
if (want('background') || want('openEvents')) {
  await load();
  const n = await loadAllRows();
  if (want('background')) {
    // Back at the newest line, the rows mounted on the way up are let go a
    // few at a time (AgentChat's own renders); counted here they would read
    // as renders caused by the events.
    await settleRows();
    const rc = await renders(async () => {
      await ev(`window.__stress.start({ rate: 10, open: false })`);
      await sleep(10_000);
      await ev('window.__stress.stop()');
    });
    await sleep(500);
    const c = await cpu(
      'background-2000',
      () => ev(`window.__stress.start({ rate: 10, open: false })`),
      STATUS_SECS
    );
    await ev('window.__stress.stop()');
    report('background_events_2000', {
      rows: n,
      ...c,
      rendersIn10s: pick(rc, WATCH),
      topRenders: Object.fromEntries(Object.entries(rc).slice(0, 12)),
    });
  }
  if (want('openEvents')) {
    await sleep(1000);
    const rc = await renders(async () => {
      await ev(`window.__stress.start({ rate: 10, open: true })`);
      await sleep(10_000);
      await ev('window.__stress.stop()');
    });
    await sleep(500);
    const c = await cpu(
      'open-events-2000',
      () => ev(`window.__stress.start({ rate: 10, open: true })`),
      STATUS_SECS
    );
    await ev('window.__stress.stop()');
    report('open_chat_events_2000', { rows: await rows(), ...c, rendersIn10s: pick(rc, WATCH) });
  }
}

// ---------- 3. a 3.5 KB reply streaming into the open chat at 2,000 lines
if (want('stream')) {
  await load();
  const n = await loadAllRows();
  let chars = 0;
  const rc = await renders(async () => {
    chars = await ev(`window.__stress.stream({ blocks: 12, every: 40 })`);
  });
  await sleep(1500);
  const c = await cpu(
    'stream-2000',
    async () => {
      await ev(`window.__stress.stream({ blocks: 12, every: 40 })`);
    },
    0.1
  );
  report('stream_2000', { rows: n, chars, ...c, renders: pick(rc, WATCH) });
}

// ---------- 3b. the same two, with the chat reopened: 2,000 lines loaded in
// the store, but only what a reopened chat mounts in the DOM. Scrolling up
// through all 2,000 first (above) is the worst case; this is the usual one.
if (want('reopened')) {
  await load();
  const n = await loadAllRows();
  await clickAndWait(OTHER, otherOpen);
  await sleep(400);
  await clickAndWait(
    CHIEF,
    `document.querySelector('.agent-chat')?.getAttribute('aria-label')?.includes('Chief')`
  );
  await sleep(1000);
  const mounted = await rows();
  const c = await cpu(
    'open-events-reopened',
    () => ev(`window.__stress.start({ rate: 10, open: true })`),
    STATUS_SECS
  );
  await ev('window.__stress.stop()');
  report('open_chat_events_reopened', { rows: n, mounted, ...c });
  await sleep(1500);
  const s2 = await cpu(
    'stream-reopened',
    async () => {
      await ev(`window.__stress.stream({ blocks: 12, every: 40 })`);
    },
    0.1
  );
  report('stream_reopened', { rows: n, mounted: await rows(), ...s2 });
}

// ---------- 4. nothing happening, six agents shown as working
if (want('idle')) {
  for (const all of [false, true]) {
    await load();
    const n = all ? await loadAllRows() : await rows();
    // Six agents start working and then go quiet: their loaders keep running.
    await ev(`window.__stress.start({ rate: 10 })`);
    await sleep(1200);
    await ev('window.__stress.stop()');
    await sleep(2000);
    const c = await cpu(`idle-working-${n}`, async () => {}, 20);
    const anims = await ev(
      `document.getAnimations().filter(a => a.playState === 'running').length`
    );
    // Which loops they are: the animation's name and the class of what it moves.
    const animsByName = await ev(
      `JSON.stringify(document.getAnimations().filter(a => a.playState === 'running').reduce((o, a) => { const t = a.effect?.target; const k = (a.animationName ?? a.constructor.name) + ' ' + (t?.classList?.[0] ?? t?.tagName ?? ''); o[k] = (o[k] ?? 0) + 1; return o; }, {}))`
    );
    report(`idle_six_working_${all ? 2000 : 150}`, {
      rows: n,
      runningAnimations: anims,
      animationsByName: JSON.parse(animsByName),
      ...c,
    });
  }
}

// ---------- 5. long chats (`--lines 5000`): cold open, scrolling, memory,
// typing and a new line arriving. Each phase starts from a fresh page.
const heap = async () => {
  await send('HeapProfiler.collectGarbage');
  return ev(`({ heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1),
    domNodes: document.getElementsByTagName('*').length })`);
};
const frameStats = (ft) => {
  const s = [...ft].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(1);
  const total = ft.reduce((a, b) => a + b, 0);
  return {
    frames: ft.length,
    fps: +((ft.length / total) * 1000).toFixed(1),
    p50: q(0.5),
    p95: q(0.95),
    max: q(1),
    over33ms: ft.filter((f) => f > 33.4).length,
  };
};
/**
 * Scroll the chat by `step` px a frame, recording frame times, until it has
 * stood still for 90 frames (the end, with nothing more paging in).
 */
const scrollFrames = (step, maxMs = 90000) =>
  ev(`(async () => {
    const el = document.querySelector('.agent-chat__scroll');
    const ft = [];
    let last = performance.now();
    const t0 = last;
    let still = 0;
    while (still < 90 && performance.now() - t0 < ${maxMs}) {
      const before = el.scrollTop;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: ${step} }));
      el.scrollTop += ${step};
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      if (el.scrollTop === before) still++;
      else still = 0;
      ft.push(t - last);
      last = t;
    }
    // The standing-still frames at the end are not scrolling.
    return { ft: ft.slice(0, Math.max(1, ft.length - still)), t0 };
  })()`);

if (want('cold')) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    await load();
    runs.push({
      firstRowsMs: Math.round(await ev('window.__firstRows')),
      mounted: await rows(),
      ...(await heap()),
    });
  }
  report(`cold_open_${LINES}`, { runs });
}

if (want('scroll')) {
  await load();
  const opened = await heap();
  const t0 = await now();
  // Up through every line (paging older ones in), then back down.
  const up = await scrollFrames(-120);
  report(`scroll_${LINES}_up`, {
    ...frameStats(up.ft),
    longTasks: await longTasksSince(t0),
    mounted: await rows(),
  });
  const loaded = await heap();
  const t1 = await now();
  const down = await scrollFrames(120);
  report(`scroll_${LINES}_down`, {
    ...frameStats(down.ft),
    longTasks: await longTasksSince(t1),
    mounted: await rows(),
  });
  // Left at the newest line: what is still held a few seconds later.
  const t2 = await now();
  const letGo = await cpu(`let-go-${LINES}`, async () => {}, 20);

  report(`memory_${LINES}`, {
    opened,
    afterScrollingAll: loaded,
    backAtNewest20s: {
      ...(await heap()),
      mounted: await rows(),
      longTasks: await longTasksSince(t2),
      letGo,
    },
  });
}

if (want('typing')) {
  for (const all of [false, true]) {
    await load();
    if (all) await loadAllRows();
    await ev(`document.querySelector('.agent-chat textarea')?.focus()`);
    await sleep(300);
    await ev('window.__evt = []');
    const t0 = await now();
    const text = 'Can you check the invoices from last week and tell me what is missing?';
    const rc = await renders(async () => {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: ch,
          text: ch,
          unmodifiedText: ch,
        });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await sleep(30);
      }
    });
    await sleep(500);
    const evts = await ev(`window.__evt.filter(e => e.s >= ${t0})`);
    const d = evts.map((e) => e.d).sort((a, b) => a - b);
    // Main-thread time the same keys cost, counting off.
    await ev(`(() => { const t = document.querySelector('.agent-chat textarea'); t.select(); })()`);
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await sleep(300);
    const c = await cpu(
      `typing-${all ? LINES : 'reopened'}`,
      async () => {
        for (const ch of text) {
          await send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: ch,
            text: ch,
            unmodifiedText: ch,
          });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
          await sleep(30);
        }
      },
      0.2
    );
    report(`typing_${all ? LINES : 'reopened'}`, {
      mounted: await rows(),
      keys: text.length,
      scriptMsPerKey: +(((c.scriptPct / 100) * c.secs * 1000) / text.length).toFixed(2),
      mainThreadMsPerKey: +(((c.mainThreadPct / 100) * c.secs * 1000) / text.length).toFixed(2),
      eventsOver16ms: d.length,
      worstEventMs: Math.round(d[d.length - 1] ?? 0),
      longTasks: await longTasksSince(t0),
      agentChatRenders: rc.AgentChat ?? 0,
      perKeyRenders: Object.fromEntries(Object.entries(rc).slice(0, 8)),
    });
    await ev(
      `(() => { const t = document.querySelector('.agent-chat textarea'); if (t) { t.select(); } })()`
    );
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }
}

if (want('arrive')) {
  for (const all of [false, true]) {
    await load();
    if (all) await loadAllRows();
    await sleep(500);
    const runs = [];
    const rc = await renders(async () => {
      for (let i = 0; i < 5; i++) {
        runs.push(
          await ev(`(async () => {
            const id = 'arrive-' + ${i} + '-' + Date.now();
            const t0 = performance.now();
            window.__stress.arrive(id);
            while (!document.querySelector('[data-message-ids~="' + id + '"]')) await new Promise(r => setTimeout(r, 0));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return { ms: Math.round(performance.now() - t0), t0 };
          })()`)
        );
        await sleep(700);
      }
    });
    report(`arrive_${all ? LINES : 'reopened'}`, {
      mounted: await rows(),
      ms: runs.map((r) => r.ms),
      worstLongTask: (await longTasksSince(runs[0].t0)).max,
      rendersFor5: pick(rc, WATCH),
      topRenders: Object.fromEntries(Object.entries(rc).slice(0, 8)),
    });
  }
}

// ---------- 6. switching agents: 18 in turn, first visit (its page read) and again
const NAMES = Array.from(
  { length: 17 },
  (_, i) =>
    `Agent ${String(i + 1).padStart(2, '0')} ${['Finance', 'Research', 'Travel', 'Inbox', 'Acme Site'][i % 5]}`
);
const SWITCH = [
  ...NAMES.map((n, i) => ({ sel: `[data-agent-id="a${i}"]`, name: n })),
  {
    sel: CHIEF,
    name: 'Chief',
  },
];
const switchTo = ({ sel, name }) =>
  clickAndWait(
    sel,
    `document.querySelector('.agent-chat')?.getAttribute('aria-label')?.includes(${JSON.stringify(name)}) && document.querySelector('.agent-chat [data-message-ids]')`
  );
const summary = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], worst: s[s.length - 1] };
};
if (want('switch')) {
  await load();
  await sleep(500);
  const passes = {};
  let rc = {};
  for (const pass of ['first', 'again']) {
    const t0 = await now();
    const ms = [];
    const run = async () => {
      for (const a of SWITCH) {
        const t = await switchTo(a);
        if (t.error) throw new Error(`${a.name}: ${t.error}`);
        ms.push(t.ms);
        await sleep(150);
      }
    };
    if (pass === 'again') rc = await renders(run);
    else await run();
    passes[pass] = { ...summary(ms), longTasks: await longTasksSince(t0), ms };
  }
  report('switch_18', {
    ...passes,
    rendersAgain: pick(rc, WATCH),
    topRenders: Object.fromEntries(Object.entries(rc).slice(0, 10)),
  });
}

// ---------- 7. the Usage view: open it from the sidebar, then sit on it
if (want('usage')) {
  await load();
  await sleep(500);
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const t = await clickAndWait(
      '[data-testid="account-switcher"]',
      `document.querySelector('[data-testid="usage-hero"]')`
    );
    if (t.error) throw new Error(`usage: ${t.error}`);
    runs.push({ ms: t.ms, maxLongTask: (await longTasksSince(t.t0)).max });
    await sleep(400);
    if (i < 3) {
      await switchTo(SWITCH[SWITCH.length - 1]);
      await sleep(400);
    }
  }
  const c = await cpu('usage-idle', async () => {}, 15);
  report('usage_view', { runs, worstWarmMs: Math.max(...runs.slice(1).map((r) => r.ms)), idle: c });
}

// ---------- the targets
const T = [];
const check = (name, value, ok) => T.push({ target: name, value, pass: ok });
if (results.open_2000) {
  const r = results.open_2000;
  check('chat open at 2,000 lines < 100 ms', `${r.worstMs} ms`, r.worstMs < 100);
  check('  … no long task > 50 ms', `${r.worstLongTask} ms`, r.worstLongTask <= 50);
}
if (results.background_events_2000) {
  const r = results.background_events_2000;
  check(
    'other agents at 10/s: AgentChat renders',
    r.rendersIn10s.AgentChat,
    r.rendersIn10s.AgentChat === 0
  );
}
if (results.open_chat_events_2000) {
  const r = results.open_chat_events_2000;
  check('open-chat events at 2,000 lines < 10%', `${r.mainThreadPct}%`, r.mainThreadPct < 10);
}
if (results.stream_2000) {
  const r = results.stream_2000;
  check('streaming at 2,000 lines < 15%', `${r.mainThreadPct}%`, r.mainThreadPct < 15);
}
if (results.open_chat_events_reopened) {
  const r = results.open_chat_events_reopened;
  check(
    'open-chat events, chat reopened (2,000 loaded) < 10%',
    `${r.mainThreadPct}%`,
    r.mainThreadPct < 10
  );
}
if (results.stream_reopened) {
  const r = results.stream_reopened;
  check(
    'streaming, chat reopened (2,000 loaded) < 15%',
    `${r.mainThreadPct}%`,
    r.mainThreadPct < 15
  );
}
for (const k of ['idle_six_working_150', 'idle_six_working_2000']) {
  if (results[k])
    check(
      `idle, 6 working (${results[k].rows} lines) < 3%`,
      `${results[k].mainThreadPct}%`,
      results[k].mainThreadPct < 3
    );
}
results.targets = T;
console.log('\nTargets');
for (const t of T) console.log(`  ${t.pass ? 'PASS' : 'FAIL'}  ${t.target}: ${t.value}`);
const file = path.join(OUT, `perf-agents-${PHASES.join('_')}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nwrote ${file}`);
ws.close();
process.exit(0);
