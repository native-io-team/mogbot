#!/usr/bin/env node
/**
 * Phone screens without a simulator: render the companion app with
 * react-native-web against the mock Mac and capture a fixed list of screens,
 * light and dark, at an iPhone 17 Pro's 402×874 @3x.
 *
 * It starts the mock (`--http --cors`) and `expo start --web`, pairs through
 * the real `/pair?d=` confirm screen, then walks the phases below, restarting
 * or stopping the mock to reach the states only a Mac can cause (out of
 * reach, "This isn't your Mac", three bars). Writes PNGs plus `report.md`.
 *
 * Dependency-free on purpose, like the desktop's scripts/harness-capture.mjs:
 * the Chrome DevTools Protocol over Node's built-in WebSocket and fetch.
 *
 *   pnpm qa:web                          # everything, into qa-shots/
 *   pnpm qa:web --only chat-             # shots whose name starts with chat-
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

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
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
    name: 'result-ask',
    route: '/chat/fixtures',
    ready: 'Fixtures',
    act: scrollToText('Ask for changes'),
    check: 'A result card with Ask for changes (needs welcome.features)',
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
    name: 'session',
    route: '/session/pty-site-1',
    settle: 3500,
    check: 'A task: its screen, its question, the composer',
  },
  {
    name: 'settings',
    route: '/settings',
    pages: 2,
    check: 'Dates in the one short format ("Nov 5, 2026")',
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

  // Pair through the real confirm screen.
  const link = await (await fetch(`${MOCK}/dev/link`)).text();
  const d = new URL(link.replace(/^[^:]+:\/\//, 'http://x/')).searchParams.get('d');
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
  await stopMock();
  await each(OFFLINE_FRESH);

  await startMock();
  await each(LIVE);

  await stopMock();
  await each(OFFLINE_CACHED);

  await startMock('--impostor');
  await each(NOT_YOUR_MAC);

  await startMock('--bars');
  await page.goto(`${WEB}/agents`);
  await sleep(4000); // reconnect to the real key again
  await each(BARS);

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
