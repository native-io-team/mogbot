#!/usr/bin/env node
/**
 * brand.json is the only place the app's name and identity live. A few files
 * cannot import it and carry a copy instead; this checks every copy matches.
 *
 *   node scripts/check-brand.mjs          # fail (exit 1) on any drift
 *   node scripts/check-brand.mjs --write  # rewrite the copies that are generated
 *
 * Generated (rewritten by --write):
 *   - packages/companion-protocol/src/brand.gen.ts — the pairing scheme and
 *     tailnet port the Mac and the phone must agree on
 *   - index.html — <title> and the log folder named in the boot-failure copy
 *
 * Checked only (edit by hand):
 *   - src-tauri/tauri.conf.json — productName, identifier, deep-link scheme,
 *     and no updater config unless brand.json names an update feed
 *   - src-tauri/Cargo.toml and package.json — package name = slug
 *   - mobile/app.config.ts — reads ../brand.json rather than hardcoding
 *
 * The Rust side needs no check: src-tauri/build.rs reads brand.json itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const write = process.argv.includes('--write');

const brand = JSON.parse(read('brand.json'));
const problems = [];
const fail = (msg) => problems.push(msg);

for (const key of ['name', 'slug', 'identifier', 'urlScheme', 'appDirName']) {
  if (typeof brand[key] !== 'string' || !brand[key]) fail(`brand.json: "${key}" must be a string`);
}
if (!/^[a-z][a-z0-9-]*$/.test(brand.slug ?? '')) {
  fail('brand.json: "slug" must be lowercase letters, digits and dashes');
}
const companion = brand.companion ?? {};
if (typeof companion.scheme !== 'string' || !companion.scheme) {
  fail('brand.json: "companion.scheme" must be a string');
}
if (!Number.isInteger(companion.tailnetPort) || companion.tailnetPort < 1) {
  fail('brand.json: "companion.tailnetPort" must be a port number');
}
for (const [group, value] of Object.entries({ links: brand.links, telemetry: brand.telemetry })) {
  if (!value || typeof value !== 'object') {
    fail(`brand.json: "${group}" must be an object`);
    continue;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v !== 'string')
      fail(`brand.json: "${group}.${k}" must be a string or null`);
  }
}

// --- generated: companion-protocol --------------------------------------------
const GEN_PATH = 'packages/companion-protocol/src/brand.gen.ts';
const gen = `// Generated from brand.json by scripts/check-brand.mjs --write. Do not edit.
//
// The phone can't read the repo's brand.json at run time, and the Mac reads
// it at build time (src-tauri/build.rs), so both sides take these from one
// file and \`pnpm check:brand\` fails if this copy drifts.

/** The app's display name, for copy that genuinely needs it. */
export const APP_NAME = ${JSON.stringify(brand.name)};

/** The pairing link's custom URL scheme (\`<scheme>://pair?d=…\`). */
export const PAIRING_SCHEME = ${JSON.stringify(companion.scheme)};

/** The HTTPS port \`tailscale serve\` publishes the Mac's companion server on. */
export const TAILNET_HTTPS_PORT = ${companion.tailnetPort};

/** The app's source repository, or null when it has none to link to. */
export const SOURCE_URL: string | null = ${JSON.stringify(brand.repository ?? null)};
`;
if (write) writeFileSync(join(root, GEN_PATH), gen);
else if (read(GEN_PATH) !== gen)
  fail(`${GEN_PATH} is stale — run node scripts/check-brand.mjs --write`);

// --- generated: index.html ---------------------------------------------------
{
  const html = read('index.html');
  const next = html
    .replace(/<title>[^<]*<\/title>/, `<title>${brand.name}</title>`)
    .replace(/~\/Library\/Logs\/[^)\s/<]+/g, `~/Library/Logs/${brand.appDirName}`);
  if (write) writeFileSync(join(root, 'index.html'), next);
  else if (next !== html)
    fail('index.html title or log folder differs from brand.json — run with --write');
}

// --- checked: tauri.conf.json ------------------------------------------------
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  if (conf.productName !== brand.name) {
    fail(`tauri.conf.json productName "${conf.productName}" ≠ brand name "${brand.name}"`);
  }
  if (conf.identifier !== brand.identifier) {
    fail(
      `tauri.conf.json identifier "${conf.identifier}" ≠ brand identifier "${brand.identifier}"`
    );
  }
  const schemes = conf.plugins?.['deep-link']?.desktop?.schemes ?? [];
  if (schemes.length !== 1 || schemes[0] !== brand.urlScheme) {
    fail(`tauri.conf.json deep-link schemes ${JSON.stringify(schemes)} ≠ ["${brand.urlScheme}"]`);
  }
  if (brand.links?.updates == null && conf.plugins?.updater) {
    fail('tauri.conf.json has plugins.updater but brand.json names no update feed (links.updates)');
  }
}

// --- checked: package names --------------------------------------------------
{
  const cargoName = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(
    read('src-tauri/Cargo.toml')
  )?.[1];
  if (cargoName !== brand.slug)
    fail(`src-tauri/Cargo.toml package name "${cargoName}" ≠ slug "${brand.slug}"`);
  const pkgName = JSON.parse(read('package.json')).name;
  if (pkgName !== brand.slug) fail(`package.json name "${pkgName}" ≠ slug "${brand.slug}"`);
}

// --- checked: mobile reads brand.json ------------------------------------------
if (!read('mobile/app.config.ts').includes('../brand.json')) {
  fail('mobile/app.config.ts must take its name, scheme and bundle id from ../brand.json');
}

if (problems.length) {
  console.error(`Brand drift (${problems.length}):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  write ? 'Brand copies rewritten from brand.json.' : 'Brand identity matches brand.json.'
);
