#!/usr/bin/env node
/**
 * Phone screens without a simulator: render the companion app with
 * react-native-web against the mock Mac and capture a fixed list of screens,
 * light and dark, at an iPhone 17 Pro's 402×874 @3x.
 *
 * It starts the mock (`--http --cors`) and `expo start --web`, pairs through
 * the real `/pair?d=` confirm screen, then walks the phases below, restarting
 * or stopping the mock to reach the states only a Mac can cause (out of
 * reach, "This isn't your Mac", three bars, a heavy account). Writes PNGs plus
 * `report.md`.
 *
 * Dependency-free on purpose, like the desktop's scripts/harness-capture.mjs:
 * the Chrome DevTools Protocol over Node's built-in WebSocket and fetch.
 *
 *   pnpm qa:web                          # everything, into qa-shots/
 *   pnpm qa:web --only chat-,composer-   # shots whose name starts with chat- or composer-
 *   pnpm qa:web --phases heavy           # only these phases (demo,fresh,first-run,live,cached,impostor,bars,usage-accounts,heavy,importing,team-setup,live-work,engine,probe,torture)
 *   pnpm qa:web --themes dark            # one theme
 *   pnpm qa:web --phases send            # a send, frame by frame (not in the default run)
 *   pnpm qa:web --phases perf            # a 5,000-line chat: first render and scroll jank (not in the default run)
 *   pnpm qa:web --phases net             # requests the Mac sees and React renders: cold start, tabs, chats, reconnect, a streaming reply (not in the default run)
 *   pnpm qa:web --phases reconnecting    # the Mac going away under an open app (not in the default run)
 *   pnpm qa:web --phases link-down       # the connection bar: away, back, the Mac's app stuck or closing (not in the default run)
 *   pnpm qa:web --out /tmp/shots
 *   pnpm qa:web --web-port 8098 --mock-port 47498 --cdp-port 9681
 *   QA_WEB_PORT=… QA_MOCK_PORT=… QA_CDP_PORT=… pnpm qa:web
 *
 * What the web build can't show (no safe areas, Material icons, a JS tab bar)
 * is listed in docs/mobile.md, "Phone screens without a simulator".
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepOrphans } from '../../scripts/headless-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, env, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : (process.env[env] ?? fallback);
};
const WEB_PORT = Number(opt('--web-port', 'QA_WEB_PORT', 8098));
const MOCK_PORT = Number(opt('--mock-port', 'QA_MOCK_PORT', 47498));
const CDP_PORT = Number(opt('--cdp-port', 'QA_CDP_PORT', 9681));
const OUT = path.resolve(opt('--out', 'QA_OUT', path.join(ROOT, 'qa-shots')));
const ONLY = opt('--only', 'QA_ONLY', '');
const THEMES = opt('--themes', 'QA_THEMES', 'light,dark').split(',').filter(Boolean);
const VERBOSE = args.includes('--verbose');
// A run that outlives this is hung: everything it started is killed and it fails.
const MAX_MS = Number(opt('--max-ms', 'QA_MAX_MS', 75 * 60 * 1000));
const PHASES = opt(
  '--phases',
  'QA_PHASES',
  'demo,fresh,first-run,live,cached,impostor,bars,usage-accounts,heavy,importing,team-setup,live-work,engine,probe,torture'
).split(',');
const phase = (name) => PHASES.includes(name);
// Ports other tools in this repo own: the desktop app, its harness, the phone's Metro.
for (const p of [WEB_PORT, MOCK_PORT, CDP_PORT]) {
  if ([8090, 1420, 1425, 1435].includes(p)) throw new Error(`Port ${p} belongs to another tool`);
}
const WEB = `http://localhost:${WEB_PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;
const VIEWPORT = { width: 402, height: 874, deviceScaleFactor: 3, mobile: true };
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[qa:web]', ...a);

// ---- Processes ---------------------------------------------------------------------

const children = new Set();
/**
 * A unix socket's path is capped at 104 bytes on macOS, and tsx's IPC pipe
 * and Chrome's singleton socket are made under TMPDIR: a long one (a
 * sandbox's, a CI runner's) fails both before anything starts. Then the
 * run works in a short folder and hands its children a TMPDIR inside it
 * (Metro's cache with it, so such a run bundles cold). A short TMPDIR is
 * left alone.
 */
// Chrome adds ~43 bytes under it (`.com.google.Chrome.XXXXXX/SingletonSocket`), tsx ~20.
const LONG_TMP = tmpdir().length > 60;
function workDir() {
  if (LONG_TMP) {
    try {
      return mkdtempSync('/tmp/qa-web-');
    } catch {
      /* not writable here: try the long one */
    }
  }
  return mkdtempSync(path.join(tmpdir(), 'qa-web-'));
}
const work = workDir();
const mockState = path.join(work, 'mock');
const childTmp = LONG_TMP && work.startsWith('/tmp/') ? path.join(work, 't') : tmpdir();
if (childTmp !== tmpdir()) mkdirSync(childTmp);

function run(name, cmd, argv, env = {}) {
  const child = spawn(cmd, argv, {
    cwd: ROOT,
    env: { ...process.env, TMPDIR: childTmp, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own group, so the whole tree goes on stop
  });
  child.output = '';
  const keep = (d) => {
    child.output = (child.output + d).slice(-20_000);
    if (VERBOSE) process.stdout.write(`[${name}] ${d}`);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 3000).unref();
  });
}

function stopAllNow() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  rmSync(work, { recursive: true, force: true });
}
process.on('exit', stopAllNow);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopAllNow();
    process.exit(130);
  });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    console.error('[qa:web]', err);
    stopAllNow();
    process.exit(1);
  });
}
setTimeout(() => {
  console.error(
    `[qa:web] still running after ${Math.round(MAX_MS / 1000)}s; stopping everything it started.`
  );
  stopAllNow();
  process.exit(124);
}, MAX_MS).unref();

async function waitForUrl(url, timeoutMs, what = url) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch (e) {
    return e?.cause?.code === 'ECONNREFUSED';
  }
}

let mock = null;
async function startMock(...flags) {
  await stop(mock);
  mock = run('mock', path.join(ROOT, 'node_modules/.bin/tsx'), [
    'dev/mock.ts',
    '--http',
    '--cors',
    '--port',
    String(MOCK_PORT),
    '--state',
    mockState,
    ...flags,
  ]);
  await waitForUrl(`${MOCK}/dev/link`, 30_000, 'the mock Mac');
  log(`mock up ${flags.join(' ')}`);
}
async function stopMock() {
  await stop(mock);
  mock = null;
  log('mock stopped');
}
/** Gone without a goodbye, as a crash or a dropped network would look. */
async function killMock() {
  if (mock && mock.exitCode === null) {
    const gone = new Promise((resolve) => mock.once('exit', resolve));
    try {
      process.kill(-mock.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await gone;
  }
  mock = null;
  log('mock killed');
}

// ---- CDP ---------------------------------------------------------------------------

class Page {
  #ws;
  #id = 0;
  #pending = new Map();
  errors = [];
  /** Called with every CDP event (the send phase's screencast). */
  listeners = new Set();

  static async attach(wsUrl) {
    const page = new Page();
    page.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      page.#ws.addEventListener('open', resolve, { once: true });
      page.#ws.addEventListener('error', reject, { once: true });
    });
    page.#ws.addEventListener('message', (ev) => page.#onMessage(String(ev.data)));
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }

  #onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method) for (const fn of this.listeners) fn(msg);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.errors.push(`exception: ${(d.exception?.description ?? d.text).split('\n')[0]}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.errors.push(`error: ${text.split('\n')[0].slice(0, 300)}`);
    }
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return res.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 60_000, `load ${url}`);
  }

  async waitFor(expression, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval(`!!(${expression})`).catch(() => false)) return true;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await sleep(150);
    }
  }

  async text() {
    return (await this.eval('document.body.innerText')) ?? '';
  }

  /** Click the centre of the first visible element matching `finder` (JS returning an element). */
  async clickWhere(finder, what) {
    const box = await this.eval(`(() => {
      const el = (${finder})();
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`Nothing to click: ${what}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
      await sleep(30);
    }
  }

  /** The innermost visible element whose text is exactly `text`. */
  clickText(text) {
    return this.clickWhere(
      `() => [...document.querySelectorAll('body *')].filter((e) => e.innerText?.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width).pop()`,
      text
    );
  }

  /** The first element whose accessibility label ends with `label`. */
  clickLabel(label) {
    return this.clickWhere(
      `() => [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label').endsWith(${JSON.stringify(label)}))`,
      label
    );
  }

  /** Focus the first text field (or the one `selector` names) and type `text` into it. */
  async type(text, selector = 'input, textarea') {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (!ok) throw new Error(`No field to type into: ${selector}`);
    await this.send('Input.insertText', { text });
  }

  /** `clip`: `{ x, y, width, height, scale }` in CSS pixels, for a close-up. */
  async screenshot(file, clip) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
    });
    await writeFile(file, Buffer.from(data, 'base64'));
  }

  close() {
    this.#ws.close();
  }
}

let chrome = null;
async function startChrome() {
  if (!CHROME) throw new Error('No Chrome or Chromium found');
  // A headless Chrome an earlier, interrupted run left behind (matched by
  // the profile name below, or the one older versions used) is closed first:
  // a stray one is where macOS can send the user's own links.
  const swept = sweepOrphans('qa-web', [/qa-web-[^/\s]+\/chrome(\s|$)/]);
  if (swept) log(`closed ${swept} headless Chrome left by an earlier run`);
  chrome = run('chrome', CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    // Ours alone, under TMPDIR, and named so the sweep above can find it.
    `--user-data-dir=${path.join(work, 'shipstudio-cdp-qa-web-chrome')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    'about:blank',
  ]);
  await waitForUrl(`http://127.0.0.1:${CDP_PORT}/json/version`, 20_000, 'Chrome');
}

/** One tab for the whole run: the app's storage (pairing, cache) carries across shots. */
async function openTab() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const page = await Page.attach(target.webSocketDebuggerUrl);
  await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  return page;
}

async function setTheme(page, theme) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });
}

// ---- Capturing ----------------------------------------------------------------------

/** Elements cut off with an ellipsis or a line clamp, as harness-capture reports them. */
const CLIPPED_TEXT_PROBE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (out.length >= 25) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const ellipsis = cs.textOverflow === 'ellipsis';
    const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    if (!ellipsis && !clamped) continue;
    const overX = el.scrollWidth > el.clientWidth + 1;
    const overY = clamped && el.scrollHeight > el.clientHeight + 1;
    if (!overX && !overY) continue;
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text) out.push(text.slice(0, 120));
  }
  return out;
})()`;

/** The tallest scrolling view: the chat list or a sheet's body. */
const FIND_SCROLLER = `(() => {
  const els = [...document.querySelectorAll('div')].filter((e) =>
    e.scrollHeight > e.clientHeight + 20 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));
  els.sort((a, b) => b.clientHeight - a.clientHeight);
  window.__qaScroller = els[0] ?? null;
  return els[0] ? Math.ceil(els[0].scrollHeight / (els[0].clientHeight * 0.85)) : 0;
})()`;

const shots = [];
const wanted = (name) => !ONLY || ONLY.split(',').some((o) => name.startsWith(o));

/**
 * The pairing screens before anything is paired, in each theme: the welcome
 * (Tailscale on, then scan: a screen each), "Reaching <Mac>…" against a server that never
 * answers, and the failure that follows (identity timeout, then the
 * diagnosis). `d` is the mock's own link, with its route swapped.
 */
async function prePairShots(page, d) {
  const silent = http.createServer(() => {
    // Never answers: a tailnet host this phone can't reach.
  });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const link = JSON.parse(Buffer.from(d, 'base64url').toString());
  link.routes = [{ kind: 'tailscale', url: `http://localhost:${silent.address().port}` }];
  const unreachable = Buffer.from(JSON.stringify(link)).toString('base64url');
  try {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      if (wanted(`pair-start-${theme}`)) {
        await page.goto(`${WEB}/pair`);
        await page.waitFor(
          `document.body.innerText.includes('Turn on Tailscale on this phone')`,
          180_000,
          'the welcome'
        );
        await sleep(800);
        await capture(page, `pair-start-${theme}`, {
          route: '/pair',
          check:
            '“Step 1 of 2”, “Turn on Tailscale on this phone”, why, three lines (installed, same account, switched on), Get/Open Tailscale, then one big “It’s on — next”',
          theme,
        });
      }
      if (wanted(`pair-scan-${theme}`)) {
        await page.goto(`${WEB}/pair`);
        await page.waitFor(
          `document.body.innerText.includes('It’s on — next')`,
          180_000,
          'the welcome'
        );
        await page.clickText('It’s on — next');
        await page.waitFor(
          `document.body.innerText.includes('Scan the code on your Mac')`,
          10_000,
          'the scan step'
        );
        await sleep(500);
        await capture(page, `pair-scan-${theme}`, {
          route: '/pair (step 2)',
          check:
            '“Step 2 of 2”, “Scan the code on your Mac”, where the code is on the Mac, one big “Scan the code”, then “Paste a pairing link instead” and Back',
          theme,
        });
      }
      if (!wanted(`pair-reaching-${theme}`) && !wanted(`pair-unreachable-${theme}`)) continue;
      await page.goto(`${WEB}/pair?d=${unreachable}`);
      await page.waitFor(
        `[...document.querySelectorAll('body *')].some((e) => e.innerText?.trim() === 'Pair')`,
        180_000,
        'the confirm screen'
      );
      await sleep(500);
      await page.clickText('Pair');
      await page.waitFor(`document.body.innerText.includes('Reaching')`, 10_000, 'Reaching');
      await sleep(600);
      await capture(page, `pair-reaching-${theme}`, {
        route: '/pair?d=… (Mac never answers)',
        check:
          '“Reaching <Mac>…” with a spinner, the host, “Nothing has been sent to it yet”; never “Allow on your Mac”',
        theme,
      });
      await page.waitFor(`document.body.innerText.includes('Try again')`, 30_000, 'the failure');
      await sleep(600);
      await capture(page, `pair-unreachable-${theme}`, {
        route: '/pair?d=… (Mac never answers)',
        check:
          '“Can’t reach <Mac>”, “Check these, then try again.”, then three rows with a dot each: the Mac awake with the app open (can’t tell), Tailscale on with the same account (Open Tailscale), this phone paired (not yet); no host or port anywhere until Details is opened; Try again and Back',
        theme,
      });
    }
  } finally {
    silent.closeAllConnections();
    silent.close();
    await setTheme(page, THEMES[0]);
  }
}

/**
 * "Try the demo" from the welcome screen, with no Mac at all (the mock
 * isn't involved): the sample agents, a chat with a card waiting, a result,
 * a reply to something sent, and Settings. The demo lives in memory, so it
 * is walked by tapping, never by loading a route (a reload ends it).
 */
async function demoShots(page) {
  const back = () => page.eval('history.back()');
  // In-app navigation without a reload (which would end the demo): the
  // router follows the browser's history.
  const open = (route) =>
    page.eval(
      `history.pushState(null, '', ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent('popstate'))`
    );
  const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.goto(`${WEB}/pair`);
    await page.waitFor(has('Try the demo'), 180_000, 'the welcome');
    await sleep(500);
    if (wanted(`demo-welcome-${theme}`))
      await capture(page, `demo-welcome-${theme}`, {
        route: '/pair',
        check: '“Try the demo” under the Tailscale step, with “No Mac nearby?…” under it',
        theme,
      });
    await page.clickText('Try the demo');
    await page.waitFor(has('This is the demo'), 20_000, 'the demo');
    await sleep(1200);
    if (wanted(`demo-agents-${theme}`))
      await capture(page, `demo-agents-${theme}`, {
        route: '/pair → Try the demo',
        check:
          '“This is the demo” card first, with Pair your Mac; five sample agents: Inbox waiting on you, Books working',
        theme,
      });
    await open('/chat/inbox');
    await page.waitFor(has('Send an email as you'), 20_000, 'the Inbox chat');
    await sleep(1200);
    if (wanted(`demo-approval-${theme}`))
      await capture(page, `demo-approval-${theme}`, {
        route: '(demo) Inbox',
        check: 'The bar “Demo · sample agents” over the composer; the reply to Dana and its card',
        theme,
      });
    await back();
    await sleep(800);
    await open('/chat/site');
    await page.waitFor(has('Winter menu page'), 20_000, 'the Website chat');
    await sleep(1200);
    if (wanted(`demo-result-${theme}`))
      await capture(page, `demo-result-${theme}`, {
        route: '(demo) Website',
        check: 'The result card: what it checked and what it didn’t',
        theme,
      });
    await back();
    await sleep(800);
    await open('/chat/research');
    await page.waitFor(has('Copper Kettle'), 20_000, 'the Research chat');
    await page.type('Ask Hillside for a sample');
    await page.clickLabel('Send').catch(() => {});
    await page
      .waitFor(has('This is the demo, so I can’t'), 10_000, 'the demo’s reply')
      .catch((e) => page.errors.push(e.message));
    await sleep(800);
    if (wanted(`demo-reply-${theme}`))
      await capture(page, `demo-reply-${theme}`, {
        route: '(demo) Research, after a send',
        check: 'The table, the message sent, and the demo’s reply saying it can’t do real work',
        theme,
      });
    await back();
    await sleep(800);
    await open('/chat/chief');
    await page.waitFor(has('Two things need you'), 20_000, 'the Chief');
    await sleep(1200);
    if (wanted(`demo-chief-${theme}`))
      await capture(page, `demo-chief-${theme}`, {
        route: '(demo) Chief of Staff',
        check: 'The morning brief: a routine line, then two things that need you',
        theme,
      });
    await open('/projects');
    await page.waitFor(has('northwind-site'), 20_000, 'Projects');
    await sleep(800);
    if (wanted(`demo-projects-${theme}`))
      await capture(page, `demo-projects-${theme}`, {
        route: '(demo) Projects',
        check: '“This is the demo” card, then the sample project',
        theme,
      });
    await open('/settings');
    await page.waitFor(has('Leave the demo'), 20_000, 'Settings');
    await sleep(800);
    if (wanted(`demo-settings-${theme}`))
      await capture(page, `demo-settings-${theme}`, {
        route: '(demo) Settings',
        check: 'A Demo section with “Leave the demo and pair your Mac”, no Forget this Mac',
        theme,
      });
  }
}

async function capture(page, name, { route, check, theme }) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot(file);
  const clipped = await page.eval(CLIPPED_TEXT_PROBE).catch(() => []);
  shots.push({ name, route, theme, check, errors: [...new Set(page.errors)], clipped });
  page.errors = [];
  log('shot', name);
}

/**
 * One screen: load `route`, wait for `ready` (text that proves it rendered),
 * optionally act, then capture it (and its scroll pages when `pages` is set).
 */
async function screen(page, theme, s) {
  const base = `${s.name}-${theme}`;
  if (!wanted(base)) return;
  try {
    if (s.route) {
      await page.goto(WEB + s.route);
      if (s.ready) {
        await page
          .waitFor(`document.body.innerText.includes(${JSON.stringify(s.ready)})`, 20_000, s.ready)
          .catch((e) => page.errors.push(`not ready: ${e.message}`));
      }
      await sleep(s.settle ?? 1500);
    }
    if (s.act) await s.act(page);
    if (!s.pages) {
      await capture(page, base, { route: s.route ?? '(in place)', check: s.check, theme });
      if (s.frames) await s.frames(page, theme);
      // Undo what the shot changed (a draft survives reloads), so later shots start clean.
      if (s.after) await s.after(page);
      return;
    }
    const n = Math.min(s.pages, await page.eval(FIND_SCROLLER));
    for (let i = 0; i < Math.max(1, n); i++) {
      await page.eval(
        `window.__qaScroller && (window.__qaScroller.scrollTop = ${i} * window.__qaScroller.clientHeight * 0.85)`
      );
      await sleep(700);
      await capture(page, `${base}-p${i}`, { route: s.route, check: s.check, theme });
    }
  } catch (e) {
    shots.push({
      name: base,
      route: s.route,
      theme,
      check: s.check,
      errors: [`failed: ${e.message}`],
      clipped: [],
    });
    log('FAILED', base, e.message);
  }
}

// ---- What to capture ----------------------------------------------------------------

/** Empty the message field (select all, Backspace), so the draft doesn't carry into later shots. */
async function clearField(page) {
  await page.eval(`document.querySelector('textarea')?.select()`);
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }
  await sleep(800);
}

/** Click the element reading exactly `text` inside the one with `data-testid` `testId`. */
const clickIn = (page, testId, text) =>
  page
    .clickWhere(
      `() => [...document.querySelectorAll('[data-testid=${JSON.stringify(testId)}] *')].filter((e) => e.innerText?.trim() === ${JSON.stringify(text)} && e.getBoundingClientRect().width).pop()`,
      `${testId} ${text}`
    )
    .then(() => sleep(700));

const scrollToText = (text) => async (page) => {
  await page.eval(FIND_SCROLLER);
  for (let i = 0; i < 16; i++) {
    const seen = await page.eval(`(() => {
      const el = [...document.querySelectorAll('body *')].filter((e) => e.innerText?.trim() === ${JSON.stringify(text)}).pop();
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    if (seen) return sleep(600);
    await page.eval(
      'window.__qaScroller && (window.__qaScroller.scrollTop += window.__qaScroller.clientHeight * 0.6)'
    );
    await sleep(500);
  }
  throw new Error(`never found "${text}"`);
};

/** Whether Catch up's bottom bar has a button labelled `label`. */
const CATCHUP_HAS = (label) =>
  `!![...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)})`;

/** Ask the mock Mac to do what the desk would (`--probe` only). */
const desk = (what) => async () => {
  await fetch(`${MOCK}/dev/probe?do=${what}`);
  await sleep(1500);
};

/** Scroll until an element whose own text contains `text` is in view. */
const scrollToIncludes = (text) => async (page) => {
  await page.eval(FIND_SCROLLER);
  for (let i = 0; i < 20; i++) {
    const seen = await page.eval(`(() => {
      const el = [...document.querySelectorAll('body *')].filter((e) => e.innerText?.includes(${JSON.stringify(text)})).pop();
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    if (seen) return sleep(600);
    await page.eval(
      'window.__qaScroller && (window.__qaScroller.scrollTop -= window.__qaScroller.clientHeight * 0.6)'
    );
    await sleep(400);
  }
  throw new Error(`never found "${text}"`);
};

/** The states the other phases miss (`--probe`, dev/mock-probe.ts). */
const PROBE = [
  // docs/internal/failure-states.md: each failure with its one fix.
  {
    name: 'probe-failure-offline',
    route: '/chat/offline',
    ready: 'Stock Check',
    check:
      'The network went mid-turn: a red card headed “Didn’t finish”, the Mac’s sentence once under it (“Claude Code couldn’t reach Anthropic over the network. Retry once this Mac is back online.”), and Retry (sends “Check stock levels…” again); no raw error',
  },
  {
    name: 'probe-failure-gone',
    route: '/chat/gone',
    ready: 'Invoicer',
    check:
      'Its engine is gone: “Claude Code isn’t installed”, the note “Install Claude Code on your Mac, then send it again.”, Connection details; no os error',
  },
  {
    name: 'probe-failure-signed-out',
    route: '/chat/signedout',
    ready: 'Returns',
    check:
      'Signed out: “Claude Code is signed out”, the note “Sign in to Claude Code on your Mac, then send it again.”, Connection details',
  },
  {
    name: 'probe-needs-you-failures',
    route: '/needs',
    ready: 'Needs you',
    act: () => sleep(1500),
    pages: 3,
    check:
      'Each failure row says its state once as the title (“Didn’t finish”, “Not installed”, “Signed out”) and the reason under it, never “Didn’t finish” twice',
  },
  {
    name: 'probe-catch-up',
    route: '/catch-up',
    ready: 'Catch up',
    act: () => sleep(1500),
    pages: 2,
    check:
      'Catch up: risky requests (Temp Helper’s delete, Deploys’ production deploy) wear the warning icon and say Review, never Allow on the row; only short low-risk ones are answered in place; the 19-line script says Review; step-in and crossover open',
  },
  {
    name: 'probe-request-risky',
    route: '/request?agent=doomed&id=doomed_001',
    ready: 'Request',
    act: () => sleep(1200),
    check:
      'A request the Mac marked risky, in full: the warning icon on the card, “rm -r ~/Exports/2024”, Deny outlined and Allow in the danger style (never the neutral answer)',
  },
  {
    name: 'probe-request-long',
    route: '/request?agent=script&id=script_001',
    ready: 'Request',
    act: () => sleep(1200),
    pages: 2,
    check:
      'Request in full: every one of the 19 lines (no “Show all”), Deny · Allow pinned at the bottom',
  },
  // The two screens a request is answered on, at the largest text size: the
  // words wrap rather than clip, and Deny · Allow stay whole and reachable.
  ...[
    {
      name: 'probe-needs-you-largest',
      to: '/needs',
      ready: 'Needs you',
      pages: 2,
      check:
        'Needs you at Largest: names, titles and lines wrap with nothing cut through; Deny · Allow and Review whole, never squeezed into one line',
    },
    {
      name: 'probe-request-risky-largest',
      to: '/request?agent=doomed&id=doomed_001',
      ready: 'Request',
      pages: 2,
      check:
        'The risky request at Largest: the command wraps, the warning icon beside the title, Deny and Allow side by side or stacked, each label whole',
    },
  ].map(({ to, ready, ...shot }) => ({
    ...shot,
    route: '/settings',
    ready: 'Largest',
    act: async (page) => {
      await scrollToText('Largest')(page);
      await page.clickText('Largest');
      await sleep(400);
      await page.goto(`${WEB}${to}`);
      await page.waitFor(
        `document.body.innerText.includes(${JSON.stringify(ready)})`,
        20_000,
        ready
      );
      await sleep(1500);
    },
    after: async (page) => {
      await page.goto(`${WEB}/settings`);
      await page.waitFor(`document.body.innerText.includes('Largest')`, 20_000, 'Largest');
      await scrollToText('Largest')(page);
      await page.clickText('Default');
      await sleep(400);
    },
  })),
  {
    name: 'probe-fifty',
    route: '/agents',
    ready: 'Chief of Staff',
    pages: 4,
    check:
      'Fifty agents: the list scrolls, every row one line of name over its line, the long-named one cut with an ellipsis (never over its time); Browser Helper, Deploys and Temp Helper waiting on you',
  },
  {
    name: 'probe-long-chat',
    route: '/chat/long',
    ready: 'supplier thread',
    pages: 3,
    check:
      'A very long agent name in the header (cut, not wrapping over the buttons); a long question and a fifteen-paragraph reply that wrap and scroll',
  },
  {
    name: 'probe-long-sheet',
    route: '/agent/long',
    ready: 'Regional Wholesale',
    check: 'The agent sheet with a very long name and role: both wrap in full, nothing overlaps',
  },
  {
    name: 'probe-step-in',
    route: '/chat/browse',
    ready: 'needs you in its browser',
    check:
      'The step-in card as the desk draws it: a globe, the title with the reason, the site · page title under it, “Its tab shows here and you do it by touch…”, Not now (outlined) and Step in (neutral answer, never the accent); no Allow',
  },
  {
    name: 'probe-stale-card',
    route: '/chat/stale',
    ready: 'Ship the price fix',
    act: desk('desk-answer'),
    check:
      'Answered on the desk while open here: the card is a receipt (“Allowed”), no buttons, and Deploys is working',
  },
  {
    name: 'probe-deleted',
    route: '/chat/doomed',
    ready: 'Delete files',
    act: desk('delete'),
    check:
      'Deleted on the desk while its card was open here: “This agent was removed”, nothing to answer or send',
  },
  {
    name: 'probe-mid-turn',
    route: '/chat/builder',
    ready: 'gift-card',
    check: 'Builder working (the live line), its header saying “on Work”',
  },
  {
    name: 'probe-accounts',
    route: '/settings',
    ready: 'Settings',
    act: scrollToText('CLAUDE CODE ACCOUNTS'),
    check:
      'Three Claude accounts: sam@example.com in use; Work out of usage (amber name, when it refills, “Builder runs only on this one”), no Use now; Personal “Not signed in”, no Use now; arrows to reorder',
  },
  {
    name: 'probe-runs-on',
    route: '/controls?id=builder',
    ready: 'Builder',
    act: scrollToText('RUNS ON'),
    check:
      'Runs on: Any account, then the three Claude accounts, Work ticked and “out of usage now”; Personal says “Not signed in”',
  },
  {
    name: 'probe-quiet-hours',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    act: scrollToIncludes('Sweep the shop inbox'),
    check:
      'Quiet hours: the ask, the Chief’s one line saying what is set, then the routine’s line (“Routine · late, was due …”, as the desk says it) and its answer saying it waited',
  },
  {
    name: 'probe-morning-brief',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    act: scrollToIncludes('Your checks'),
    check:
      'The morning brief: one reply from the Chief, its first line the gist (“Morning brief, Monday 9 November: 1 card waits for you, …”), then bold Needs you / Didn’t work / Today / Since yesterday / Usage / Your checks, each a few bullets; the calendar items nested; “9:30”, never “9\\:30”; the Gmail line says it couldn’t check and why. No link',
  },
  {
    name: 'probe-crossover',
    route: '/chat/ledger',
    ready: 'Carry on with Claude Code',
    check:
      'The crossover card, as the desk draws it: a swap icon, “Your Codex account is out until …. Carry on with Claude Code until then?”, the paragraph, then Wait and Just this time outlined and Always neutral strong, last; no ⋯, no Allow or Deny',
  },
  {
    name: 'probe-crossover-answered',
    route: '/chat/ledger',
    ready: 'Carry on with Claude Code',
    act: async (page) => {
      await sleep(900);
      await page.clickWhere(
        `() => [...document.querySelectorAll('body *')].filter((e) => e.innerText?.trim() === 'Always' && e.getBoundingClientRect().width).pop()`,
        'Always'
      );
      await sleep(1800);
    },
    check:
      'Answered Always: the card is one receipt, “Always · carrying on with Claude Code whenever Codex is out” (the desk’s words)',
  },
  {
    name: 'probe-carried',
    route: '/settings',
    ready: 'Settings',
    act: scrollToText('CODEX ACCOUNTS'),
    check:
      'Codex accounts: a neutral pill “Codex out · on Claude Code until …” under the heading (never amber), then its account “Out of usage until …”',
  },
  {
    name: 'probe-slack',
    route: '/chat/launch',
    ready: 'Reply in Slack?',
    check:
      'An ask from Slack: the bubble with “From Slack · #launch” under it, the reply, the “Reply in Slack?” card quoting the exact words with ⋯ · Deny · Allow (neutral), and the quiet line “Sam asked in Slack …”',
  },
];

/** The same Mac after a restart cut Builder's turn off (`--probe --restarted`). */
const PROBE_RESTARTED = [
  {
    name: 'probe-restarted',
    route: '/chat/builder',
    ready: 'gift-card',
    check:
      'After the Mac restarted mid-turn: no live line, the turn ends on “Interrupted: the app closed while this agent was working…” with Continue, never Retry',
  },
  // Last: the desk removes this phone (in memory only; the next theme's Mac still knows it).
  {
    name: 'probe-revoked-connection',
    route: '/connection',
    ready: 'This phone',
    act: async () => {
      await fetch(`${MOCK}/dev/probe?do=revoke`);
      await sleep(3000);
    },
    check:
      'Removed on the desk: “Not paired any more”, the app’s sentence (“Your agents are still on … Pair again to see them here.”), never the Mac’s raw refusal; the one button is Pair again, no Open Tailscale',
  },
];

/** Connected, everything the mock seeds. */
const LIVE = [
  {
    name: 'agents',
    route: '/agents',
    ready: 'Chief of Staff',
    check:
      'Chief and pinned, then by activity, what needs you first; no “N agents need your OK” bar (the Catch up tab counts it); each waiting row keeps only its own label. Above them, the usage glance as the desk sidebar says it',
  },
  {
    name: 'projects',
    route: '/projects',
    ready: 'acme-site',
    check: 'Project list, sessions per project',
  },
  { name: 'search', route: '/search', check: 'Empty search' },
  {
    name: 'catch-up',
    route: '/catch-up',
    ready: 'Catch up',
    act: () => sleep(1500),
    pages: 3,
    check:
      'Catch up: "N things need you", then one card per agent (its key, name, count), its rows one line of what is asked and one of why; the tab badge is the number of rows; short low-risk ones Deny · Allow (neutral, compact), risky or long ones Review, keys/logins their own action, copies Discard · Keep changes; then "Since you last caught up" from real records',
  },
  {
    name: 'catchup-first',
    route: '/one-at-a-time',
    ready: 'Catch up',
    act: () => sleep(1200),
    check: 'Catch up: "1 of N", the bar, one card; Allow · Deny (neutral) over Chat · Next',
  },
  {
    name: 'catchup-approval',
    route: '/one-at-a-time',
    ready: 'Catch up',
    act: async (page) => {
      await sleep(1000);
      // On to the first request answered right here: Allow · Deny under the thumb.
      for (let i = 0; i < 30; i++) {
        if (await page.eval(CATCHUP_HAS('Allow'))) break;
        await page.clickLabel('Next');
        await sleep(700);
      }
      await sleep(900);
    },
    check: 'A request: what it said, the capped card, Allow (neutral) · Deny over Chat · Next',
  },
  {
    name: 'usage-ring',
    route: '/chat/site',
    ready: 'Acme Site',
    act: () => sleep(1200),
    check: 'Header: the usage ring left of ⓘ, 38% of the 5-hour window',
  },
  {
    name: 'usage-sheet',
    route: '/usage?id=site',
    ready: 'Usage',
    act: () => sleep(1500),
    check:
      'Usage: context 90%, 5-hour with its pace line ("At this pace you’ll hit the limit in about an hour, before it resets at …" + "Estimate from 6 readings…"), weekly (All models, Opus), every account',
  },
  {
    name: 'usage-plan-controls',
    route: '/usage?id=site',
    ready: 'Usage',
    act: async (page) => {
      await sleep(1500);
      await scrollToText('Ideas for leftover usage')(page);
    },
    check:
      'Usage, under the accounts: "How agents use your limits" as a segmented Normal / Save / Use it all (the mode in force raised, neutral), its full name and one line under it; then "Ideas for leftover usage" with how many wait, a field with Add, and "Give agents something to do"',
  },
  {
    name: 'catchup-done',
    route: '/one-at-a-time',
    ready: 'Catch up',
    act: async (page) => {
      await sleep(1000);
      for (let i = 0; i < 40; i++) {
        if ((await page.text()).includes('All caught up')) break;
        await page.clickLabel('Next');
        await sleep(600);
      }
      await sleep(600);
    },
    check: 'All caught up: a calm check and Done',
  },
  {
    name: 'chat-chief',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    pages: 3,
    check: 'Import consent card: prose detail that wraps, a source line like the review card',
  },
  {
    name: 'chat-site',
    route: '/chat/site',
    ready: 'Acme Site',
    pages: 3,
    check: 'Task reply and Phone preview cards share title/source anatomy; card meta is quiet text',
  },
  {
    name: 'chat-design',
    route: '/chat/design',
    ready: 'Designer',
    pages: 2,
    check: 'Approvals, lines',
  },
  {
    name: 'chat-fin',
    route: '/chat/fin',
    ready: 'Finance',
    pages: 2,
    check: 'Secret card on a route that cannot carry secrets: note slot, hugging Deny',
  },
  {
    name: 'chat-ops',
    route: '/chat/ops',
    ready: 'Ops',
    pages: 2,
    check: '"Start of your conversation" is a Line with no stacked padding',
  },
  {
    name: 'signin-linkedin',
    route: '/signin?agentId=qa&requestId=req_login_linkedin',
    ready: 'Close',
    settle: 2500,
    check: 'Sign in on the Mac from here, on a route that cannot carry it: refused in words, Close',
  },
  {
    name: 'chat-qa',
    route: '/chat/qa',
    ready: 'QA 2',
    pages: 2,
    check: 'Consecutive Lines collapse to the Line gap',
  },
  {
    name: 'chat-fixtures',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    pages: 6,
    check:
      'Every message kind: receipts, failure cards, diff tints span the box, To/From Ops, folded result line wraps',
  },
  // Blocks (`show`): every kind, in one chat (dev/mock-blocks.ts).
  {
    name: 'blocks-chat',
    route: '/chat/blocks',
    ready: 'Blocks',
    pages: 10,
    check:
      'Every block kind: metric tiles with deltas and a sparkline, a two-series line chart with a legend, a stacked bar, a donut with its slices listed, a sortable table with Show all, facts, a checklist with its count, steps with done/current/failed marks, two callouts with icon and word, link chips with their domain, a tinted diff, an image; the comparison answered (Picked on Vercel), the choices and form still live with neutral answers',
  },
  {
    name: 'blocks-brief',
    route: '/chat/brief',
    ready: 'Brief',
    pages: 4,
    check:
      'The morning brief as one calm page: the gist, Needs you, an amber Didn’t work note, Today and Since yesterday tables (times and names never broken mid-word, counts under right-aligned headers), Usage, Your checks',
  },
  {
    name: 'blocks-tooltip',
    route: '/chat/blocks',
    ready: 'Blocks',
    act: async (page) => {
      await scrollToText('Signups per day')(page);
      await page.clickWhere(
        `() => document.querySelector('[data-testid="chart-plot"]')`,
        'a chart'
      );
      await sleep(500);
    },
    check:
      'Touching a chart: its column stands out (the others dim) and a tooltip names the day with every series’ value',
  },
  {
    name: 'chat-table',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    act: scrollToText('Lighthouse'),
    check:
      'The launch table: Check and Owner start-aligned; Score (98%, 100%, —, 1,204.5) right-aligned with its digits lined up, header too',
  },
  {
    name: 'result-tested',
    route: '/chat/site',
    ready: 'Acme Site',
    act: scrollToText('Watch live'),
    check:
      'A tested card: the outcome, what is broken, console errors, a paging strip of step screenshots with captions, Watch live as a text action',
  },
  {
    name: 'result-ask',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: scrollToText('Ask for changes'),
    check: 'A result card with Ask for changes (needs welcome.features)',
  },
  // Showing the work: the Designer's café refresh (dev/mock-server.ts, "Moss & Co.").
  {
    name: 'show-compare',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await scrollToText('Side by side')(page);
      await sleep(2000);
    },
    check:
      'One card for a three-page visual result: Home / Menu / Visit switcher, a slider with Before and After tags and a grip, the caption, Side by side, Watch live and Ask for changes',
  },
  {
    name: 'show-side',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await scrollToText('Side by side')(page);
      await page.clickText('Menu');
      await sleep(300);
      await page.clickText('Side by side');
      await sleep(800);
    },
    check:
      'Menu page side by side: two pictures, each with its caption (Before; Menu, prices set larger), Slider to go back',
  },
  {
    name: 'show-checkpoint',
    route: '/chat/design',
    ready: 'Designer',
    act: scrollToText('Moss & Co. refresh · v1 · earlier version'),
    check:
      'The checkpoint (v1, “Partway through”) folds to a line under v2; the reply’s links are chips: After with Watch live, localhost:5173 a plain “Running on your Mac” chip',
  },
  {
    name: 'show-links',
    route: '/chat/design',
    ready: 'Designer',
    act: scrollToText('Running on your Mac · localhost:5173'),
    check:
      'Under the reply: “After · Running on your Mac · localhost:3401” with Watch live, then a plain chip for localhost:5173, no link, no arrow',
  },
  {
    name: 'show-gallery',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await scrollToText('Side by side')(page);
      await page.clickText('Menu');
      await sleep(300);
      await page.clickText('Side by side');
      await sleep(500);
      await page.clickLabel('Menu, prices set larger, image');
      await sleep(1800);
    },
    check:
      'The viewer on the Menu after-shot: Done, “n of N” counter, Share, the caption “Menu, prices set larger” over black; swiping pages to the other pictures in the chat',
    after: async (page) => {
      await page.clickText('Done').catch(() => {});
      await sleep(500);
    },
  },
  // Dictation against the scripted recognizer (dev/web/expo-speech-recognition.ts).
  {
    name: 'dictation-listening',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.clickLabel('Dictate');
      await sleep(2300);
    },
    check:
      'Listening: × in the +’s place, words streaming (the last lighter), the waveform and 0:0x, then Stop and Send (accent); no mic',
    after: async (page) => {
      await page.clickLabel('Cancel dictation').catch(() => {});
      await sleep(600);
    },
  },
  {
    name: 'dictation-done',
    // A chat no later shot opens: the kept words are its draft until sent.
    route: '/chat/fin',
    ready: 'Finance',
    act: async (page) => {
      await page.clickLabel('Dictate');
      // The sentence, then three seconds of quiet: it stops by itself.
      await sleep(9500);
    },
    check: 'Stopped by the silence: the whole sentence in the field, normal ink, mic and Send back',
    after: async (page) => {
      await page.clickLabel('Send').catch(() => {});
      await sleep(800);
    },
  },
  {
    name: 'dictation-long',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.eval(`globalThis.__qaDictation = { long: true }`);
      await page.clickLabel('Dictate');
      await sleep(5200);
    },
    check:
      'A long dictation while listening: the waveform and 0:0x in a slim row over the field; the words use the full width beside Stop and Send, wrapping like typed text, six lines then scrolled to the newest',
    after: async (page) => {
      await page.clickLabel('Cancel dictation').catch(() => {});
      await page.eval(`globalThis.__qaDictation = {}`);
      await sleep(600);
    },
  },
  {
    name: 'dictation-long-done',
    route: '/chat/fin',
    ready: 'Finance',
    act: async (page) => {
      await page.eval(`globalThis.__qaDictation = { long: true }`);
      await page.clickLabel('Dictate');
      await sleep(5000);
      await page.clickLabel('Stop dictating');
      await sleep(800);
    },
    check:
      'Stopped, keep editing: the paragraph in the field at the same width it had while listening, no row over it, mic and Send back; still on its last line, the top lines fading out',
    after: async (page) => {
      await page.eval(`globalThis.__qaDictation = {}`);
      await page.clickLabel('Send').catch(() => {});
      await sleep(800);
    },
  },
  // The same two at Largest: the field's lines grow with the words, and still follow the end.
  ...[
    { name: 'dictation-long-largest', stop: false },
    { name: 'dictation-long-done-largest', stop: true },
  ].map(({ name, stop }) => ({
    name,
    route: '/settings',
    ready: 'Largest',
    act: async (page) => {
      await scrollToText('Largest')(page);
      await page.clickText('Largest');
      await sleep(400);
      // The Designer's chat, idle (Finance is still answering the shot before's Send).
      await page.goto(`${WEB}/chat/design`);
      await page.waitFor(`document.body.innerText.includes('Designer')`, 20_000, 'Designer');
      await sleep(1500);
      await page.eval(`globalThis.__qaDictation = { long: true }`);
      await page.clickLabel('Dictate');
      await sleep(5000);
      if (stop) {
        await page.clickLabel('Stop dictating');
        await sleep(800);
      }
    },
    check: stop
      ? 'Largest, stopped: the paragraph at the large size, its last line in view, the top lines fading out, no line cut through'
      : 'Largest, listening: the newest words on the last line in view, the top lines fading out, Stop and Send on the last line',
    after: async (page) => {
      if (!stop) await page.clickLabel('Cancel dictation').catch(() => {});
      await page.eval(`globalThis.__qaDictation = {}`);
      if (stop) {
        // Clear the kept words rather than send them, so the Designer stays idle for later shots.
        await page.eval(`document.querySelector('textarea')?.select()`);
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        });
      }
      await sleep(800);
      await page.goto(`${WEB}/settings`);
      await page.waitFor(`document.body.innerText.includes('Largest')`, 20_000, 'Largest');
      await scrollToText('Largest')(page);
      await page.clickText('Default');
      await sleep(400);
    },
  })),
  {
    name: 'dictation-denied',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.eval(`globalThis.__qaDictation = { deny: true }`);
      await page.clickLabel('Dictate');
      await sleep(900);
    },
    check:
      'Permission refused: the plain line over the field and an Open Settings chip; the mic still there',
    after: async (page) => {
      await page.eval(`globalThis.__qaDictation = {}`);
    },
  },
  // A voice message: the mic held (pressed, not let go) while the scripted recognizer hears.
  {
    name: 'voice-held',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      const box = await page.eval(`(() => {
        const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === 'Dictate');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) throw new Error('No mic to hold');
      globalThis.__qaHeld = box;
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...box,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await sleep(2600);
    },
    check:
      'Held: the field keeps its capsule shape with the words streaming in (the last lighter), the mic is the accent and still under the finger, no ×/Stop/Send, and the line over the field says “Let go to send · slide away to cancel”',
    after: async (page) => {
      // Slide away before letting go: nothing is sent, so the Designer stays idle.
      const box = globalThis.__qaHeld;
      const away = { x: box.x - 160, y: box.y - 160 };
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...away, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...away,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(800);
    },
  },
  // Listen: hold a reply, pick Listen; the web's voice is a silent stand-in (dev/web/expo-speech.ts).
  {
    name: 'listen-reading',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      const box = await page.eval(`(() => {
        const rows = [...document.querySelectorAll('[tabindex="0"]')].filter(
          (e) => (e.innerText ?? '').trim().length > 40 && !e.querySelector('textarea') && e.getBoundingClientRect().height > 20
        );
        const el = rows.pop();
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(r.width / 2, 120), y: r.y + Math.min(r.height / 2, 20) };
      })()`);
      if (!box) throw new Error('No reply to hold');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...box,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await sleep(700);
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...box,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(600);
      await page.clickText('Listen');
      await sleep(600);
    },
    check:
      'Reading aloud: a bar over the composer with the speaker icon, “Reading aloud”, a line saying how to pause (or, on Android, media volume), and an ✕ to stop',
    after: async (page) => {
      await page.clickLabel('Stop reading').catch(() => {});
      await sleep(400);
    },
  },
  // The composer's shapes, as Claude's own input: one capsule empty, a card with words.
  {
    name: 'composer-empty',
    route: '/chat/design',
    ready: 'Designer',
    check:
      'One glass capsule: the round + inside it at the left, the placeholder, the mic, Send dimmed',
  },
  {
    name: 'composer-typed',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.type(
        'Can you pull last week’s numbers together for the Monday review, and flag anything that moved more than ten percent? A short note per line is plenty.'
      );
      await sleep(700);
    },
    check:
      'A card: the words across its whole width on top; under them + and the engine chip at the left, the mic and Send (accent) at the right',
    after: clearField,
  },
  {
    name: 'composer-attachments',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.type('Here are the two receipts');
      // The draft reaches the disk, then gets two files the Mac already holds, and comes back.
      await sleep(1200);
      await page.eval(`(() => {
        const key = Object.keys(localStorage).find((k) => k.includes('drafts-'));
        if (!key) return false;
        const all = JSON.parse(localStorage.getItem(key));
        const swatch = (c) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="' + c + '"/><rect x="20" y="24" width="80" height="10" fill="white"/><rect x="20" y="44" width="56" height="10" fill="white"/></svg>');
        all.design.files = [
          { blobId: 'qa-b1', uri: swatch('#7a8ca3'), name: 'receipt.png', mime: 'image/png', size: 2048, stagedAt: Date.now() },
          { blobId: 'qa-b2', uri: 'file:///qa/invoice.pdf', name: 'invoice-0412.pdf', mime: 'application/pdf', size: 4096, stagedAt: Date.now() },
        ];
        localStorage.setItem(key, JSON.stringify(all));
        // Leaving the page writes the draft as the app holds it (no files): not this time.
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (k === key) return;
          return set.call(this, k, v);
        };
        return true;
      })()`);
      await page.goto(`${WEB}/chat/design`);
      await page.waitFor(`document.body.innerText.includes('Designer')`, 20_000, 'Designer');
      await sleep(1800);
    },
    check:
      'The card with the two files at its top, each with a small ×, the words under them, the row under those',
    after: async (page) => {
      // One at a time: a tile leaving animates, and the next is found once it's gone.
      await page.clickLabel('Remove receipt.png').catch(() => {});
      await sleep(500);
      await page.clickLabel('Remove invoice-0412.pdf').catch(() => {});
      await sleep(500);
      await clearField(page);
    },
  },
  {
    name: 'composer-queued',
    route: '/chat/ops',
    ready: 'Ops',
    act: async (page) => {
      // Ops is mid-turn in the mock (queued behind the cap): what's typed waits for it.
      await page.type('and then the weekly summary');
      await sleep(500);
    },
    check:
      'Working, with words: “Ops reads it when it’s done with this one” full width over the field from its left edge, Send now at its right; in the field the mic, Stop and Send',
    after: clearField,
  },
  {
    name: 'dictation-working',
    route: '/chat/ops',
    ready: 'Ops',
    act: async (page) => {
      // Ops is mid-turn: the mic is still there, and what's said queues as typing does.
      await page.clickLabel('Dictate');
      await sleep(2300);
    },
    check:
      'Dictating while the agent works: the card with the words streaming, ×, the waveform, Stop and Send; the queued line over it',
    after: async (page) => {
      await page.clickLabel('Cancel dictation').catch(() => {});
      await sleep(600);
    },
  },
  {
    name: 'bar-revising',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: async (page) => {
      await scrollToText('Ask for changes')(page);
      await page.clickText('Ask for changes');
      await sleep(1200);
    },
    check: '"Changes to …" bar above the composer',
    after: async (page) => {
      await page.clickLabel("Don't ask for changes");
      await sleep(800);
    },
  },
  {
    name: 'conversations-sheet',
    route: '/conversations?id=site',
    ready: 'Update the winter opening hours',
    check:
      'Conversations sheet: one line on shared memory, New conversation with a plus, a search field, then Rebuild the Acme site (a check) and Update the winter opening hours (“1d ago”), then Rename this conversation',
  },
  {
    name: 'chat-conversation',
    route: '/chat/site',
    ready: 'Acme Site',
    act: async (page) => {
      await page.goto(`${WEB}/conversations?id=site`);
      await page.waitFor(
        `document.body.innerText.includes('Update the winter opening hours')`,
        20_000,
        'the list'
      );
      await page.clickText('Update the winter opening hours');
      await sleep(1800);
    },
    check:
      'Acme Site’s chat on its second conversation: a slim bar under the header saying “Update the winter opening hours” with a chevron; only the two opening-hours lines in the chat',
    after: async (page) => {
      await page.goto(`${WEB}/conversations?id=site`);
      await page.waitFor(
        `document.body.innerText.includes('Rebuild the Acme site')`,
        20_000,
        'the list'
      );
      await page.clickText('Rebuild the Acme site');
      await sleep(800);
    },
  },
  {
    name: 'diff',
    route: '/chat/site',
    ready: 'Acme Site',
    act: async (page) => {
      await page.clickLabel('Review changes');
      await sleep(2000);
    },
    check: 'Diff screen: row tints span the full box width',
  },
  {
    name: 'agent-sheet-site',
    route: '/agent/site',
    ready: 'Acme Site',
    pages: 3,
    check: 'Allowed without asking: Revoke aligned with the other row values',
  },
  {
    name: 'agent-sheet-routine-conversation',
    route: '/agent/site',
    ready: 'Check the opening hours',
    pages: 4,
    act: async (page) => {
      await page.waitFor(
        `document.body.innerText.includes('In “Update the winter opening hours”')`,
        20_000,
        'the routine’s conversation'
      );
    },
    check:
      'Routines: “Check the opening hours are right before the weekend”, “Every Friday at 10:00 AM”, then a quieter one-line “In “Update the winter opening hours”” (the conversation it runs in)',
  },
  {
    name: 'search-hit-other-conversation',
    route: '/search',
    ready: 'Search',
    act: async (page) => {
      // On the first conversation, a hit from the opening-hours one.
      await page.goto(`${WEB}/conversations?id=site`);
      await page.waitFor(
        `document.body.innerText.includes('Rebuild the Acme site')`,
        20_000,
        'the list'
      );
      await page.clickText('Rebuild the Acme site');
      await sleep(800);
      // No native search bar on the web: `?q=` starts with the query.
      await page.goto(`${WEB}/search?q=Mondays`);
      await page.waitFor(
        `document.body.innerText.includes('Visit page')`,
        20_000,
        'the opening-hours hit'
      );
      await page.clickWhere(
        `() => [...document.querySelectorAll('[role="button"]')].find((e) => e.innerText?.includes('Visit page'))`,
        'the opening-hours hit'
      );
      await sleep(2000);
    },
    check:
      'Acme Site’s chat, switched to its opening-hours conversation: the slim bar under the header says “Update the winter opening hours”, and “Done on the Visit page and the footer…” is lit up; nothing from the rebuild conversation',
    after: async (page) => {
      await page.goto(`${WEB}/conversations?id=site`);
      await page.waitFor(
        `document.body.innerText.includes('Rebuild the Acme site')`,
        20_000,
        'the list'
      );
      await page.clickText('Rebuild the Acme site');
      await sleep(800);
    },
  },
  {
    name: 'agent-sheet-look',
    route: '/agent/site',
    ready: 'Acme Site',
    act: async (page) => {
      await page.clickLabel('Change how it looks');
      await sleep(500);
    },
    check:
      'The key tapped: a row of eight small keys, one per colourway, a row of the icons on keys in its colourway, and a row of free keyboard keys (its own ringed); the current choice in each ringed in a neutral grey. The big key at the top shows its sublegend and pips',
  },
  {
    name: 'agent-sheet-icons',
    route: '/agent/site',
    ready: 'Acme Site',
    act: async (page) => {
      await page.clickLabel('Change how it looks');
      await sleep(500);
      await page.clickLabel('Search 2,029 more icons');
      await page.waitFor(
        `document.body.innerText.includes('2,052 icons')`,
        20_000,
        'the icon pack'
      );
      await page.type('money', 'input[aria-label="Search icons"]');
      await sleep(800);
    },
    check:
      'The icon sheet over the agent: Icon and Done, the agent’s key at 112pt, the search reading “money”, category chips (All, Featured, Accessibility…), “N for “money””, then a grid of small keys in the agent’s colourway: the Money legend first, then Lucide’s banknote, coins, currency, wallet, dollar sign…',
  },
  {
    name: 'agent-sheet-level',
    route: '/agent/fin',
    ready: 'Finance',
    act: async (page) => {
      await page.clickText('How much it does on its own');
      await sleep(600);
    },
    check:
      'Finance’s sheet with its own level: the choice sheet titled “How much it does on its own”, “Same as team (Steady)” first, then Careful, Steady, Bold, Unleashed, and Cancel',
  },
  {
    name: 'agent-sheet-level-row',
    route: '/agent/fin',
    ready: 'Finance',
    act: scrollToText('How much it does on its own'),
    check:
      'The row “How much it does on its own”, value “Careful”, with its one line under it, above the Admin switch',
  },
  {
    name: 'agent-sheet-chief',
    route: '/agent/chief',
    ready: 'Chief of Staff',
    pages: 3,
    check: 'Chief sheet',
  },
  {
    name: 'login-choose',
    route: '/chat/fin',
    ready: 'Finance',
    // Gmail has no connector of its own (Google approves which apps may use
    // it), so the card leads with Use my browser, not "Connect Gmail".
    act: scrollToText('Use my browser'),
    check:
      'Login card: "Finance needs your Gmail", asked-as line, what it can do, ONE short line ("Uses your Chrome on your Mac…"), Not now + Use my browser (neutral filled), then "Other ways" as a text action; nothing else, no password field',
  },
  {
    name: 'login-other-ways',
    route: '/chat/fin',
    ready: 'Finance',
    act: async (page) => {
      await scrollToText('Other ways')(page);
      await page.clickText('Other ways');
      await sleep(600);
      await scrollToText('Not needed')(page);
    },
    check:
      'Gmail card, Other ways open: why there is no connector, Connect in Claude instead and Sign in from here each with what it means, then Not needed; "Hide other ways" closes it',
  },
  {
    name: 'login-on-mac',
    route: '/chat/qa',
    ready: 'QA 2',
    check:
      'Gmail card: "Finish signing in on your Mac — it’s open there." with the Mac’s live line and Cancel; LinkedIn card below leads with Use my browser and says LinkedIn has no connector',
  },
  {
    name: 'login-connected',
    route: '/chat/qa',
    ready: 'QA 2',
    act: scrollToText('Started fresh · memory kept'),
    check: 'Answered login card as a receipt line: Connected · QA 2 needs your Google Calendar',
  },
  {
    name: 'team-logins',
    route: '/logins',
    ready: 'What your team needs',
    pages: 2,
    check:
      'One row per service: Google · Gmail + Calendar used by Finance and QA 2 (one signing in on the Mac), LinkedIn browser-only; progress line; Not needed per agent',
  },
  {
    name: 'apps',
    route: '/apps',
    ready: 'Apps your agents can use',
    pages: 2,
    check:
      'Apps your agents can use: Connected (Linear · sam@acme.com, Signed in on this Mac · who can read and change; Gmail on claude.ai; Sentry with Needs sign-in and Sign in again), each with Who can use it and Remove as quiet words; Connect an app rows with one neutral Connect each, Notion saying Finish signing in on your Mac with Stop; Through claude.ai with Open claude.ai',
  },
  {
    name: 'apps-who',
    route: '/apps',
    ready: 'Apps your agents can use',
    act: (page) => clickIn(page, 'connection-c_linear', 'Who can use it'),
    check:
      'Linear’s row open on Which agents can use it?: every agent with a tick box (Chief of Staff and QA 2 ticked), Read only / Read and change with Read and change on, “Every change asks you on a card first.”, Cancel and Save (neutral)',
  },
  {
    name: 'apps-connect',
    route: '/apps?agentId=qa',
    ready: 'Apps your agents can use',
    act: async (page) => {
      await scrollToText('Stripe')(page);
      await clickIn(page, 'app-stripe', 'Connect');
      await scrollToText('Sign in to Stripe')(page);
    },
    check:
      'Stripe’s row open with only QA 2 ticked (opened for it), Read only on, where the sign-in opens, Cancel and Sign in to Stripe (neutral)',
  },
  {
    name: 'apps-remove',
    route: '/apps',
    ready: 'Apps your agents can use',
    act: async (page) => {
      await clickIn(page, 'connection-c_linear', 'Remove');
      await sleep(800);
    },
    check:
      'A sheet over the list: “Remove Linear?”, that no agent can use it and its sign-in leaves the Mac’s Keychain, Remove in red and Cancel',
  },
  {
    name: 'controls-apps',
    route: '/controls?id=qa',
    ready: 'QA 2',
    act: scrollToText('Apps'),
    check:
      'Agent controls: an Apps row (“Which apps QA 2 can use, and connecting new ones.”) above More about QA 2',
  },
  {
    name: 'on-its-own',
    route: '/on-its-own?id=fin',
    ready: 'What can Finance do on its own?',
    pages: 3,
    check:
      'What can Finance do on its own?: a quiet box “Unleashed · its own level” and its line; ALWAYS ASKS (money, passwords, deleting; exact words); WITHOUT ASKING, BEYOND ITS LEVEL in sections: Rules (Run npm test, Run pnpm build with the quote, Run ls for every agent) each with Remove; Plans you OK’d with Take back; Apps (Gmail with Remove and Read only); Browser with Turn off; Team and accounts (admin Turn off, Slack Ask first, the Work account with no button). Quiet text buttons, never the accent; the foot line',
  },
  {
    name: 'on-its-own-narrowed',
    route: '/on-its-own?id=site',
    ready: 'What can Acme Site do on its own?',
    act: async (page) => {
      // The mock keeps what was taken away, so the second theme finds it gone already.
      await page.clickLabel('Read only').catch(() => {});
      await sleep(800);
    },
    check:
      'After Read only on Gmail: the Gmail row is gone (the Mac answered with the narrowed view); everything else as before',
  },
  {
    name: 'on-its-own-team',
    route: '/on-its-own',
    ready: 'What your agents do on their own',
    pages: 2,
    check:
      'The team: Bold in a quiet box with its line and the always-asks line; RULES FOR EVERY AGENT (Run ls, Remove); AGENTS, one row each with its level and how much stands beyond it, each opening its own list',
  },
  {
    name: 'agent-sheet-on-its-own-row',
    route: '/agent/fin',
    ready: 'Finance',
    check:
      'Finance’s sheet: “What it does on its own” with a shield, among Instructions, Memory and Files',
  },
  {
    name: 'settings-apps',
    route: '/settings',
    ready: 'Settings',
    act: scrollToText('Apps your agents can use'),
    check:
      'Settings → Logins: What your team needs, then Apps your agents can use, and the footer naming both',
  },
  {
    name: 'reach',
    route: '/agent/qa',
    ready: 'QA 2',
    act: scrollToText('WHAT IT CAN REACH'),
    check:
      'What it can reach: Google Calendar connection, your browser, read-only with "Change this on your Mac."',
  },
  {
    name: 'policy',
    route: '/agent/qa',
    ready: 'QA 2',
    act: scrollToText('WHAT IT CAN DO'),
    check:
      'What it can do: one row per setting with “Team default” or “Its own” (and “instructions” for independence and rules), the enforcement note, and “Change in chat”; never “go to Settings”.',
  },
  {
    name: 'settings-card',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: scrollToText("Change Hiring's settings?"),
    check:
      'A “Change Hiring’s settings?” card with a sliders icon: “Hiring” over bulleted plain lines, a muted Why and the rules note; Deny outlined, Allow the neutral answer.',
  },
  {
    name: 'plan-card',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: scrollToText('Do these under your name?'),
    check:
      'One “Do these under your name?” card: three numbered actions, each with where it happens muted under it, and a muted Why; no Details, no raw command; Deny outlined, Allow the neutral answer.',
  },
  { name: 'memory', route: '/memory?id=site', ready: 'Memory', check: 'Placeholder not clipped' },
  { name: 'instructions', route: '/instructions?id=site', check: 'Instructions editor' },
  { name: 'files', route: '/files/site', check: 'Files list' },
  {
    name: 'schedule',
    route: '/schedule?agentId=site',
    check: 'Routine picker; the summary has no literal ellipsis',
  },
  {
    name: 'schedule-monthly',
    route: '/schedule?agentId=site',
    ready: 'Monthly',
    act: async (page) => {
      await page.clickText('Monthly');
      await sleep(600);
    },
    check:
      'Monthly picked: one more chip in How often, then Every month / Every 3 months and one “On the [1st] [day]” row like the time row; the echo says “Every month on the 1st at 9:00 AM”, and the Mac confirms the first run',
  },
  {
    name: 'schedule-when',
    route: '/schedule?agentId=site&mode=when',
    ready: 'WHEN THIS HAPPENS',
    check:
      'New routine, “At a time / When…” with When… on, then the desk’s “When…” composer: WHEN THIS HAPPENS over five sources (Linear among them, the Mac has a Linear app), each with how it’s checked (“Free · checked from your Mac”), the first ticked; CHECK EVERY 5/10/30 min/1 hour with 10 min on; WHAT; the echo box says “Which…”-free words: “When someone mentions you on GitHub” and “Checks are free. The first check only notes what’s already there…”; Cancel and a neutral Add (not the agent’s colour), off until What is filled',
  },
  {
    name: 'schedule-when-folder',
    route: '/schedule?agentId=site&mode=when',
    ready: 'WHEN THIS HAPPENS',
    act: async (page) => {
      await page.clickText('A new file appears in a folder');
      await sleep(400);
      await page.clickText('~/Downloads');
      await sleep(300);
      await page.type('File the invoice and tell me the total');
      await sleep(400);
    },
    check:
      'A new file appears in a folder ticked: chips of the Mac’s folders (~/Downloads on, ~/Desktop, ~/Documents) and “Folders your Mac offers. For another, set it up on your Mac.”; no path field; CHECK EVERY 1/5/10/30 min; the echo “When a new file appears in /Users/sam/Downloads — File the invoice and tell me the total” and “Checks are free…”; Add enabled',
  },
  {
    name: 'schedule-when-custom',
    route: '/schedule?agentId=site&mode=when',
    ready: 'WHEN THIS HAPPENS',
    act: async (page) => {
      await page.clickText('Something else…');
      await sleep(400);
      await page.type('a new email from Dana about the launch');
      await sleep(300);
      await page.clickText('Gmail');
      await sleep(400);
    },
    check:
      'Something else… ticked: the “What to look for” field filled, THROUGH with Gmail and Linear chips (Gmail on), CHECK EVERY 15/30 min/1 hour/4 hours with 30 min on; the echo “When Acme Site finds “a new email from Dana about the launch”” and “Each check uses a little of Acme Site’s usage and can only read that app, up to 24 a day. The first check…”',
  },
  {
    name: 'agent-sheet-when',
    route: '/agent/site',
    ready: 'Acme Site',
    act: scrollToText('When something happens'),
    check:
      'WHEN SOMETHING HAPPENS: one row with a bolt, “When someone mentions you on GitHub”, “Triage it and tell me if it’s urgent”, “Checks every 10 min · checked 4 min ago · last found 2 …” and an ellipsis (it can be acted on); no “Set up and changed on your Mac.” line',
  },
  {
    name: 'new-agent',
    route: '/new-agent',
    ready: 'Draft it',
    check:
      'New agent opens describe-first, as on the desk: “Describe the agent you want”, one big box, Draft it alone (neutral, off until there is a sentence), its one-line hint, then “Or fill it in yourself, start from …, or ask your Chief of Staff.” as quiet links. No name, colours or shapes yet.',
  },
  {
    name: 'new-agent-form',
    route: '/new-agent',
    ready: 'fill it in yourself',
    act: async (page) => {
      await page.clickText('fill it in yourself');
      await sleep(500);
    },
    check:
      'After “fill it in yourself”: the form (What should it do?, name, colour), “Or describe it instead” back to the box, Create, and “Ask your Chief of Staff to set it up”.',
  },
  {
    name: 'new-agent-drafted',
    route: '/new-agent',
    ready: 'Draft it',
    act: async (page) => {
      await page.type(
        'Every Friday at 4, write my weekly report from my notes and post it to #team once I OK it.'
      );
      await sleep(300);
      await page.clickText('Draft it');
      await sleep(1200);
    },
    check:
      'After Draft it: the drafted role in the field, “Drafted from what you wrote” with Start over, the name and colour filled; then “What it knows” (the briefing, editable), Routines as one group with a switch per routine (steps numbered, “After your OK: Post the brief…”), and one muted line on the apps it will ask for. Create says the name.',
  },
  {
    name: 'schedule-steps',
    route: '/schedule?agentId=chief&id=ci_weekly',
    ready: 'Your OK first',
    check:
      'Editing a routine in steps: What, then step 2 as a row (a muted 2, its words, ✕) with “Your OK first” and its switch on; “Add a step”; the echo says “2 steps · your OK before step 2”.',
  },
  {
    name: 'gate-card',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: scrollToText('OK to go on?'),
    check:
      'One “OK to go on?” card with the routine glyph, “Draft the weekly report… · step 1 of 2 done” under the title, “Next, step 2 of 2” over “Post it to #team on Slack”, a quiet well “What step 1 made” with the report; Stop here outlined and Go ahead the neutral answer; no ⋯.',
  },
  {
    name: 'import',
    route: '/import',
    ready: 'Import agents',
    check:
      'Import: the three steps, Remote access ticked, the import going on with past conversations counted',
  },
  {
    name: 'session',
    route: '/session/pty-site-1',
    settle: 3500,
    // The terminal opens by itself while the task has said nothing yet
    // (taskScreen's `terminalFirst`): close it to see the conversation alone.
    act: async (page) => {
      await page.clickText('Hide terminal').catch(() => {});
      await sleep(800);
    },
    check:
      'A task as a conversation: its state in words, what it was asked, its steps, what it said; no terminal chrome or "esc to interrupt"',
  },
  {
    name: 'session-terminal',
    route: '/session/pty-site-1',
    settle: 3500,
    act: async (page) => {
      // Already open when the rule above opened it; else open it.
      await page.clickText('Show terminal').catch(() => {});
      await sleep(800);
    },
    check: 'Show terminal: the raw screen in a sideways-scrolling well with a right-edge fade',
  },
  {
    name: 'room-list',
    route: '/agents',
    ready: 'Chief of Staff',
    act: scrollToText('Launch'),
    check: 'Rooms: two whole badges (no cut initials) and +N; "Needs your OK" said once, no dot',
  },
  {
    name: 'room-launch',
    route: '/room/launch',
    ready: 'Launch',
    pages: 3,
    check:
      'Header pair of badges; Acme Site’s copy card offers Discard / Keep changes; Designer’s result card offers Ask for changes; @mentions tinted; "To everyone"; the intro says agents remember their own chat',
  },
  {
    name: 'room-monthend',
    route: '/room/monthend',
    ready: 'Month end',
    pages: 2,
    check: 'No lead: the foot line says "Who should answer? @ someone"; names joined with "and"',
  },
  {
    name: 'room-ask',
    route: '/room/launch',
    ready: 'Launch',
    act: async (page) => {
      await scrollToText('Ask for changes')(page);
      await page.clickText('Ask for changes');
      await sleep(1500);
    },
    check:
      'Ask for changes in a room opens Designer’s own chat with "Changes to Launch hero" staged',
    after: async (page) => {
      await page.clickLabel("Don't ask for changes");
      await sleep(800);
    },
  },
  {
    name: 'settings',
    route: '/settings',
    pages: 2,
    check: 'Dates in the one short format ("Nov 5, 2026")',
  },
  {
    name: 'settings-independence',
    route: '/settings',
    ready: 'Just does it',
    act: scrollToText('Just does it'),
    check:
      'HOW MUCH IT DOES ON ITS OWN over one card: “Asks a lot” and “Just does it” at the ends, a track with four dots and a neutral thumb (never the accent), Careful · Steady · Bold · Unleashed under it with the chosen one stronger, the chosen stop’s line, then “Always asks before spending money, using your passwords, or deleting for good.” and the count set on their own',
  },
  {
    name: 'settings-quiet-hours',
    route: '/settings',
    ready: '22:00–07:00',
    act: scrollToText('22:00–07:00'),
    check:
      'QUIET HOURS over one row: “Quiet hours” with “22:00–07:00” on the right and a chevron, then the footer “Nothing scheduled runs; only requests for your OK notify.”',
  },
  {
    name: 'settings-voice',
    route: '/settings',
    ready: 'Attach the recording',
    act: scrollToText('Attach the recording'),
    check:
      'VOICE over one row: “Attach the recording” with its switch off, then the footer on holding the mic to send, where words are recognised, and what the switch does with the recording',
  },
  {
    name: 'settings-text-size',
    route: '/settings',
    ready: 'Largest',
    act: scrollToText('Largest'),
    check:
      'Text size: Smaller / Default / Larger / Largest, each "Aa" drawn at its own size, Default ticked',
  },
  ...['smaller', 'larger', 'largest'].map((size) => ({
    name: `text-${size}-chat`,
    route: '/settings',
    ready: 'Largest',
    act: async (page) => {
      await scrollToText('Largest')(page);
      await page.clickText(size[0].toUpperCase() + size.slice(1));
      await sleep(400);
      await page.goto(`${WEB}/chat/design`);
      await page.waitFor(`document.body.innerText.includes('Designer')`, 20_000, 'Designer');
      await sleep(1800);
    },
    after: async (page) => {
      await page.goto(`${WEB}/settings`);
      await page.waitFor(`document.body.innerText.includes('Largest')`, 20_000, 'Largest');
      await scrollToText('Largest')(page);
      await page.clickText('Default');
      await sleep(400);
    },
    check: `The Designer's chat at ${size}: replies reflow, nothing clipped, the fade above the composer`,
  })),
  {
    name: 'settings-accounts',
    route: '/settings',
    ready: 'Personal',
    act: scrollToText('CLAUDE CODE ACCOUNTS'),
    check:
      'CLAUDE CODE ACCOUNTS: sam@example.com with a neutral tick (Max plan · this Mac’s own sign-in; In use · 5-hour …% left), Work (me@work.example · Max plan; Ready · 5-hour 20% left; “QA 2 runs only on this one”) and Personal, each Ready with Use now and up/down arrows (none past the ends); then Codex accounts; the footer saying agents carry on with the next and that accounts are added on the Mac',
  },
  {
    name: 'settings-accounts-swapped',
    route: '/settings',
    ready: 'Personal',
    act: async (page) => {
      await scrollToText('CLAUDE CODE ACCOUNTS')(page);
      await page.clickLabel('Use Work now');
      await sleep(900);
    },
    after: async (page) => {
      await page.clickLabel('Use sam@example.com now');
      await sleep(600);
    },
    check:
      'After Use now on Work: Work first with the tick and In use, sam@example.com second and Ready with Use now',
  },
  {
    name: 'controls-runs-on',
    route: '/controls?id=qa',
    ready: 'Any account',
    act: scrollToText('RUNS ON'),
    check:
      'Agent controls: RUNS ON with Any account (“In order, carrying on with the next when one runs out”), sam@example.com, Work ticked (“Only this one, never another”) and Personal',
  },
  {
    name: 'settings-usage',
    route: '/settings',
    ready: 'Use it all before the refill',
    act: scrollToText('Ideas for leftover usage'),
    check:
      'Usage: "Use it all before the refill" with its line; "Claude 5-hour limit refills … · 62% left"; "Claude Code: average turn" says it is an estimate; the list "0 waiting" (its one item started); Ollama running with its model, Opencode installed. Read-only.',
  },
  {
    name: 'connection',
    route: '/connection',
    pages: 2,
    check: 'Every layer of the link; dates in the short format',
  },
];

/** The Mac out of reach, with the chats above saved. */
const OFFLINE_CACHED = [
  {
    name: 'offline-cached-agents',
    route: '/agents',
    settle: 5000,
    check: 'Saved list, "as of …"; rows still say what needs the OK',
  },
  { name: 'offline-cached-projects', route: '/projects', settle: 3000, check: 'Saved projects' },
  {
    name: 'offline-cached-chat-chief',
    route: '/chat/chief',
    settle: 5000,
    check: 'Every card keeps its actions, disabled, with one consistent note',
  },
  {
    name: 'offline-cached-chat-design',
    route: '/chat/design',
    settle: 5000,
    check: 'Approvals disabled with the note; the composer keeps "+" disabled',
  },
  {
    name: 'offline-cached-chat-fixtures',
    route: '/chat/fixtures',
    settle: 5000,
    pages: 4,
    check: 'Result/copy cards keep Discard / Keep changes visibly disabled',
  },
  {
    name: 'offline-connection',
    route: '/connection',
    settle: 3000,
    check:
      'Check these first: three rows (Mac awake and app open, Tailscale on, paired: Yes), each with its fix; Details folded; no host in the first lines',
  },
];

/**
 * The Mac goes away under an open app (`--phases reconnecting`): the first
 * seconds read as calm. `goodbye` stops the mock as the Mac's app quits
 * (1001 "going away"); otherwise it is killed without a word.
 */
const RECONNECTING = [
  {
    name: 'reconnecting-agents',
    route: '/agents',
    goodbye: false,
    check: 'A few seconds after a drop: "Reconnecting…", never "Can’t reach Mac"',
  },
  {
    name: 'reconnecting-chat-chief',
    route: '/chat/chief',
    goodbye: false,
    check: 'The chat bar says "Reconnecting…" quietly, saved messages shown',
  },
  {
    name: 'reconnecting-goodbye-chat-chief',
    route: '/chat/chief',
    goodbye: true,
    check: 'The Mac’s app said it was closing: "Waiting for the app on your Mac"',
  },
];

async function reconnectingShots(page) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const s of RECONNECTING) {
      if (!wanted(`${s.name}-${theme}`)) continue;
      await startMock();
      await page.goto(WEB + s.route);
      await sleep(5000);
      await (s.goodbye ? stopMock() : killMock());
      // Past the chat bar's 2 s grace, well inside the 15 s calm.
      await sleep(3500);
      await screen(page, theme, { name: s.name, check: s.check });
    }
  }
}

/**
 * The Mac going away under an open tab, in order, as the connection bar says
 * it: reconnecting (calm), can't reach it (past 15 s), "What to check" open,
 * back (one quiet line), then nothing. Then the app on the Mac stuck (the
 * socket taken, nothing said: `--hung`), and the app saying goodbye as it
 * closes. Not in the default run.
 */
async function linkDownShots(page) {
  const has = (testId) => `!!document.querySelector('[data-testid="${testId}"]')`;
  // In-app navigation keeps the transport (a reload would start it over).
  const open = (route) =>
    page.eval(
      `history.pushState(null, '', ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent('popstate'))`
    );
  // The web build's tab bar is a pill over the top of the screen, right where
  // the connection bar sits: hidden for these shots so the bar can be read.
  const hideTabs = () =>
    page.eval(`(() => {
      for (const e of document.querySelectorAll('body *')) {
        const r = e.getBoundingClientRect();
        const t = e.innerText || '';
        if (r.top < 120 && r.height > 30 && r.height < 90 && t.includes('Catch up') && t.includes('Projects'))
          e.style.visibility = 'hidden';
      }
    })()`);
  const shot = async (name, theme, route, check) => {
    if (!wanted(`${name}-${theme}`)) return;
    await hideTabs();
    await capture(page, `${name}-${theme}`, { route, check, theme });
  };
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const [tab, route] of [
      ['agents', '/agents'],
      ['catch-up', '/catch-up'],
    ]) {
      await startMock();
      await page.goto(WEB + route);
      await sleep(5000);
      await killMock();
      await sleep(3500);
      await shot(
        `link-reconnecting-${tab}`,
        theme,
        `${route} (Mac gone 3 s)`,
        'One bar on the content margin: “Reconnecting to your Mac…”, “Last heard from it just now · showing what was saved”, Try again, What to check; the list readable under it; no toast, no “as of” anywhere else'
      );
      // Opened again with the Mac still away (a cold start): past the calm 15 s
      // it says plainly that it can't reach it.
      await page.goto(WEB + route);
      await sleep(17000);
      await shot(
        `link-down-${tab}`,
        theme,
        `${route} (opened with the Mac away, 17 s)`,
        'The same bar, now “Can’t reach your Mac” with its red dot and when it last heard; nothing else says it'
      );
      if (tab === 'agents') {
        await page.clickText('What to check').catch((e) => page.errors.push(e.message));
        await sleep(600);
        await shot(
          `link-down-checks-${tab}`,
          theme,
          `${route} (What to check)`,
          'Three causes, each with its fix (asleep or shut; Tailscale off or another account; the app stuck), then Connection details'
        );
      }
      await startMock();
      await page
        .waitFor(has('connection-back'), 20_000, 'back in touch')
        .catch((e) => page.errors.push(e.message));
      await sleep(300);
      await shot(
        `link-back-${tab}`,
        theme,
        `${route} (Mac back)`,
        'One quiet line, “Back in touch with your Mac”, where the bar was'
      );
      await sleep(3500);
      await shot(`link-back-gone-${tab}`, theme, `${route} (a moment later)`, 'Nothing: the list as usual');
    }

    // The app on the Mac stuck: the socket is taken and nothing is said.
    await startMock();
    await page.goto(`${WEB}/agents`);
    await sleep(5000);
    await killMock();
    await startMock('--hung');
    await sleep(30000);
    await shot(
      'link-stuck-agents',
      theme,
      '/agents (the Mac’s app hung)',
      '“The app on your Mac isn’t responding”, “Your Mac is reachable · last heard…”; What to check says to quit and reopen it, never blames the user'
    );
    await open('/catch-up');
    await sleep(1500);
    await shot('link-stuck-catch-up', theme, '/catch-up (the Mac’s app hung)', 'The same bar, same words, on Catch up');
    await page.clickText('What to check').catch((e) => page.errors.push(e.message));
    await sleep(600);
    await shot('link-stuck-checks-catch-up', theme, '/catch-up (What to check)', 'Quit it and open it again; it may catch up by itself');
    await open('/chat/chief');
    await sleep(2000);
    await shot('link-stuck-chat', theme, '/chat/chief (the Mac’s app hung)', 'The chat’s bar over the composer says the same words');

    // The app said goodbye as it closed (a quit, an update's restart).
    await startMock();
    await page.goto(`${WEB}/agents`);
    await sleep(5000);
    await stopMock();
    await sleep(3500);
    await shot(
      'link-closing-agents',
      theme,
      '/agents (the Mac’s app closing)',
      '“Waiting for the app on your Mac”: it said it was closing, for an update or a restart'
    );
  }
}

/**
 * Straight after pairing, before any chat was opened: nothing saved for it.
 * Settled past the first 15 s, which read as "Connecting…" (`CALM_MS`).
 */
const OFFLINE_FRESH = [
  {
    name: 'offline-agents',
    route: '/agents',
    settle: 17000,
    check: 'The list as last seen at pairing, or the empty reason',
  },
  {
    name: 'offline-chat-design',
    route: '/chat/design',
    settle: 17000,
    check: 'Deep-linked chat, nothing cached: header + reason + retry, never a bare spinner',
  },
];

/** Something else answers at the Mac's address with another key. */
const NOT_YOUR_MAC = [
  {
    name: 'state-not-your-mac-agents',
    route: '/agents',
    settle: 6000,
    check: 'Banner says it once; the empty state follows the reason, not "Removed from Mac"',
  },
  {
    name: 'state-not-your-mac-chat',
    route: '/chat/qa',
    settle: 6000,
    check: 'Deep-linked chat while refused: header + reason, never a bare spinner',
  },
  {
    name: 'state-not-your-mac-connection',
    route: '/connection',
    settle: 3000,
    check: 'Connection says why',
  },
];

/** `--bars`: import + driven + engine in the Chief's chat. */
const BARS = [
  {
    name: 'bars-fold',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    settle: 3000,
    check: 'Two bars, then "1 more"',
  },
  {
    name: 'bars-open',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    settle: 3000,
    act: async (page) => {
      await page.clickText('1 more');
      await sleep(800);
    },
    check: 'All three bars in the fixed order: driven, import, engine',
  },
];

/**
 * A close-up sequence of the typing dots: `count` frames `gapMs` apart, plus
 * each dot's opacity read at every frame into the report, so "all three
 * move, evenly" is a number and not only a picture.
 */
const dotFrames =
  (name, count = 8, gapMs = 150) =>
  async (page, theme) => {
    const sel = '[data-testid="typing-dots"]';
    const box = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24, scale: 4 };
  })()`);
    if (!box) throw new Error('no typing dots on screen');
    const readings = [];
    for (let f = 0; f < count; f++) {
      const file = `${name}-${theme}-f${String(f).padStart(2, '0')}`;
      await page.screenshot(path.join(OUT, `${file}.png`), box);
      readings.push(
        await page.eval(
          `[...document.querySelectorAll(${JSON.stringify(`${sel} > *`)})].map((e) => Number(getComputedStyle(e).opacity).toFixed(2)).join(' ')`
        )
      );
      await sleep(gapMs);
    }
    shots.push({
      name: `${name}-${theme}-frames`,
      route: '(in place)',
      theme,
      check: `Typing dots, ${count} frames ${gapMs} ms apart (f00…f${count - 1}); each dot's opacity per frame: ${readings
        .map((r) => `[${r}]`)
        .join(' ')}. All three must change, one after another.`,
      errors: [],
      clipped: [],
    });
    log('frames', name, theme);
  };

/**
 * A close-up of the working line's key: the agent's own key, pressed (down
 * and on a shallow depth) while it works, and how far its cap sits below
 * its box's top, so "it's pressed" is a number as well as a picture.
 */
const keyFrames = (name) => async (page, theme) => {
  const box = await page.eval(`(() => {
    const el = document.querySelector('[data-testid="agent-key-cap-working"]')?.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16, scale: 4 };
  })()`);
  if (!box) throw new Error('no working key on screen');
  const file = `${name}-${theme}-key`;
  await page.screenshot(path.join(OUT, `${file}.png`), box);
  const down = await page.eval(`(() => {
    const cap = document.querySelector('[data-testid="agent-key-cap-working"]');
    return (cap.getBoundingClientRect().y - cap.parentElement.getBoundingClientRect().y).toFixed(1);
  })()`);
  shots.push({
    name: file,
    route: '(in place)',
    theme,
    check: `The agent's key on the working line, pressed: its cap sits ${down}px down in its box (the small key's press, 2 of 30), on a thin depth, in its own colourway and legend. Nothing moves.`,
    errors: [],
    clipped: [],
  });
  log('frames', `${name} key`, theme);
};

/** `--live-work`: what agents are doing, live (QA 2 on Cypress, Finance gone quiet). */
const LIVE_WORK = [
  {
    name: 'live-agents',
    route: '/agents',
    ready: 'QA 2',
    settle: 2500,
    check:
      'QA 2: its key pressed (working), “Running the Cypress tests · 5m”; Finance: pressed, “No progress for 5 min”; no spinner beside either',
  },
  {
    name: 'live-step',
    route: '/chat/qa',
    ready: 'QA 2',
    settle: 2500,
    check:
      'Working row, one line, no bubble: QA 2’s small key cap, “Running the Cypress tests” (breathing gently), then muted “· 3 steps · 5:3x”; under it, on the words’ edge, “Test runs usually take a few minutes”. No dots, no “Show output” under the line',
  },
  {
    name: 'live-output',
    route: '/chat/qa',
    ready: 'QA 2',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Running the Cypress tests');
      await sleep(600);
      await page.clickText('Show output');
      await sleep(600);
    },
    check:
      'The line opened: the steps so far under it (icons under the key cap, words on the line’s edge), ending on “Running the Cypress tests” with its own timer, “Last activity … · using the CPU” and the last lines Cypress printed in mono on a quiet panel, all inside that step; the hint after the list',
  },
  {
    name: 'live-finished',
    route: '/chat/qa',
    ready: 'QA 2',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Worked 8 min · 3 steps');
      await sleep(600);
      await page.clickText('Show output');
      await sleep(600);
    },
    check:
      'Finished timeline: “Tried to run the Cypress tests · 6m 12s · 42 passed, 3 failed”, its last output lines open under it',
  },
  {
    name: 'live-stalled',
    route: '/chat/fin',
    ready: 'Finance',
    settle: 2500,
    check:
      'The working line reads “No progress for 5 min · Building the project” with Finance’s key at rest (its side showing, not pressed) and the words not breathing, “Last activity …” under it on the words’ edge, then quiet text actions “Check on it” and “Stop” at the right edge',
  },
  {
    name: 'live-check',
    route: '/chat/fin',
    ready: 'Finance',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Check on it');
      await sleep(900);
    },
    check: 'What the Mac saw, one quiet line under the line, on the words’ edge, above the actions',
  },
];

/** `--importing`: the Chief mid-import and the Designer working. */
const IMPORTING = [
  {
    name: 'typing',
    route: '/chat/design',
    ready: 'Designer',
    settle: 2500,
    check:
      'Under the last message, one line: Designer’s key, pressed (down on a thin depth), then “Checking the button tokens” breathing gently and a muted count and time. No dots: the key says it’s working',
    frames: keyFrames('typing'),
  },
  {
    name: 'import-live',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    settle: 2500,
    check:
      'One bar above the composer, one line: blue typing dots, “Importing from Grok”. The working row under the chat has the same dots (mid-import it has no words, so the dots speak)',
    frames: dotFrames('typing'),
  },
  {
    name: 'import-screen-live',
    route: '/import',
    ready: 'Import agents',
    settle: 2500,
    check:
      'Step 3: blue typing dots, “Grok is telling Chief of Staff what each agent does”, then muted tabular “2 agents staged · 37 conversations” under the words',
  },
];

/** `--heavy`: an account in daily use (17 agents, ~40 cards waiting, long chats). */
const HEAVY = [
  {
    name: 'heavy-agents',
    route: '/agents',
    ready: 'Recruiting Coordinator',
    pages: 4,
    check: 'Density with 17 agents; needs-you first; long names truncate once; counts align',
  },
  {
    name: 'heavy-chat-inbox',
    route: '/chat/inbox',
    ready: 'Inbox Zero',
    pages: 8,
    check: 'Long chat: markdown, tables, code, timelines, a result card, then a run of cards',
  },
  {
    name: 'heavy-chat-recruit',
    route: '/chat/recruit',
    ready: 'Recruiting Coordinator',
    pages: 3,
    check: 'A long name in the header; login and key cards in a row',
  },
  {
    name: 'heavy-chat-chief',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    settle: 3000,
    check: 'Bars with an import an hour in; the composer above them',
  },
  {
    name: 'heavy-chat-ci',
    route: '/chat/ci',
    ready: 'Competitive Intelligence',
    pages: 3,
    check: 'Code block and result card in a long chat',
  },
  {
    name: 'heavy-search',
    route: '/search?q=renewal',
    settle: 3500,
    check: 'Many hits across agents: rows align, names truncate, snippets wrap to two lines',
  },
  {
    name: 'heavy-agent-sheet',
    route: '/agent/recruit',
    ready: 'Recruiting Coordinator',
    pages: 3,
    check: 'Paused routines; a long name and role',
  },
  {
    name: 'heavy-import',
    route: '/import',
    ready: 'Import agents',
    check: 'Import an hour in: 16 staged, 11 imported, 412 conversations',
  },
  { name: 'heavy-settings', route: '/settings', pages: 2, check: 'Settings with a busy account' },
];

/** The heavy account with the Mac out of reach. */
const HEAVY_OFFLINE = [
  {
    name: 'heavy-offline-agents',
    route: '/agents',
    settle: 5000,
    check: 'Saved heavy list, "as of …"',
  },
  {
    name: 'heavy-offline-chat-inbox',
    route: '/chat/inbox',
    settle: 5000,
    check: 'A run of cards disabled with one note, not one per card',
  },
];

/** `--team-setup`: sixteen agents just imported, and the checklist in the Chief's chat. */
/**
 * `--torture`: the chat torture set (dev/mock-torture.ts). Besides the
 * pictures, the event shots drive `/dev/torture` and check the chat's text:
 * a line shown twice, out of order or a dead draft is recorded as a failure.
 */
const torture = (what) => fetch(`${MOCK}/dev/torture?${what}`).then((r) => r.text());
/** How many times each text shows in the chat, as the reader sees it. */
const countIn = (page, texts) =>
  page.eval(`(() => {
    const body = document.body.innerText;
    return ${JSON.stringify(texts)}.map((t) => body.split(t).length - 1);
  })()`);
const expectCounts = async (page, texts, want) => {
  const got = await countIn(page, texts);
  texts.forEach((t, i) => {
    if (got[i] !== want[i])
      page.errors.push(`failed: “${t}” shown ${got[i]}×, expected ${want[i]}×`);
  });
};
// The chat is an inverted list: its scroll starts at the newest line, and older ones are further on.
const scrollChatToEnd = async (page) => {
  await page.eval(FIND_SCROLLER);
  await page.eval('window.__qaScroller && (window.__qaScroller.scrollTop = 0)');
  await sleep(500);
};
/** Where on screen a text is drawn (the inverted list's DOM order is newest first). */
const topOf = (page, text) =>
  page.eval(`(() => {
    const el = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && e.textContent.includes(${JSON.stringify(text)})).pop();
    return el ? el.getBoundingClientRect().top : null;
  })()`);
// The composer on a narrow and a wide phone, the model chip, and Agent controls.
const resize = (page, width) =>
  page.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, width });
const tapChip = (page) =>
  page.clickWhere(
    `() => [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label').startsWith('Runs on'))`,
    'the engine chip'
  );
const closeSheet = (page) => page.eval('history.back()').then(() => sleep(900));
// The chip is in the card's row: words that wrap make the card.
const LONG_ASK =
  'Can you pull last week’s numbers together for the Monday review, and flag anything that moved more than ten percent?';
const openControls = async (page) => {
  await clearField(page);
  await page.type(LONG_ASK);
  await sleep(700);
  await tapChip(page);
  await sleep(1200);
};
const closeAndClear = async (page) => {
  await closeSheet(page);
  await clearField(page);
};
const ENGINE = [
  ...[320, 360, 430].map((width) => ({
    name: `composer-empty-${width}`,
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await resize(page, width);
      await sleep(600);
    },
    check: `Empty at ${width}pt wide: one capsule, the placeholder on one line (clipped with an ellipsis if it doesn't fit)`,
    after: async (page) => resize(page, VIEWPORT.width),
  })),
  {
    name: 'composer-chip',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await page.type(
        'Can you pull last week’s numbers together for the Monday review, and flag anything that moved more than ten percent?'
      );
      await sleep(700);
    },
    check:
      'The card’s row: the model chip reads “Opus 5.5” with “· High” lighter and a small chevron (no engine name: the model is known)',
    after: clearField,
  },
  {
    name: 'controls-sheet',
    route: '/chat/design',
    ready: 'Designer',
    act: openControls,
    check:
      'Agent controls: “Designer · Opus 5.5 · High”, then Model (Default ticked, saying it is Opus 5.5 now; “Switch to Codex…” under it), Effort (High ticked), how much it does on its own, Usage, More about Designer',
    pages: 3,
    after: closeAndClear,
  },
  {
    name: 'controls-effort-changed',
    route: '/chat/design',
    ready: 'Designer',
    act: async (page) => {
      await openControls(page);
      await page.clickText('Medium');
      await sleep(900);
      await closeSheet(page);
      await sleep(600);
    },
    check:
      'Back in the chat: one quiet line “Now on Claude Code’s default model · Medium from its next message”, and the chip reads “Opus 5.5 · Medium”',
    after: clearField,
  },
  {
    name: 'controls-busy',
    route: '/chat/ops',
    ready: 'Ops',
    act: openControls,
    check:
      'Ops is working: the sheet says to change the model and effort once it’s done with this, their rows dimmed; the level stays open',
    pages: 2,
    after: closeAndClear,
  },
];
const TORTURE = [
  {
    name: 'torture-chat',
    route: '/chat/torture',
    ready: 'Torture',
    pages: 12,
    check:
      'Every kind of line: day dividers, the code block and wide table scroll inside their own frames (never the page), URLs and tokens wrap inside the screen, emoji / CJK / Hebrew / Arabic render, images are link chips, expired card a receipt, result v2 says what changed, nothing touches the screen edges',
  },
  {
    name: 'torture-events',
    route: '/chat/torture',
    ready: 'Torture',
    settle: 2500,
    act: async (page) => {
      await scrollChatToEnd(page);
      await torture('do=duplicate');
      await torture('do=outOfOrder');
      await torture('do=burst&n=12');
      await torture('do=stream&n=8');
      await torture('do=lateDraft');
      await torture('do=answer');
      await torture('do=replace');
      await sleep(2000);
      await scrollChatToEnd(page);
      await expectCounts(
        page,
        [
          'Burst line 1 of 12',
          'Burst line 12 of 12',
          'Written first (arrives second).',
          'Half of it',
          '(edited: one line added)',
        ],
        [1, 1, 1, 0, 1]
      );
      const first = await topOf(page, 'Written first');
      const second = await topOf(page, 'Written second');
      if (first == null || second == null || first > second)
        page.errors.push('failed: an overtaken line is shown below the line written after it');
    },
    check:
      'After a duplicated event, two lines out of order, a burst of 12, a streamed reply, a late draft, a card answered and a reply edited: each line once, in time order, no leftover draft, the newest line in view',
  },
  {
    name: 'torture-reconnect',
    route: '/chat/torture',
    ready: 'Got both.',
    settle: 2000,
    act: async (page) => {
      // The Mac restarts (a new epoch): the phone gets a snapshot and re-reads the chat.
      await startMock('--torture');
      await sleep(6000);
      await scrollChatToEnd(page);
      await expectCounts(page, ['Got both.', 'Plan for the week?'], [1, 1]);
    },
    check:
      'After the Mac restarts mid-chat: reconnected, every line once, nothing stale or doubled',
  },
  {
    name: 'torture-long',
    route: '/chat/longchat',
    ready: 'Answer 4999',
    settle: 2500,
    act: async (page) => {
      await page.eval(FIND_SCROLLER);
      for (let i = 0; i < 25; i++) {
        await page.eval('window.__qaScroller && (window.__qaScroller.scrollTop = 1e9)');
        await sleep(400);
      }
      // Deep in the history now: the oldest pages loaded, each line once.
      const deep = await page.eval(
        `(() => { const m = [...document.body.innerText.matchAll(/Question (\\d+):/g)].map((x) => +x[1]); return { n: m.length, min: Math.min(...m), dups: m.length - new Set(m).size }; })()`
      );
      if (deep.dups) page.errors.push(`failed: ${deep.dups} questions shown twice`);
      if (!(deep.min < 4800))
        page.errors.push(`failed: scrolling up never got past Question ${deep.min}`);
    },
    check:
      'A 5,000-line chat scrolled up through several pages: older lines load above, nothing doubled at a page seam',
  },
  {
    name: 'torture-empty',
    route: '/chat/quiet',
    ready: 'Quiet',
    check: 'An agent with no lines: its empty state, the composer usable, no stray divider or time',
  },
];

/**
 * A Mac just set up (`--solo`): only the Chief, its stored greeting and
 * nothing else. What a new phone lands on, and its first chat.
 */
const FIRST_RUN = [
  {
    name: 'firstrun-agents',
    route: '/agents',
    ready: 'Chief of Staff',
    settle: 2500,
    check: 'Only the Chief, its greeting as the preview; nothing that looks broken or empty',
  },
  {
    name: 'firstrun-catch-up',
    route: '/catch-up',
    settle: 2500,
    check:
      'Nothing waiting on a first day: the calm check, “All caught up” said once, why it is empty and the way to the Chief; spacing even top to bottom',
  },
  {
    name: 'firstrun-chat-chief',
    route: '/chat/chief',
    ready: 'Tell me what’s on your plate',
    settle: 2500,
    check:
      'The Chief’s greeting, then the desk’s three ideas as chips under it (Brief me every morning · Sort my inbox, draft replies · Research it and write it up), and the composer empty',
  },
  {
    name: 'firstrun-chat-chief-idea',
    route: '/chat/chief',
    ready: 'Brief me every morning',
    settle: 2000,
    act: async (page) => {
      await page.clickText('Brief me every morning');
      await sleep(800);
    },
    after: async (page) => {
      await page.eval(
        `(() => { const t = document.querySelector('textarea'); if (!t) return; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`
      );
      await sleep(400);
    },
    check:
      'A chip typed its whole brief into the composer (ending “My topics: ”) and nothing was sent; the chips stay until you send',
  },
  {
    name: 'firstrun-projects',
    route: '/projects',
    settle: 2500,
    check: 'No projects yet, said in one line',
  },
];

const TEAM_SETUP = [
  {
    name: 'setup-in-timeline',
    route: '/chat/chief',
    ready: 'Tomorrow is quiet',
    settle: 2500,
    check:
      'The newest lines at the foot are your “Thanks. I’ll do the logins tonight…” and the Chief’s reply about tomorrow, never the card. Above the composer one amber bar, “A few things to finish setting up your team · 0 of 4 done”, with Continue',
  },
  {
    name: 'setup-continue',
    route: '/chat/chief',
    ready: 'Tomorrow is quiet',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Continue');
      await sleep(1200);
    },
    check:
      'Continue scrolled up to the card where it was posted, under the import line, lit briefly; the two later messages are under it',
  },
  {
    name: 'setup-logins',
    route: '/chat/chief',
    ready: 'Setting up your team',
    settle: 2500,
    check:
      'One card in the Chief’s chat where it was posted, under the import line: “Setting up your team”, quiet “0 of 4 done”, the source line “A few things to finish… from Grok Bot”, a quiet set-aside note (no count). Add logins open with five rows and Add; the other steps folded rows with chevrons. Skip is quiet; no accent fill anywhere',
  },
  {
    name: 'setup-routines',
    route: '/chat/chief',
    ready: 'Setting up your team',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Switch on routines');
      await sleep(800);
    },
    check:
      'Routines unfolded: who · when, what it does, a switch each (one on); Skip, then a neutral Done',
  },
  {
    name: 'setup-hello',
    route: '/chat/chief',
    ready: 'Setting up your team',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Say hi to your team');
      await sleep(800);
      await scrollToText('Say hi to your team')(page);
    },
    check:
      'Say hi: one row per agent with its badge; two “Said hi”, Order QA “Replying…” with a spinner, the rest a Say hi button, disabled while Order QA replies',
  },
  {
    name: 'setup-done-step',
    route: '/chat/chief',
    ready: 'Setting up your team',
    settle: 2500,
    act: async (page) => {
      await page.clickText('What they’re missing');
      await sleep(600);
      // A second theme finds it skipped already: open it again first.
      await page
        .clickText('Open again')
        .then(() => sleep(1200))
        .catch(() => {});
      await page.clickText('Skip');
      await sleep(1500);
    },
    check:
      'What they’re missing skipped: its row reads “Skipped” with a dash, the meta “1 of 4 done”, the step folded',
  },
  {
    name: 'setup-set-aside',
    route: '/chat/imp0',
    ready: 'Newsletter',
    settle: 2500,
    check:
      'Newsletter: the import line, its login card, and the set-aside request as a receipt: clock, “Set aside · Run a command”; a tap shows why and that nothing ran',
  },
];

// ---- Report -------------------------------------------------------------------------

function report(meta) {
  const lines = [
    '# Phone screens (web build)',
    '',
    `${shots.length} shots at ${VIEWPORT.width}×${VIEWPORT.height} @${VIEWPORT.deviceScaleFactor}x, themes: ${THEMES.join(', ')}. ${meta}`,
    '',
    'Web-only artifacts to ignore: the tab bar is a pill at the top, there are no safe areas or',
    'iOS large titles, icons are Material Symbols, images behind auth are grey. See docs/mobile.md.',
    '',
  ];
  for (const s of shots) {
    lines.push(`## ${s.name}`, '', `- Route: \`${s.route}\``, `- Check: ${s.check}`);
    if (s.errors.length)
      lines.push(
        `- Console: ${s.errors
          .slice(0, 5)
          .map((e) => `\`${e}\``)
          .join('; ')}`
      );
    if (s.clipped.length)
      lines.push(
        `- Cut off: ${s.clipped
          .slice(0, 8)
          .map((t) => `“${t}”`)
          .join('; ')}`
      );
    lines.push('', `![${s.name}](${s.name}.png)`, '');
  }
  return lines.join('\n');
}

// ---- Main ---------------------------------------------------------------------------

/**
 * One send, frame by frame: from the press of Send to the agent's first
 * words. A recorder in the page reads, every animation frame, where the sent
 * bubble is, how many copies of it are drawn, whether its DOM node was
 * replaced, whether "Sending…" shows, and where the composer and the row
 * before it sit; a screencast keeps the pictures. Any jump the eye calls
 * "it tweaks" is a line in `send-<theme>/frames.md`.
 */
async function sendFrames(page, theme) {
  const dir = path.join(OUT, `send-${theme}`);
  rmSync(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const text = `Can you tighten the spacing on the pricing cards and check the hover states on phones too? (${theme})`;
  await page.goto(`${WEB}/chat/design`);
  await page.waitFor(`document.body.innerText.includes('Designer')`, 20_000, 'Designer');
  await sleep(2500);
  await page.type(text, 'textarea');
  await sleep(800);
  // The row that was newest before the send: its text, to follow it.
  await page.eval(`(() => {
    const field = document.querySelector('textarea').getBoundingClientRect().top;
    const rows = [...document.querySelectorAll('[dir="auto"]')]
      .filter((e) => e.innerText?.trim().length > 12 && !e.closest('textarea'))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.height && r.bottom < field - 40 && r.top > 80);
    rows.sort((a, b) => b.r.bottom - a.r.bottom);
    window.__qaAnchor = rows[0]?.e ?? null;
  })()`);
  const frames = [];
  const onFrame = (msg) => {
    if (msg.method !== 'Page.screencastFrame') return;
    frames.push({ t: Date.now(), data: msg.params.data });
    page.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
  };
  page.listeners.add(onFrame);
  await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.eval(`(() => {
    const sent = ${JSON.stringify(text)};
    const ids = new WeakMap(); let next = 1;
    const id = (n) => { if (!ids.has(n)) ids.set(n, next++); return ids.get(n); };
    const log = (window.__qaLog = []);
    const t0 = performance.now();
    const tick = () => {
      const field = document.querySelector('textarea');
      const bubbles = [...document.querySelectorAll('[dir="auto"]')].filter(
        (e) => e.innerText?.trim() === sent && !e.closest('textarea')
      );
      const texts = document.body.innerText;
      const a = window.__qaAnchor;
      log.push({
        t: Math.round(performance.now() - t0),
        n: bubbles.length,
        y: bubbles.map((b) => Math.round(b.getBoundingClientRect().top)),
        node: bubbles.map(id),
        sending: texts.includes('Sending…'),
        queued: texts.includes('Queued ·'),
        field: field ? Math.round(field.getBoundingClientRect().top) : null,
        anchor: a && a.isConnected ? Math.round(a.getBoundingClientRect().top) : null,
      });
      if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  const t0 = Date.now();
  await sleep(150);
  await page.clickLabel('Send');
  await sleep(4200);
  await page.send('Page.stopScreencast');
  page.listeners.delete(onFrame);
  const rec = await page.eval('window.__qaLog');
  // Changes only: a row per frame where anything moved or appeared.
  const lines = [];
  let prev = null;
  for (const f of rec) {
    const key = JSON.stringify({ ...f, t: 0 });
    if (key === prev) continue;
    prev = key;
    lines.push(
      `| ${f.t} | ${f.n} | ${f.y.join(', ')} | ${f.node.join(', ')} | ${f.sending ? 'yes' : ''} | ${f.queued ? 'yes' : ''} | ${f.field ?? ''} | ${f.anchor ?? ''} |`
    );
  }
  for (const [i, f] of frames.entries()) {
    await writeFile(
      path.join(dir, `f${String(i).padStart(3, '0')}-${f.t - t0}ms.png`),
      Buffer.from(f.data, 'base64')
    );
  }
  await writeFile(
    path.join(dir, 'frames.md'),
    [
      `# One send, frame by frame (${theme})`,
      '',
      `Recorder from 150 ms before Send for 4 s; a row for each frame where something changed. ${frames.length} screencast frames saved beside this file.`,
      '',
      '| ms | copies | bubble top | node | Sending… | Queued | field top | row before |',
      '|---|---|---|---|---|---|---|---|',
      ...lines,
      '',
    ].join('\n')
  );
  shots.push({
    name: `send-${theme}`,
    route: '/chat/design',
    theme,
    check: `One send, frame by frame: see send-${theme}/frames.md. One copy of the bubble throughout, one node, no jump back down`,
    errors: [...new Set(page.errors)],
    clipped: [],
  });
  page.errors = [];
  log(`send frames ${theme}: ${frames.length} pictures, ${lines.length} changes`);
}
// ---- Long-chat timings (`--phases perf`) ---------------------------------------------

/**
 * Before any page script: long tasks, and when the newest line of the
 * 5,000-line "Long Rich" chat first shows (`dev/mock-torture.ts`).
 */
const PERF_PRELUDE = `(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
  const mo = new MutationObserver(() => {
    if (window.__newest === undefined && location.pathname.includes('longrich') && document.body.innerText.includes('Question 4995:')) {
      window.__newest = performance.now();
      mo.disconnect();
    }
  });
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true, characterData: true }));
})()`;
const longTasksSince = (page, t0) =>
  page.eval(`(() => { const l = window.__lt.filter((e) => e.s + e.d >= ${t0});
    return { count: l.length, totalMs: Math.round(l.reduce((a, e) => a + e.d, 0)), max: Math.round(Math.max(0, ...l.map((e) => e.d))) }; })()`);
const frameStats = (ft) => {
  const s = [...ft].sort((a, b) => a - b);
  const q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(1);
  const total = ft.reduce((a, b) => a + b, 0) || 1;
  return {
    frames: ft.length,
    fps: +((ft.length / total) * 1000).toFixed(1),
    p50: q(0.5),
    p95: q(0.95),
    max: q(1),
    over33ms: ft.filter((f) => f > 33.4).length,
  };
};

/** The Long Rich chat on screen at its newest line; a picture of what was there instead. */
async function openedChat(page, failedShot) {
  try {
    await page.waitFor(
      `location.pathname.includes('longrich') && document.body.innerText.includes('Question 4995:')`,
      30_000,
      'the chat'
    );
  } catch (error) {
    await page.screenshot(path.join(OUT, failedShot)).catch(() => {});
    throw error;
  }
}

async function perfLongChat(page) {
  const results = {};
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PERF_PRELUDE });
  // Cold: a deep link straight into the chat (the app starts, reconnects, reads the newest page).
  const cold = [];
  for (let i = 0; i < 3; i++) {
    await page.goto(`${WEB}/chat/longrich`);
    await page.waitFor('window.__newest !== undefined', 60_000, 'the newest line');
    await sleep(1500);
    cold.push({
      newestMs: Math.round(await page.eval('window.__newest')),
      longTasks: await longTasksSince(page, 0),
    });
  }
  results.cold = cold;
  log('perf', `cold ${JSON.stringify(cold)}`);
  // Warm: the app already running on the agents list, then into the chat
  // (an in-app navigation, as a tap makes it).
  const warm = [];
  // `QA_PROFILE=1`: a .cpuprofile of the last open (and of the scroll, below).
  const profileOpen = !!process.env.QA_PROFILE;
  for (let i = 0; i < 3; i++) {
    await page.goto(`${WEB}/agents`);
    await page.waitFor(`document.body.innerText.includes('Long Rich')`, 60_000, 'the agents list');
    await sleep(2500);
    if (profileOpen && i === 2) {
      await page.send('Profiler.enable');
      await page.send('Profiler.setSamplingInterval', { interval: 100 });
      await page.send('Profiler.start');
    }
    const t0 = await page.eval('performance.now()');
    await page.eval(
      `history.pushState(null, '', '/chat/longrich'); dispatchEvent(new PopStateEvent('popstate'))`
    );
    await openedChat(page, 'perf-warm-failed.png');
    const t1 = await page.eval(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))'
    );
    await sleep(1000);
    if (profileOpen && i === 2) {
      const { profile: p } = await page.send('Profiler.stop');
      await writeFile(path.join(OUT, 'perf-open.cpuprofile'), JSON.stringify(p));
    }
    warm.push({ openMs: Math.round(t1 - t0), longTasks: await longTasksSince(page, t0) });
  }
  results.warm = warm;
  log('perf', `warm ${JSON.stringify(warm)}`);
  // Scrolling up (older lines: further on in the inverted list), 30 s at 250 px a frame.
  // The chat's own list: the agents list stays mounted under it in the stack.
  await page.eval(`(() => {
    const els = [...document.querySelectorAll('div')].filter((e) =>
      e.scrollHeight > e.clientHeight + 20 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) &&
      e.innerText.includes('Question 4995:'));
    els.sort((a, b) => a.innerText.length - b.innerText.length);
    window.__qaScroller = els[0] ?? null;
  })()`);
  const t0 = await page.eval('performance.now()');
  // `QA_PROFILE=1`: a .cpuprofile of the scroll beside the numbers.
  const profile = !!process.env.QA_PROFILE;
  if (profile) {
    await page.send('Profiler.enable');
    await page.send('Profiler.start');
  }
  const scroll = await page.eval(`(async () => {
    const el = window.__qaScroller;
    const ft = [];
    let last = performance.now();
    const start = last;
    while (performance.now() - start < 30000) {
      el.scrollTop += 250;
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      ft.push(t - last);
      last = t;
    }
    const q = [...document.body.innerText.matchAll(/Question (\\d+):/g)].map((x) => +x[1]);
    return { ft, oldestShown: Math.min(...q), domNodes: document.getElementsByTagName('*').length };
  })()`);
  if (profile) {
    const { profile: p } = await page.send('Profiler.stop');
    await writeFile(path.join(OUT, 'perf-scroll.cpuprofile'), JSON.stringify(p));
  }
  results.scroll = {
    ...frameStats(scroll.ft),
    longTasks: await longTasksSince(page, t0),
    oldestQuestionReached: scroll.oldestShown,

    domNodes: scroll.domNodes,
    heapMB: +((await page.eval('performance.memory?.usedJSHeapSize ?? 0')) / 1048576).toFixed(1),
  };
  await writeFile(path.join(OUT, 'perf-long-chat.json'), JSON.stringify(results, null, 2));
  log('perf', JSON.stringify(results));
}

// ---- Requests and renders (`--phases net`) ------------------------------------------

/**
 * Before any page script: a stand-in for the React DevTools hook that counts
 * commits and the components each one rendered (by name), so a run can say
 * how much of the tree an event or a tap re-renders. React sees a hook and
 * turns its profiling timers on, which is what dates each fiber's render.
 */
const RENDER_PRELUDE = `(() => {
  const counts = { commits: 0, renders: 0, byName: {}, roots: {} };
  window.__renders = counts;
  let since = 0;
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return '?';
    if (typeof t === 'function') return t.displayName || t.name || 'anon';
    if (t.render) return t.displayName || t.render.displayName || t.render.name || 'forwardRef';
    if (t.type) return t.displayName || nameOf({ type: t.type });
    return '?';
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { this.renderers.set(1, r); return 1; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      counts.commits++;
      // A render whose parent component didn't render is where it started (a
      // store subscription, state, context): counted apart as \`roots\`.
      const stack = [[root.current, false]];
      while (stack.length) {
        const [f, parentRendered] = stack.pop();
        let rendered = parentRendered;
        if ([0, 1, 11, 14, 15].includes(f.tag)) {
          // Visited this commit (dated) and not bailed out (PerformedWork).
          rendered = f.actualStartTime >= since && (f.flags & 1) === 1;
          if (rendered) {
            counts.renders++;
            const n = nameOf(f);
            counts.byName[n] = (counts.byName[n] || 0) + 1;
            if (!parentRendered) {
              // Named with the component that drew it, which is usually the one to look at.
              const o = f._debugOwner;
              const k = o && o.type ? n + ' in ' + nameOf(o) : n;
              counts.roots[k] = (counts.roots[k] || 0) + 1;
            }
          }
        }
        if (f.sibling) stack.push([f.sibling, parentRendered]);
        if (f.child) stack.push([f.child, rendered]);
      }
      since = performance.now();
    },
  };
})()`;

const resetRenders = (page) =>
  page.eval(
    `(() => { const c = window.__renders; c.commits = 0; c.renders = 0; c.byName = {}; c.roots = {}; })()`
  );
const readRenders = (page) =>
  page.eval(`(() => { const c = window.__renders;
    const top = Object.entries(c.byName).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const roots = Object.entries(c.roots).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return { commits: c.commits, renders: c.renders, top: Object.fromEntries(top), roots: Object.fromEntries(roots) }; })()`);
const resetRequests = () => fetch(`${MOCK}/dev/requests?reset=1`).then((r) => r.json());
async function readRequests() {
  const all = await (await fetch(`${MOCK}/dev/requests`)).json();
  const byMethod = {};
  for (const r of all) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  // The most requests inside any 250 ms: how hard a burst lands on the Mac.
  let burst = 0;
  for (let i = 0, j = 0; i < all.length; i++) {
    while (all[i].at - all[j].at > 250) j++;
    burst = Math.max(burst, i - j + 1);
  }
  return { total: all.length, burst250ms: burst, byMethod };
}
/** Requests and renders over `work`. */
async function measured(page, label, work) {
  await resetRequests();
  await resetRenders(page);
  const t0 = Date.now();
  const extra = (await work()) ?? {};
  const out = {
    ms: Date.now() - t0,
    ...extra,
    requests: await readRequests(),
    renders: await readRenders(page),
  };
  log('net', label, JSON.stringify(out));
  return out;
}
const navigate = (page, to) =>
  page.eval(
    `history.pushState(null, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate'))`
  );
const shows = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

async function netAndRenders(page) {
  const results = {};
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RENDER_PRELUDE });
  await page.goto(`${WEB}/agents`);
  await page.waitFor(shows('Chief of Staff'), 60_000, 'the agents list');
  await sleep(4000);
  // Cold start with a saved copy: the reload reads it, then reconnects.
  results.cold = await measured(page, 'cold', async () => {
    await page.send('Page.navigate', { url: `${WEB}/agents` });
    const t0 = Date.now();
    let spinner = false;
    for (;;) {
      const s = await page
        .eval(
          `({ row: ${shows('Chief of Staff')}, spin: !!document.querySelector('[role="progressbar"]') })`
        )
        .catch(() => ({}));
      if (s.spin) spinner = true;
      if (s.row) break;
      if (Date.now() - t0 > 60_000) throw new Error('cold start never showed the list');
      await sleep(20);
    }
    const firstRowMs = Date.now() - t0;
    await sleep(5000);
    return { firstRowMs, spinnerBeforeRow: spinner };
  });
  // Nothing happening: what an idle, connected app costs.
  results.idle = await measured(page, 'idle', () => sleep(10_000));
  // Tabs, three times round.
  results.tabs = await measured(page, 'tabs', async () => {
    for (let i = 0; i < 3; i++) {
      for (const [to, text] of [
        ['/catch-up', 'Catch up'],
        ['/projects', 'Projects'],
        ['/search', 'Search'],
        ['/agents', 'Chief of Staff'],
      ]) {
        await navigate(page, to);
        await page.waitFor(shows(text), 10_000, to);
        await sleep(400);
      }
    }
  });
  // A chat, opened and left three times: the first open reads it, the rest show the copy.
  results.chat = await measured(page, 'chat', async () => {
    const opens = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await navigate(page, '/chat/site');
      await page.waitFor(
        `location.pathname === '/chat/site' && document.querySelector('textarea')`,
        15_000,
        'the chat'
      );
      opens.push(Date.now() - t0);
      await sleep(1500);
      await page.eval('history.back()');
      await page.waitFor(`location.pathname === '/agents'`, 10_000, 'back');
      await sleep(800);
    }
    return { openMs: opens };
  });
  // Tapping between chats quickly: the burst the Mac sees.
  results.burst = await measured(page, 'burst', async () => {
    for (let i = 0; i < 3; i++) {
      for (const id of ['main', 'site', 'main', 'site']) {
        await navigate(page, `/chat/${id}`);
        await sleep(120);
        await page.eval('history.back()');
        await sleep(120);
      }
    }
    await sleep(2000);
  });
  // The Mac going away and coming back under an open app.
  results.reconnect = await measured(page, 'reconnect', async () => {
    await killMock();
    await sleep(3000);
    await startMock();
    const t0 = Date.now();
    await page.waitFor(
      `!/Reconnecting|Can.t reach|Reaching|Not connected/.test(document.body.innerText)`,
      30_000,
      'reconnected'
    );
    const backMs = Date.now() - t0;
    await sleep(5000);
    return { backMs };
  });
  // A reply streaming into the open chat: what each draft event re-renders.
  await navigate(page, '/chat/site');
  await page.waitFor(`document.querySelector('textarea')`, 15_000, 'the chat');
  await sleep(1500);
  results.stream = await measured(page, 'stream', async () => {
    await page.type('Write me a long reply please', 'textarea');
    await sleep(200);
    await page.clickWhere(
      `() => [...document.querySelectorAll('[aria-label]')].find((e) => /^(Send|Queue)/.test(e.getAttribute('aria-label')))`,
      'Send'
    );
    await sleep(10_000);
  });
  // The same, watched from the agents list: what one agent's turn costs the rows.
  await sleep(5000);
  results.streamList = await measured(page, 'streamList', async () => {
    await page.type('And another long one', 'textarea');
    await sleep(200);
    await page.clickWhere(
      `() => [...document.querySelectorAll('[aria-label]')].find((e) => /^(Send|Queue)/.test(e.getAttribute('aria-label')))`,
      'Send'
    );
    await sleep(300);
    await page.eval('history.back()');
    await sleep(10_000);
  });
  await writeFile(path.join(OUT, 'net.json'), JSON.stringify(results, null, 2));
  log('net', 'written', path.join(OUT, 'net.json'));
}

async function main() {
  for (const p of [WEB_PORT, MOCK_PORT, CDP_PORT]) {
    if (!(await portFree(p)))
      throw new Error(
        `Port ${p} is in use; pass another with --web-port / --mock-port / --cdp-port`
      );
  }
  await mkdir(OUT, { recursive: true });
  const started = Date.now();
  await startMock();
  log(`starting expo web on ${WEB_PORT} (the first bundle takes a while)`);
  run(
    'expo',
    path.join(ROOT, 'node_modules/.bin/expo'),
    ['start', '--web', '--port', String(WEB_PORT)],
    {
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      BROWSER: 'none',
    }
  );
  await waitForUrl(WEB, 120_000, 'expo web');
  await startChrome();
  const page = await openTab();
  await setTheme(page, THEMES[0]);

  // Before pairing: the welcome (Tailscale on, then scan), then a Mac that
  // never answers (a silent server in the link's place): "Reaching…" while
  // it waits, then the reason, never a spinner forever.
  const link = await (await fetch(`${MOCK}/dev/link`)).text();
  const d = new URL(link.replace(/^[^:]+:\/\//, 'http://x/')).searchParams.get('d');
  await prePairShots(page, d);
  if (phase('demo')) await demoShots(page);

  // Pair through the real confirm screen.
  await page.goto(`${WEB}/pair?d=${d}`);
  await page.waitFor(
    `[...document.querySelectorAll('body *')].some((e) => e.innerText?.trim() === 'Pair')`,
    180_000,
    'the pairing screen'
  );
  await sleep(800);
  if (wanted(`pair-confirm-${THEMES[0]}`))
    await capture(page, `pair-confirm-${THEMES[0]}`, {
      route: '/pair?d=…',
      check: 'Which Mac, where, what it replaces',
      theme: THEMES[0],
    });
  await page.clickText('Pair');
  await page.waitFor(
    `location.pathname.startsWith('/agents') || document.body.innerText.includes('Chief of Staff')`,
    30_000,
    'pairing to finish'
  );
  await sleep(3000);
  log('paired');

  const each = async (list) => {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const s of list) await screen(page, theme, s);
    }
    // So far, after every phase: a run stopped part-way (its time ran out) still says what it saw.
    await writeFile(
      path.join(OUT, 'report.md'),
      report(`Unfinished: ${Math.round((Date.now() - started) / 1000)} s so far.`)
    );
  };

  // Nothing opened yet: the deep-linked chat has nothing saved.
  if (phase('fresh')) {
    await stopMock();
    await each(OFFLINE_FRESH);
  }

  if (phase('live') || phase('cached')) {
    await startMock();
    if (phase('live')) await each(LIVE);
    if (phase('cached')) {
      await stopMock();
      await each(OFFLINE_CACHED);
    }
  }

  if (phase('impostor')) {
    await startMock('--impostor');
    await each(NOT_YOUR_MAC);
  }

  if (phase('bars')) {
    await startMock('--bars');
    await page.goto(`${WEB}/agents`);
    await sleep(4000); // reconnect to the real key again
    await each(BARS);
  }

  if (phase('usage-accounts')) {
    await startMock('--usage', 'room');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each([
      {
        name: 'usage-glance',
        route: '/agents',
        ready: 'Agents',
        check:
          'Under the Agents title, one compact card before the first row: "Usage" over "72% left · 2 accounts", a refill chip and a chevron at the right, then a bar of one segment per account, the fullest first, with gaps and rounded ends; air above and below, neutral ink',
      },
      {
        name: 'usage-total',
        route: '/usage',
        ready: 'Usage',
        check:
          'The total first: "All accounts", a large "72% left", "across 2 accounts", "Next refill in …". One bar of two segments, Personal (full) on the left, then the account in use (44%); under it each account named with its % left and a ⟳ chip. Then "ACCOUNTS": one grouped card with a row each (keycap 1 filled for the one in use, name, % left, a thin bar, the pill and ⟳ countdown, a chevron).',
      },
      {
        name: 'usage-account',
        route: '/usage-account?engine=claude&account=default',
        ready: 'Usage',
        check:
          '"‹ Usage" above the account’s name as the title; a card with a large keycap, "In use", "1st in the order · Max plan · …" and its place arrows; then "Limits" with Limits | Tokens at its right, and each limit its own card: name and ⟳ chip, a big "% left", the pace-marked bar, a now → refills line when it runs out early, the pace sentence and "Refills …", as the desk’s account page.',
      },
      {
        name: 'usage-account-tokens',
        route: '/usage-account?engine=claude&account=default',
        ready: 'Limits',
        act: async (page) => {
          await page.clickText('Tokens');
          await sleep(700);
        },
        check:
          '"Used by these agents this week" with Limits | Tokens; a table card: Agent / Tokens / Messages, each row an agent key, name, a thin share bar and right-aligned figures, then "Tokens as Claude Code or Codex reported them … Not a cost".',
      },
      {
        name: 'usage-total-accounts',
        route: '/usage',
        ready: 'Usage',
        act: scrollToText('Accounts'),
        check:
          '"Accounts" as a heading with "Work starts on the first account with room …" under it; one list per engine when there are two, each row: keycap, name and % left, its plan, a thin bar, the pill and a ⟳ chip, a chevron.',
      },
    ]);
    for (const variant of ['two-claude', 'one-read']) {
      await startMock('--usage', variant);
      await page.goto(`${WEB}/agents`);
      await sleep(4000);
      await each([
        {
          name: `usage-accounts-${variant}`,
          route: '/usage?id=site',
          ready: 'Usage',
          act: scrollToText('Accounts'),
          check:
            'Your accounts: a sheet with one headline, the stack as a segmented meter (one segment per account in order; an unread one an empty outlined slot, never full) with each account named and its room under it, and the next reset; then each account as a card: a numbered keycap (the one in use filled), its name, plan and who, a state pill ("In use", "Out of usage until …", "Not signed in"), its 5-hour and Weekly bars with "Resets in …", and a pace line in secondary ink (never amber) when the Mac sent one; no account named "This Mac"',
        },
      ]);
    }
  }

  if (phase('heavy')) {
    await startMock('--heavy');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(HEAVY);
    await stopMock();
    await each(HEAVY_OFFLINE);
  }

  if (phase('live-work')) {
    await startMock('--live-work');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(LIVE_WORK);
  }

  if (phase('importing')) {
    await startMock('--importing');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(IMPORTING);
  }

  if (phase('first-run')) {
    await startMock('--solo');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(FIRST_RUN);
  }

  if (phase('team-setup')) {
    await startMock('--team-setup');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(TEAM_SETUP);
  }

  if (phase('engine')) {
    await startMock('--both-engines');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(ENGINE);
  }

  if (phase('send')) {
    await startMock();
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await sendFrames(page, theme);
    }
  }

  if (phase('probe')) {
    // Each theme on a fresh Mac: the desk answers and deletes as it goes.
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await startMock('--probe');
      await page.goto(`${WEB}/agents`);
      await sleep(4000);
      for (const s of PROBE) await screen(page, theme, s);
      await startMock('--probe', '--restarted');
      await page.goto(`${WEB}/agents`);
      await sleep(4000);
      for (const s of PROBE_RESTARTED) await screen(page, theme, s);
    }
    await writeFile(
      path.join(OUT, 'report.md'),
      report(`Unfinished: ${Math.round((Date.now() - started) / 1000)} s so far.`)
    );
  }

  if (phase('reconnecting')) await reconnectingShots(page);
  if (phase('link-down')) await linkDownShots(page);

  if (phase('perf')) {
    await startMock('--torture');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await perfLongChat(page);
  }

  if (phase('net')) {
    await startMock();
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await netAndRenders(page);
  }

  if (phase('torture')) {
    await startMock('--torture');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(TORTURE);
  }

  page.close();
  await writeFile(
    path.join(OUT, 'report.md'),
    report(`Took ${Math.round((Date.now() - started) / 1000)} s.`)
  );
  const failed = shots.filter((s) =>
    s.errors.some((e) => e.startsWith('failed') || e.startsWith('exception'))
  );
  log(`${shots.length} shots in ${OUT}; ${failed.length} with failures or exceptions`);
  return failed.length ? 1 : 0;
}

main()
  .then(async (code) => {
    await Promise.all([...children].map(stop));
    process.exit(code);
  })
  .catch(async (e) => {
    console.error('[qa:web]', e.message);
    for (const c of children)
      if (c.output && VERBOSE === false)
        console.error(`--- ${c.spawnargs[1] ?? ''}\n${c.output.slice(-2000)}`);
    await Promise.all([...children].map(stop));
    process.exit(2);
  });
