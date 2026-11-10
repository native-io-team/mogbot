#!/usr/bin/env node
/**
 * Run axe-core over every harness scenario, in light and dark, and fail when a
 * scenario has a violation that is not in the accepted baseline.
 *
 * Why the harness and not jsdom: half of what matters (contrast, focus order,
 * names computed from rendered text, what is actually hidden) needs a real
 * layout and real CSS. The harness boots the real frontend in Chrome against
 * fixtures, so every scenario is a page axe can read as a user's screen.
 *
 * Usage:
 *   pnpm harness                          # in another shell, first
 *   node scripts/harness-a11y.mjs         # every scenario, light + dark
 *   node scripts/harness-a11y.mjs agents- # filter by id prefix
 *   node scripts/harness-a11y.mjs --theme dark
 *   node scripts/harness-a11y.mjs --update-baseline
 *
 * Writes harness/a11y/report.json and report.md. Exits non-zero when a
 * (scenario, theme, rule) has more failing nodes than the baseline allows, so
 * a new violation fails CI while the known ones are worked down. Fixing one
 * makes `--update-baseline` shrink the file; it never grows by accident
 * because a growth needs that flag passed on purpose.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CHROME, launchChrome } from './headless-chrome.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const HARNESS_PORT = Number(process.env.SHIPSTUDIO_HARNESS_PORT ?? 1425);
const ORIGIN = `http://127.0.0.1:${HARNESS_PORT}`;
const BASE_CDP_PORT = Number(process.env.HARNESS_CDP_PORT ?? 9433);
const CONCURRENCY = Number(process.env.HARNESS_A11Y_TABS ?? 4);
const BASELINE = path.resolve('scripts/a11y-baseline.json');
const OUT = path.resolve('harness/a11y');

const args = process.argv.slice(2);
const themeIdx = args.indexOf('--theme');
const themes = themeIdx === -1 ? ['light', 'dark'] : [args[themeIdx + 1]];
const updateBaseline = args.includes('--update-baseline');
const filter =
  args.filter((a, i) => !a.startsWith('--') && (themeIdx === -1 || i !== themeIdx + 1))[0] ?? '';

/**
 * WCAG 2.1 A and AA, which is the bar the design system holds (docs/design-system.md,
 * "Accessibility"). Best-practice rules are reported but never fail the run.
 */
const FAILING_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'reduced-motion'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  #ws;
  #id = 0;
  #pending = new Map();
  static async attach(wsUrl) {
    const page = new Page();
    page.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      page.#ws.addEventListener('open', res, { once: true });
      page.#ws.addEventListener('error', rej, { once: true });
    });
    page.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id && page.#pending.get(msg.id);
      if (!p) return;
      page.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    return page;
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
  close() {
    this.#ws.close();
  }
}

let CDP_PORT = BASE_CDP_PORT;

async function open(url, viewport) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await res.json();
  const page = await Page.attach(target.webSocketDebuggerUrl);
  // Every page is read with Reduce Motion on: that is the setting the motion
  // check below holds, and a settled page is what contrast is measured on.
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  if (viewport) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await page.send('Page.reload', {});
  return { page, id: target.id };
}

const close = (id) => fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${id}`).catch(() => {});

async function waitReady(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.eval('!!window.__harnessReady').catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Loops still running under Reduce Motion, reported as a violation of our own
 * (`motion-reduced`, failing): base.css's floor stops them, except a spinner
 * and anything marked data-motion="essential".
 */
const MOTION_CHECK = `(() => {
  const nodes = document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)
    .map((a) => a.effect?.target)
    .filter((t) => t instanceof Element && !t.closest('.ss-spinner, [data-motion="essential"]'))
    .slice(0, 50)
    .map((t) => ({ target: t.tagName.toLowerCase() + '.' + String(t.className).trim().split(' ').join('.'), html: t.outerHTML.slice(0, 160), summary: 'Loops under prefers-reduced-motion' }));
  return JSON.stringify(nodes.length ? [{ id: 'motion-reduced', impact: 'serious', tags: ['reduced-motion'], help: 'Nothing loops when Reduce Motion is on', nodes, count: nodes.length }] : []);
})()`;

const RUN_AXE = `(async () => {
  const r = await axe.run(document, {
    iframes: false,
    resultTypes: ['violations'],
    runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice'] },
    rules: { 'region': { enabled: false } },
  });
  return JSON.stringify(r.violations.map(v => ({
    id: v.id, impact: v.impact, tags: v.tags, help: v.help,
    nodes: v.nodes.slice(0, 50).map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 160), summary: (n.failureSummary || '').slice(0, 300) })),
    count: v.nodes.length,
  })));
})()`;

async function scan(s, theme) {
  const url =
    `${ORIGIN}/harness.html?chrome=off&theme=${theme}&scenario=${s.id}` +
    (s.command ? `&command=${encodeURIComponent(s.command)}` : '');
  const { page, id } = await open(url, s.viewport);
  try {
    const ready = await waitReady(page, 25_000);
    // Let entrance transitions finish: a fading card measures as low contrast.
    await sleep(500);
    await page.eval(AXE_SOURCE + ';true');
    const violations = [
      ...JSON.parse(await page.eval(RUN_AXE)),
      ...JSON.parse(await page.eval(MOTION_CHECK)),
    ];
    return { id: s.id, theme, ready, violations };
  } catch (e) {
    return { id: s.id, theme, ready: false, error: e.message, violations: [] };
  } finally {
    page.close();
    await close(id);
  }
}

const failing = (v) => v.tags.some((t) => FAILING_TAGS.includes(t));
const key = (r, v) => `${r.id}|${r.theme}|${v.id}`;

async function main() {
  if (!CHROME) throw new Error('No Chrome/Chromium found.');
  const identity = await fetch(`${ORIGIN}/__harness/identity`)
    .then((r) => r.json())
    .catch(() => null);
  if (!identity)
    throw new Error(`The harness is not running on ${ORIGIN}. Start it with: pnpm harness`);
  if (path.resolve(identity.root) !== process.cwd()) {
    throw new Error(`The harness on ${ORIGIN} serves ${identity.root}, not this checkout.`);
  }

  const chrome = await launchChrome({
    tool: 'harness-a11y',
    basePort: BASE_CDP_PORT,
    args: [
      '--window-size=1440,900',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      'about:blank',
    ],
  });
  CDP_PORT = chrome.port;

  const probe = await open(`${ORIGIN}/harness.html?chrome=off`);
  const deadline = Date.now() + 20_000;
  while (!(await probe.page.eval('!!window.__harness').catch(() => false))) {
    if (Date.now() > deadline) throw new Error('harness module never loaded');
    await sleep(150);
  }
  const scenarios = JSON.parse(
    await probe.page.eval(
      'JSON.stringify(window.__harness.scenarios.map(s=>({id:s.id,command:s.command,viewport:s.viewport})))'
    )
  ).filter((s) => s.id.startsWith(filter));
  probe.page.close();
  await close(probe.id);

  const jobs = themes.flatMap((t) => scenarios.map((s) => [s, t]));
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const [s, t] = jobs[next++];
        const r = await scan(s, t);
        results.push(r);
        const n = r.violations.filter(failing).reduce((a, v) => a + v.count, 0);
        process.stdout.write(`${n ? '✗' : '✓'} ${t.padEnd(5)} ${s.id}${n ? ` (${n})` : ''}\n`);
      }
    })
  );
  // A page that never settled was read half-drawn: several tabs at once on a
  // busy machine starve each other. Read each of those again, alone, and
  // keep that reading.
  const unsettled = results.filter((r) => !r.ready);
  if (unsettled.length)
    console.log(`\nReading ${unsettled.length} unsettled pages again, one at a time…`);
  for (const old of unsettled) {
    const s = scenarios.find((x) => x.id === old.id);
    const r = await scan(s, old.theme);
    results[results.indexOf(old)] = r;
  }
  chrome.close();
  results.sort((a, b) => (a.id + a.theme).localeCompare(b.id + b.theme));

  const baseline = JSON.parse(await readFile(BASELINE, 'utf8').catch(() => '{}'));
  const counts = {};
  for (const r of results)
    for (const v of r.violations.filter(failing)) counts[key(r, v)] = v.count;
  const regressions = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0));

  const byRule = {};
  for (const r of results) {
    for (const v of r.violations) {
      byRule[v.id] ??= { help: v.help, failing: failing(v), nodes: 0, scenarios: 0 };
      byRule[v.id].nodes += v.count;
      byRule[v.id].scenarios += 1;
    }
  }
  const total = Object.values(byRule)
    .filter((r) => r.failing)
    .reduce((a, r) => a + r.nodes, 0);

  await mkdir(OUT, { recursive: true });
  await writeFile(
    path.join(OUT, 'report.json'),
    JSON.stringify({ head: identity.head, results }, null, 2)
  );
  const md = [
    '# Accessibility (axe-core) over the harness',
    '',
    `HEAD \`${identity.head}\`, ${results.length} pages (${themes.join(' + ')}), ${total} failing WCAG A/AA nodes.`,
    '',
    '| rule | WCAG | nodes | pages | what |',
    '| - | - | - | - | - |',
    ...Object.entries(byRule)
      .sort((a, b) => b[1].nodes - a[1].nodes)
      .map(
        ([id, r]) =>
          `| \`${id}\` | ${r.failing ? 'yes' : 'best practice'} | ${r.nodes} | ${r.scenarios} | ${r.help} |`
      ),
    '',
  ];
  if (regressions.length) {
    md.push('## Not in the baseline', '');
    for (const [k, n] of regressions) md.push(`- \`${k}\`: ${n} (baseline ${baseline[k] ?? 0})`);
  }
  await writeFile(path.join(OUT, 'report.md'), md.join('\n') + '\n');

  const unready = results.filter((r) => !r.ready);
  console.log(`\n${results.length} pages, ${total} failing nodes → harness/a11y/report.md`);
  if (unready.length)
    console.log(
      `${unready.length} never settled: ${unready
        .map((r) => r.id)
        .slice(0, 10)
        .join(', ')}`
    );

  if (updateBaseline) {
    // Only a full run may rewrite the file; a filtered one would drop the rest.
    const merged = filter || themes.length < 2 ? { ...baseline } : {};
    if (filter || themes.length < 2) {
      for (const k of Object.keys(merged)) {
        const [id, theme] = k.split('|');
        if (id.startsWith(filter) && themes.includes(theme)) delete merged[k];
      }
    }
    Object.assign(merged, counts);
    const sorted = Object.fromEntries(
      Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
    );
    await writeFile(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`Baseline written: ${Object.keys(sorted).length} entries.`);
    return;
  }
  if (regressions.length) {
    console.log(`\n${regressions.length} new violation(s):`);
    for (const [k, n] of regressions) console.log(`  ${k}: ${n} (baseline ${baseline[k] ?? 0})`);
    process.exitCode = 1;
  }
  // A page that never settled, even alone, was not read: not a pass.
  if (unready.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
