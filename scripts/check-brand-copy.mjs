#!/usr/bin/env node
/**
 * The app's name lives only in brand.json (CLAUDE.md, "Brand and identity").
 * This fails on the old name — "Ship Studio" / "ShipStudio", any case — in
 * frontend code that users or agents read, and on brand artwork left behind.
 *
 *   1. Copy: every string, template and JSX text in src/**\/*.{ts,tsx}.
 *      Comments are ignored, and so are tests (`*.test.*`, src/test/), whose
 *      fixtures quote real backend messages and compat paths.
 *   2. Files: nothing under src/ or public/ may be named after it
 *      (ship_studio_full.png, ShipStudio_IconBrand.png, …).
 *
 * Not copy, so allowed (the shared compat names, CLAUDE.md "Shared compat"):
 * `.shipstudio/`, `.shipstudio-team/`, `~/ShipStudio` and other `/ShipStudio`
 * paths, the plugin ABI (`__SHIPSTUDIO_*`, `@shipstudio/…`,
 * `os-theme-shipstudio`), `shipstudio-*` skill/scheme names, `shipstudio.` /
 * `shipstudio:` / `ship-studio-` storage keys and events, identifiers such as
 * `ensure_shipstudio_dir`, and an `OTHER_APP_NAME` constant naming the other
 * app for side-by-side copy.
 *
 * Rewrite copy so it needs no name ("the app", "this Mac", "here"); where one
 * is unavoidable (macOS permission prompts, window titles) use `BRAND.name`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * TODO(brand): temporary. These files are being rewritten on branches that
 * have not merged yet (accent/colour, agents-first onboarding); editing them
 * here would only conflict. Remove each entry once its branch lands and the
 * file is clean — the check reports entries that no longer need to be here.
 */
const PENDING_ALLOWLIST = new Set([
  'public/ship_studio_full.png',
  'src/App.tsx',
  'src/commands/useAppCommands.tsx',
  'src/components/BootLoadingScreen.tsx',
  'src/components/UpdateBanner.tsx',
  'src/components/agents/AgentsStayOn.tsx',
  'src/components/code/CodeViewer.tsx',
  'src/components/dashboard/ProjectList.tsx',
  'src/components/dashboard/SettingsModal.tsx',
  'src/components/issue-reports/IssueReportModals.tsx',
  'src/components/preview/Preview.tsx',
  'src/components/setup/OnboardingScreen.tsx',
  'src/components/setup/agent-led/AgentOnboardingScreen.tsx',
  'src/components/setup/agent-led/DemoAgentTerminal.tsx',
  'src/components/setup/agent-led/GuidedSetupPhase.tsx',
  'src/components/setup/agent-led/SetupChecklist.tsx',
  'src/harness/main.tsx',
  'src/harness/scenarios/agents.ts',
  'src/harness/scenarios/agentsProject.ts',
  'src/harness/scenarios/base.ts',
  'src/harness/scenarios/phoneInstall.ts',
  'src/harness/scenarios/remote.ts',
  'src/harness/scenarios/team.ts',
  'src/lib/agentOnboarding.ts',
  'src/lib/companionInstall.ts',
  'src/lib/issueReports.ts',
  'src/lib/plugins.ts',
  'src/lib/setup.ts',
]);

const ALLOWED = [
  /OTHER_APP_NAME\s*=\s*(['"`])Ship ?Studio\1/g,
  /\.shipstudio(?:-team)?\b/gi,
  /\/ShipStudio\b/g,
  /__SHIPSTUDIO\w*/g,
  /@shipstudio\/[\w-]+/g,
  /os-theme-shipstudio/g,
  /\bshipstudio-[a-z][\w-]*/g,
  /\bshipstudio[.:]/g,
  /\bship-studio[-:]/g,
  // Identifiers: the name glued to other identifier characters.
  /[A-Za-z_]+ship_?studio\w*|\bship_?studio[A-Za-z_]+/gi,
];
const NAME = /ship[\s-]*studio/gi;
const FILE_NAME = /ship[-_ ]?studio/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => relative(root, p).split(sep).join('/');

/** Blank out comments, keeping offsets so line numbers survive. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    // A `//` comment, but not the `//` in a URL inside JSX text.
    if (c === '/' && n === '/' && src[i - 1] !== ':') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

const problems = [];
const stillPending = new Set();

for (const file of walk(join(root, 'src'))) {
  const path = rel(file);
  if (!/\.(ts|tsx)$/.test(path)) continue;
  if (/\.test\.tsx?$/.test(path) || path.startsWith('src/test/')) continue;
  let text = stripComments(readFileSync(file, 'utf8'));
  for (const re of ALLOWED) text = text.replace(re, (m) => ' '.repeat(m.length));
  for (const m of text.matchAll(NAME)) {
    if (PENDING_ALLOWLIST.has(path)) {
      stillPending.add(path);
      continue;
    }
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${path}:${line}: "${m[0].replace(/\s+/g, ' ')}"`);
  }
}

for (const dir of ['src', 'public']) {
  for (const file of walk(join(root, dir))) {
    const path = rel(file);
    const base = path.split('/').pop();
    if (!FILE_NAME.test(base)) continue;
    if (PENDING_ALLOWLIST.has(path)) {
      stillPending.add(path);
      continue;
    }
    problems.push(`${path}: brand artwork/file named after the old app`);
  }
}

const stale = [...PENDING_ALLOWLIST].filter((p) => !stillPending.has(p));
if (stale.length > 0) {
  console.log(
    '  (informational) clean now — remove from PENDING_ALLOWLIST in scripts/check-brand-copy.mjs:'
  );
  for (const p of stale) console.log(`    ${p}`);
}

if (problems.length > 0) {
  console.log(
    '  The old app name in user-facing copy or file names (rewrite without a name, or use BRAND.name):'
  );
  for (const p of problems) console.log(`    ${p}`);
  process.exit(1);
}
