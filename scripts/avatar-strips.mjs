#!/usr/bin/env node
/**
 * Key-cap avatar shots (docs/internal/avatars.md): each motion state as a
 * frame strip at 48px and 96px, the shape × face sheet, sizes and colours,
 * a twelve-agent sidebar in dark and light, and direction J's reference
 * drawing beside ours.
 *
 * A strip is the motion sampled, not a guess at it: every animation on the
 * page is paused and each frame's set to its own time (`data-frame-ms`),
 * through the Web Animations API, so frame 3 is exactly t = 3/8 of the loop.
 *
 *   pnpm harness &                     # its own port and TMPDIR if others run
 *   node scripts/avatar-strips.mjs --out harness/shots
 *
 * Writes keycap-*.png. Dependency-free: the DevTools protocol over Node's
 * WebSocket and fetch, as harness-capture.mjs does.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchChrome } from './headless-chrome.mjs';

const PORT = Number(process.env.SHIPSTUDIO_HARNESS_PORT ?? 1425);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const outAt = process.argv.indexOf('--out');
const OUT = path.resolve(outAt > 0 ? process.argv[outAt + 1] : 'harness/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  #ws;
  #id = 0;
  #pending = new Map();
  errors = [];
  static async attach(url) {
    const p = new Page();
    p.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      p.#ws.addEventListener('open', res, { once: true });
      p.#ws.addEventListener('error', rej, { once: true });
    });
    p.#ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && p.#pending.has(m.id)) {
        const { res, rej } = p.#pending.get(m.id);
        p.#pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        p.errors.push(m.params.exceptionDetails.exception?.description ?? 'exception');
      }
    });
    await p.send('Runtime.enable');
    return p;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  }
  async waitFor(expression, what, ms = 20000) {
    const end = Date.now() + ms;
    while (!(await this.eval(`!!(${expression})`).catch(() => false))) {
      if (Date.now() > end) {
        const body = await this.eval(`document.body.innerText.slice(0, 400)`).catch(() => '');
        throw new Error(`timed out waiting for ${what}: ${this.errors.join(' | ')} ${body}`);
      }
      await sleep(150);
    }
  }
  /** A PNG of the box `selector` draws, padded. */
  async shot(selector, file, pad = 12) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
      scale: 1,
    };
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: true,
    });
    await writeFile(path.join(OUT, file), Buffer.from(data, 'base64'));
    console.log(`  ${file}`);
  }
  close() {
    this.#ws.close();
  }
}

let cdp = 0;
async function open(url, { width = 1440, height = 900 } = {}) {
  const res = await fetch(`http://127.0.0.1:${cdp}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const page = await Page.attach((await res.json()).webSocketDebuggerUrl);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.send('Page.reload', {});
  await sleep(400);
  return page;
}

/** Pause every animation and put each frame at its own time. */
const SAMPLE = `(() => {
  for (const a of document.getAnimations()) a.pause();
  for (const f of document.querySelectorAll('[data-frame-ms]')) {
    const t = Number(f.dataset.frameMs);
    for (const a of f.getAnimations({ subtree: true })) a.currentTime = t;
  }
  return document.querySelectorAll('[data-frame-ms]').length;
})()`;

/**
 * harness-avatars.html has no Tauri bridge: the agents store's event listener
 * fails there (it has no agents to hear about). Anything else is a finding.
 */
const standalone = (errors) => errors.filter((e) => !e.includes('transformCallback'));

const MOODS = ['idle', 'working', 'needs', 'done', 'failed'];

async function main() {
  await mkdir(OUT, { recursive: true });
  const chrome = await launchChrome({
    tool: 'avatar-strips',
    basePort: Number(process.env.HARNESS_CDP_PORT ?? 9420),
    maxMs: 5 * 60 * 1000,
  });
  cdp = chrome.port;
  const errors = [];
  try {
    for (const theme of ['dark', 'light']) {
      for (const px of ['48', '96']) {
        const p = await open(
          `${ORIGIN}/harness-avatars.html?section=states&freeze=off&theme=${theme}&px=${px}`,
          { width: 1440, height: 1800 }
        );
        await p.waitFor(`document.querySelectorAll('[data-frame-ms]').length >= 40`, 'strips');
        // Let the one-off moods start, then hold everything where the frame says.
        await sleep(300);
        await p.eval(SAMPLE);
        await sleep(200);
        if (theme === 'dark') {
          for (const mood of MOODS) {
            await p.shot(`[data-mood-strip="${mood}"]`, `keycap-${mood}-${px}.png`);
          }
        } else {
          await p.shot('[data-section="states"]', `keycap-states-${px}-light.png`);
        }
        errors.push(...standalone(p.errors));
        p.close();
      }
      const sheet = await open(`${ORIGIN}/harness-avatars.html?section=all&theme=${theme}`, {
        width: 1440,
        height: 2400,
      });
      await sheet.waitFor(`document.querySelector('[data-section="colors"]')`, 'sheet');
      await sleep(500);
      await sheet.shot('[data-section="sheet"]', `keycap-sheet-${theme}.png`);
      await sheet.shot('[data-section="sizes"]', `keycap-sizes-${theme}.png`);
      await sheet.shot('[data-section="colors"]', `keycap-colors-${theme}.png`);
      errors.push(...standalone(sheet.errors));
      sheet.close();

      const app = await open(
        `${ORIGIN}/harness.html?chrome=off&theme=${theme}&scenario=agents-avatars`
      );
      // The app's first load compiles the whole frontend: give it time.
      await app.waitFor('window.__harnessReady', 'the harness', 120000);
      await app.eval(`document.querySelector('.mode-toggle [data-tab-value="agents"]')?.click()`);
      await app.waitFor(
        `document.querySelector('.agents-list__row .agent-avatar[data-shape="hexagon"]')`,
        'the sidebar'
      );
      await sleep(3000);
      await app.eval(`(() => {
        const row = document.querySelector('.agents-list__row');
        let el = row;
        while (el && el.parentElement && el.getBoundingClientRect().height < 600) el = el.parentElement;
        el.setAttribute('data-avatar-shot', '');
      })()`);
      await app.shot('[data-avatar-shot]', `keycap-sidebar-${theme}.png`, 0);
      errors.push(...app.errors);
      app.close();
    }
    // Direction J as the designer drew it, for the side by side.
    const ref = await open(`${ORIGIN}/harness/avatar-directions/index.html?d=J`, {
      width: 1440,
      height: 2400,
    });
    await ref.waitFor(`document.querySelector('.sheet')`, 'the reference');
    await sleep(500);
    await ref.shot('.sheet', 'keycap-reference-J.png', 0);
    ref.close();
  } finally {
    chrome.close();
  }
  if (errors.length) {
    console.error('Page errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
