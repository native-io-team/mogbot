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
 *   - scripts/install.sh and scripts/install.ps1 — the brand block (name,
 *     releases link) they run on, since they're piped from a URL and can't
 *     read brand.json; with no releases link they refuse to install anything
 *
 * Checked only (edit by hand):
 *   - src-tauri/tauri.conf.json — productName, identifier, deep-link scheme,
 *     and updater config present exactly when brand.json names an update feed
 *     (the updater plugin is only registered when links.updates is set, and
 *     it fails app setup without its config); that config's one endpoint is
 *     links.updates, its key a minisign public key, requireSignedVersion on
 *   - src-tauri/Cargo.toml and package.json — package name = slug, and one
 *     version: tauri.conf.json reads package.json, Cargo.toml matches it
 *   - mobile/app.config.ts — reads ../brand.json rather than hardcoding, and
 *     takes a self-build's bundle id from the env var the desktop sets
 *   - companion.bundleId — never Ship Studio's, or the phones collide
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
if (typeof companion.bundleId !== 'string' || !companion.bundleId) {
  fail('brand.json: "companion.bundleId" must be a string');
} else if (companion.bundleId.startsWith('studio.ship.')) {
  // Self-builds are `<bundleId>.<hex>` / `<bundleId>.self`; under Ship
  // Studio's prefix they would replace its phone app.
  fail('brand.json: "companion.bundleId" must not be under Ship Studio\'s studio.ship.*');
}
if (!Number.isInteger(companion.tailnetPort) || companion.tailnetPort < 1) {
  fail('brand.json: "companion.tailnetPort" must be a port number');
}
// `previous`: the identity before the last rename, which the app's one-time
// migration (src-tauri/src/brand_migration.rs) carries state over from.
// Optional; every field a string or null, and never the current identity.
if (brand.previous !== undefined) {
  const prev = brand.previous;
  if (!prev || typeof prev !== 'object') fail('brand.json: "previous" must be an object');
  else {
    for (const [k, v] of Object.entries(prev)) {
      if (v !== null && typeof v !== 'string')
        fail(`brand.json: "previous.${k}" must be a string or null`);
    }
    if (prev.slug && prev.slug === brand.slug)
      fail('brand.json: "previous.slug" is the current slug');
    if (prev.appDirName && prev.appDirName === brand.appDirName)
      fail('brand.json: "previous.appDirName" is the current appDirName');
  }
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

// The phone relay (docs/relay.md): `wss://host`, the paths are added by each side.
if (brand.links?.relay != null && !/^wss:\/\/[^/?#@\s]+$/.test(brand.links.relay)) {
  fail('brand.json: "links.relay" must be wss://<host> with no path, or null');
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

/**
 * The pairing scheme before the last rename (\`previous.companionScheme\`), or
 * null. A code from a Mac still on the old build is recognised, so the phone
 * says to update that app instead of "that isn't a pairing code".
 */
export const PREVIOUS_PAIRING_SCHEME: string | null = ${JSON.stringify(brand.previous?.companionScheme ?? null)};

/** The HTTPS port \`tailscale serve\` publishes the Mac's companion server on. */
export const TAILNET_HTTPS_PORT = ${companion.tailnetPort};

/** The app's source repository, or null when it has none to link to. */
export const SOURCE_URL: string | null = ${JSON.stringify(brand.repository ?? null)};

/** Where someone with only the phone gets the Mac app, or null when nowhere public. */
export const MAC_DOWNLOAD_URL: string | null = ${JSON.stringify(brand.links?.macDownload ?? null)};
`;
if (write) writeFileSync(join(root, GEN_PATH), gen);
else if (read(GEN_PATH) !== gen)
  fail(`${GEN_PATH} is stale — run node scripts/check-brand.mjs --write`);

// --- checked: the install runbook's "is this the renamed app" step ----------
// A new user built a checkout from before the rename and saw the old name on
// the Mac while the phone app (the current one) couldn't read its pairing
// code. docs/INSTALL.md has the agent check the clone first; keep its
// expected values this brand's.
{
  const want = `Expected: \`${brand.name}\`, then \`${companion.bundleId}\``;
  if (!read('docs/INSTALL.md').includes(want))
    fail(`docs/INSTALL.md: the clone check must say ${want}`);
}

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

// --- generated: the install scripts' brand blocks ------------------------------
{
  const sh = (v) => JSON.stringify(v ?? ''); // "…" is a valid bash literal for these values
  const ps = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;
  const blocks = [
    [
      'scripts/install.sh',
      [`BRAND_NAME=${sh(brand.name)}`, `BRAND_RELEASES=${sh(brand.links?.releases)}`],
    ],
    [
      'scripts/install.ps1',
      [
        `$BrandName       = ${ps(brand.name)}`,
        `$BrandAppDirName = ${ps(brand.appDirName)}`,
        `$BrandReleases   = ${ps(brand.links?.releases)}`,
      ],
    ],
  ];
  const START =
    '# --- brand (generated from brand.json by `node scripts/check-brand.mjs --write`) ---';
  const END = '# --- end brand ---';
  for (const [rel, lines] of blocks) {
    const text = read(rel);
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    if (from < 0 || to < from) {
      fail(`${rel} has no brand block (${START} … ${END})`);
      continue;
    }
    const next = `${text.slice(0, from)}${START}\n${lines.join('\n')}\n${text.slice(to)}`;
    if (write) writeFileSync(join(root, rel), next);
    else if (next !== text) fail(`${rel} brand block differs from brand.json — run with --write`);
  }
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
  if (brand.links?.updates != null && !conf.plugins?.updater) {
    fail(
      'brand.json names an update feed (links.updates) but tauri.conf.json has no plugins.updater — the app would fail to start'
    );
  }
  const updater = conf.plugins?.updater;
  if (brand.links?.updates != null && updater) {
    // The app asks exactly the feed brand.json names, and nothing else.
    const endpoints = updater.endpoints ?? [];
    if (endpoints.length !== 1 || endpoints[0] !== brand.links.updates) {
      fail(
        `tauri.conf.json plugins.updater.endpoints ${JSON.stringify(endpoints)} ≠ ["${brand.links.updates}"] (links.updates)`
      );
    }
    if (!brand.links.updates.startsWith('https://')) {
      fail('brand.json: "links.updates" must be an https:// URL');
    }
    // A minisign public key, base64 of "untrusted comment: …\n<RW…>": the
    // updater refuses every update whose signature it can't check against it.
    let decoded = '';
    try {
      decoded = Buffer.from(String(updater.pubkey ?? ''), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    if (!/^untrusted comment: .*\nRW[A-Za-z0-9+/=]{54}\s*$/.test(decoded)) {
      fail(
        'tauri.conf.json plugins.updater.pubkey is not a minisign public key (pnpm tauri signer generate)'
      );
    }
    // Refuse a manifest that pairs a newer version number with an older
    // release's (genuinely signed) bundle: scripts/release-mac.sh signs with
    // --app-version, so every release carries the version it was signed for.
    if (updater.requireSignedVersion !== true) {
      fail('tauri.conf.json plugins.updater.requireSignedVersion must be true');
    }
    for (const k of Object.keys(updater)) {
      if (k.startsWith('dangerous')) fail(`tauri.conf.json plugins.updater.${k} must not be set`);
    }
  }
}

// --- checked: package names --------------------------------------------------
{
  const cargoName = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(
    read('src-tauri/Cargo.toml')
  )?.[1];
  if (cargoName !== brand.slug)
    fail(`src-tauri/Cargo.toml package name "${cargoName}" ≠ slug "${brand.slug}"`);
  const pkg = JSON.parse(read('package.json'));
  if (pkg.name !== brand.slug) fail(`package.json name "${pkg.name}" ≠ slug "${brand.slug}"`);

  // One version: package.json. tauri.conf.json reads it (and so Info.plist);
  // Cargo.toml's copy is what logs, MCP clients and error reports name.
  const confVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;
  if (confVersion !== '../package.json') {
    fail(`tauri.conf.json version must be "../package.json" (found "${confVersion}")`);
  }
  const cargoVersion = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(
    read('src-tauri/Cargo.toml')
  )?.[1];
  if (cargoVersion !== pkg.version) {
    fail(`src-tauri/Cargo.toml version "${cargoVersion}" ≠ package.json version "${pkg.version}"`);
  }
}

// --- checked: mobile reads brand.json ------------------------------------------
{
  const appConfig = read('mobile/app.config.ts');
  if (!appConfig.includes('../brand.json')) {
    fail('mobile/app.config.ts must take its name, scheme and bundle id from ../brand.json');
  }
  // The desktop hands the phone build its bundle id through this env var
  // (src/lib/companionInstall.ts); if the names drift, the phone builds as
  // the default id and the desktop never sees it installed.
  const ENV = 'COMPANION_BUNDLE_ID';
  if (!appConfig.includes(`process.env.${ENV}`)) {
    fail(`mobile/app.config.ts must read process.env.${ENV}`);
  }
  const installer = read('src/lib/companionInstall.ts');
  const used = new Set(installer.match(/\b[A-Z][A-Z_]*_BUNDLE_ID\b/g) ?? []);
  if (!used.has(ENV) || used.size !== 1) {
    fail(
      `src/lib/companionInstall.ts must pass the bundle id as ${ENV} (found ${[...used].join(', ') || 'none'})`
    );
  }
}

// --- checked: the Chrome extension (user_chrome) ----------------------------
// It can't read brand.json: its name and the native host it asks Chrome for
// are copies. The host name is the identifier, lowercased, + ".chrome_link"
// (src-tauri/src/user_chrome/install.rs, host_name()).
{
  const manifest = JSON.parse(read('chrome-extension/extension/manifest.json'));
  if (manifest.name !== `${brand.name} for Chrome`) {
    fail(`chrome-extension manifest name must be "${brand.name} for Chrome"`);
  }
  if (manifest.short_name !== brand.name || manifest.action?.default_title !== brand.name) {
    fail(`chrome-extension manifest short_name and action.default_title must be "${brand.name}"`);
  }
  const host = `${brand.identifier.toLowerCase().replace(/[^a-z0-9.]/g, '_')}.chrome_link`;
  const protocolJs = read('chrome-extension/extension/src/protocol.js');
  if (!protocolJs.includes(`export const HOST_NAME = '${host}';`)) {
    fail(`chrome-extension/extension/src/protocol.js HOST_NAME must be '${host}'`);
  }
  const storeId = brand.chromeExtension?.webStoreId ?? null;
  if (storeId !== null && !/^[a-p]{32}$/.test(storeId)) {
    fail('brand.json: "chromeExtension.webStoreId" must be a 32-letter extension id or null');
  }
}

if (problems.length) {
  console.error(`Brand drift (${problems.length}):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  write ? 'Brand copies rewritten from brand.json.' : 'Brand identity matches brand.json.'
);
