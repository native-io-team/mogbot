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
 *   pnpm qa:web --only chat-             # shots whose name starts with chat-
 *   pnpm qa:web --phases heavy           # only these phases (fresh,live,cached,impostor,bars,heavy,importing,team-setup,live-work,torture)
 *   pnpm qa:web --themes dark            # one theme
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
const PHASES = opt(
  '--phases',
  'QA_PHASES',
  'fresh,live,cached,impostor,bars,heavy,importing,team-setup,live-work,torture'
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

// ---- CDP ---------------------------------------------------------------------------

class Page {
  #ws;
  #id = 0;
  #pending = new Map();
  errors = [];

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
  chrome = run('chrome', CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(work, 'chrome')}`,
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
const wanted = (name) => !ONLY || name.startsWith(ONLY);

/**
 * The pairing screens before anything is paired, in each theme: the welcome
 * ("Before you scan"), "Reaching <Mac>…" against a server that never
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
          `document.body.innerText.includes('Before you scan')`,
          180_000,
          'the welcome'
        );
        await sleep(800);
        await capture(page, `pair-start-${theme}`, {
          route: '/pair',
          check:
            '“Before you scan” card above Scan: three lines (installed, connected, same account), why, and a Get/Open Tailscale button',
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
          '“Can’t reach <Mac>”, the host, what to check (Tailscale on, same account), Open Tailscale and Try again',
        theme,
      });
    }
  } finally {
    silent.closeAllConnections();
    silent.close();
    await setTheme(page, THEMES[0]);
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

/** Connected, everything the mock seeds. */
const LIVE = [
  {
    name: 'agents',
    route: '/agents',
    ready: 'Chief of Staff',
    check: 'Needs you, then Chief and pinned, then by activity; each row says what needs the OK',
  },
  {
    name: 'projects',
    route: '/projects',
    ready: 'acme-site',
    check: 'Project list, sessions per project',
  },
  { name: 'search', route: '/search', check: 'Empty search' },
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
      'Stopped, keep editing: the paragraph in the field at the same width it had while listening, no row over it, mic and Send back',
    after: async (page) => {
      await page.eval(`globalThis.__qaDictation = {}`);
      await page.clickLabel('Send').catch(() => {});
      await sleep(800);
    },
  },
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
    act: scrollToText('Connect Gmail'),
    check:
      'Login card: "Finance needs your Gmail", asked-as line, what it can do, the no-connector line, Not now + Connect Gmail (neutral), Use my browser below with what it means; no password field',
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
  { name: 'memory', route: '/memory?id=site', ready: 'Memory', check: 'Placeholder not clipped' },
  { name: 'instructions', route: '/instructions?id=site', check: 'Instructions editor' },
  { name: 'files', route: '/files/site', check: 'Files list' },
  {
    name: 'schedule',
    route: '/schedule?agentId=site',
    check: 'Routine picker; the summary has no literal ellipsis',
  },
  { name: 'new-agent', route: '/new-agent', check: 'New agent' },
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
    name: 'settings-usage',
    route: '/settings',
    ready: 'Use it all before reset',
    act: scrollToText('Spare-capacity list'),
    check:
      'Usage: "Use it all before reset" with its line; "Claude 5-hour limit resets … · 62% unused"; "Claude Code: average turn" says it is an estimate; the list "0 waiting" (its one item started); Ollama running with its model, Opencode installed. Read-only.',
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
    check: 'What is wrong, layer by layer',
  },
];

/** Straight after pairing, before any chat was opened: nothing saved for it. */
const OFFLINE_FRESH = [
  {
    name: 'offline-agents',
    route: '/agents',
    settle: 5000,
    check: 'The list as last seen at pairing, or the empty reason',
  },
  {
    name: 'offline-chat-design',
    route: '/chat/design',
    settle: 6000,
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

/** `--live-work`: what agents are doing, live (QA 2 on Cypress, Finance gone quiet). */
const LIVE_WORK = [
  {
    name: 'live-agents',
    route: '/agents',
    ready: 'QA 2',
    settle: 2500,
    check:
      'QA 2: a slowly breathing ring in its colour around the avatar, “Running the Cypress tests · 5m”; Finance: ring, “No progress for 5 min”; no spinner beside either',
  },
  {
    name: 'live-step',
    route: '/chat/qa',
    ready: 'QA 2',
    settle: 2500,
    check:
      'Working row: dots, “Running the Cypress tests”, a muted 5:3x timer; under it “Test runs usually take a few minutes”, then a folded “Show output”',
  },
  {
    name: 'live-output',
    route: '/chat/qa',
    ready: 'QA 2',
    settle: 2500,
    act: async (page) => {
      await page.clickText('Show output');
      await sleep(600);
      await page.clickText('Running the Cypress tests');
      await sleep(600);
    },
    check:
      'The last lines Cypress printed in mono on a quiet panel; “Last activity … · using the CPU” revealed under the hint',
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
      'The working line reads “No progress for 5 min” with a still clock (no dots), then neutral “Check on it” and outlined “Stop”',
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
    check: 'What the Mac saw, one quiet line under the buttons',
  },
];

/** `--importing`: the Chief mid-import and the Designer working. */
const IMPORTING = [
  {
    name: 'typing',
    route: '/chat/design',
    ready: 'Designer',
    settle: 2500,
    check: 'Under the last message: three dots in one even wave, then “Checking the button tokens”',
    frames: dotFrames('typing'),
  },
  {
    name: 'import-live',
    route: '/chat/chief',
    ready: 'Chief of Staff',
    settle: 2500,
    check:
      'One bar above the composer, one line: blue typing dots, “Importing from Grok”. The working row under the chat has the same dots',
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

  // Before pairing: the welcome with "Before you scan", then a Mac that
  // never answers (a silent server in the link's place): "Reaching…" while
  // it waits, then the reason, never a spinner forever.
  const link = await (await fetch(`${MOCK}/dev/link`)).text();
  const d = new URL(link.replace(/^[^:]+:\/\//, 'http://x/')).searchParams.get('d');
  await prePairShots(page, d);

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

  if (phase('team-setup')) {
    await startMock('--team-setup');
    await page.goto(`${WEB}/agents`);
    await sleep(4000);
    await each(TEAM_SETUP);
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
