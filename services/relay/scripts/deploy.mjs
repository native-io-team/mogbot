#!/usr/bin/env node
// Deploy the relay to Cloudflare and check it works (docs/relay-launch.md).
//
//   node scripts/deploy.mjs                              # accounts off (or as last time)
//   node scripts/deploy.mjs --publishable-key pk_live_…  # accounts on: the rest follows from the key
//   node scripts/deploy.mjs --brand                      # also write links.relay into brand.json
//   node scripts/deploy.mjs --dry-run                    # build and show what would go, deploy nothing
//   node scripts/deploy.mjs --domain relay.example.com   # serve on a custom domain (a Cloudflare zone
//                                                        # you own; what a Clerk production instance needs)
//
// Clerk values (all public) come from flags, else the environment, else what
// this script used last time (`.deploy.env`, not committed):
//   --publishable-key / CLERK_PUBLISHABLE_KEY    pk_live_… or pk_test_…
//   --jwks-url        / CLERK_JWKS_URL           default <frontend API>/.well-known/jwks.json
//   --issuer          / CLERK_ISSUER             default https://<frontend API>
//   --authorized-parties / CLERK_AUTHORIZED_PARTIES  default the relay's own origin
//   --accounts-off    clears all four (a relay for yourself)
//
// Always deploy through this script: a bare `wrangler deploy` uses the empty
// vars in wrangler.jsonc and turns accounts off.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoke } from './smoke.mjs';

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(relayDir, '../..');
const SAVED = join(relayDir, '.deploy.env');
const KEYS = ['CLERK_PUBLISHABLE_KEY', 'CLERK_JWKS_URL', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES'];
const FLAGS = {
  '--publishable-key': 'CLERK_PUBLISHABLE_KEY',
  '--jwks-url': 'CLERK_JWKS_URL',
  '--issuer': 'CLERK_ISSUER',
  '--authorized-parties': 'CLERK_AUTHORIZED_PARTIES',
};

function die(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dryRun: false, brand: false, smoke: true, accountsOff: false, domain: null, vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? a.split(/=(.*)/s) : [a, undefined];
    if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--brand') opts.brand = true;
    else if (flag === '--no-smoke') opts.smoke = false;
    else if (flag === '--accounts-off') opts.accountsOff = true;
    else if (flag === '--domain') {
      const v = (inline ?? argv[++i] ?? '').trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) die('--domain needs a bare host name, e.g. relay.example.com');
      opts.domain = v;
    }
    else if (FLAGS[flag]) {
      const v = inline ?? argv[++i];
      if (v === undefined) die(`${flag} needs a value`);
      opts.vars[FLAGS[flag]] = v.trim();
    } else if (flag === '--help' || flag === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n'));
      process.exit(0);
    } else die(`unknown option ${a}`);
  }
  return opts;
}

function readSaved() {
  if (!existsSync(SAVED)) return {};
  const out = {};
  for (const line of readFileSync(SAVED, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function save(values) {
  const lines = ['# Written by scripts/deploy.mjs: the public values the relay was last deployed with.'];
  for (const k of [...KEYS, 'RELAY_URL']) if (values[k] !== undefined) lines.push(`${k}=${values[k]}`);
  writeFileSync(SAVED, `${lines.join('\n')}\n`);
}

/** The frontend API host in a Clerk publishable key (as src/link.ts reads it), or null. */
export function frontendApiOf(key) {
  const m = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(key?.trim() ?? '');
  if (!m) return null;
  const decoded = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? host : null;
}

function wranglerBin() {
  for (const p of [
    join(relayDir, 'node_modules/.bin/wrangler'),
    join(homedir(), '.mogbot-tools/node_modules/.bin/wrangler'),
  ]) {
    if (existsSync(p)) return p;
  }
  die('wrangler isn’t installed. Run `pnpm install` in services/relay.');
}

function wrangler(args, { capture = true } = {}) {
  const r = spawnSync(wranglerBin(), args, {
    cwd: relayDir,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (capture) process.stdout.write(out);
  return { status: r.status ?? 1, out };
}

/** The four vars, resolved: flags, then env, then last time; then filled in from the key. */
function resolveVars(opts, relayOrigin) {
  if (opts.accountsOff) return Object.fromEntries(KEYS.map((k) => [k, '']));
  const saved = readSaved();
  const v = {};
  for (const k of KEYS) v[k] = opts.vars[k] ?? process.env[k]?.trim() ?? saved[k] ?? '';
  if (v.CLERK_PUBLISHABLE_KEY) {
    const host = frontendApiOf(v.CLERK_PUBLISHABLE_KEY);
    if (!host) die('That publishable key isn’t one (expected pk_live_… or pk_test_… from Clerk → API keys).');
    v.CLERK_JWKS_URL ||= `https://${host}/.well-known/jwks.json`;
    v.CLERK_ISSUER ||= `https://${host}`;
    if (!v.CLERK_AUTHORIZED_PARTIES && relayOrigin) v.CLERK_AUTHORIZED_PARTIES = relayOrigin;
  } else if (v.CLERK_JWKS_URL) {
    die('CLERK_JWKS_URL is set without CLERK_PUBLISHABLE_KEY: the /link page needs the key.');
  }
  return v;
}

function varFlags(v) {
  return KEYS.flatMap((k) => ['--var', `${k}:${v[k]}`]);
}

function showVars(v) {
  for (const k of KEYS) console.log(`  ${k.padEnd(25)} ${v[k] || '(empty)'}`);
  console.log(v.CLERK_JWKS_URL ? '  Accounts: on' : '  Accounts: off (every Mac’s phones may use it)');
}

function deploy(v, domain) {
  const r = wrangler(['deploy', ...(domain ? ['--domain', domain] : []), ...varFlags(v)]);
  if (r.status !== 0) die('wrangler deploy failed (see above).');
  if (domain) return `https://${domain}`;
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(r.out)?.[0];
  if (!url) die('Deployed, but wrangler didn’t print a workers.dev address. Check the dashboard (Workers → mogbot-relay → Settings → Domains).');
  return url.toLowerCase();
}

function writeBrand(relayUrl) {
  const path = join(repoRoot, 'brand.json');
  const text = readFileSync(path, 'utf8');
  const brand = JSON.parse(text);
  const wss = `wss://${new URL(relayUrl).host}`;
  if (brand.links?.relay === wss) {
    console.log(`brand.json already has links.relay = ${wss}`);
  } else {
    brand.links.relay = wss;
    writeFileSync(path, `${JSON.stringify(brand, null, 2)}\n`);
    console.log(`brand.json: links.relay = ${wss}`);
  }
  const r = spawnSync(process.execPath, ['scripts/check-brand.mjs', '--write'], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) die('scripts/check-brand.mjs --write failed (see above).');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const saved = readSaved();

  if (opts.dryRun) {
    const v = resolveVars(opts, opts.domain ? `https://${opts.domain}` : saved.RELAY_URL);
    console.log('Dry run: building, nothing deployed. Vars:');
    showVars(v);
    const out = mkdtempSync(join(tmpdir(), 'relay-dry-'));
    const r = wrangler(['deploy', '--dry-run', '--outdir', out, ...(opts.domain ? ['--domain', opts.domain] : []), ...varFlags(v)]);
    if (r.status !== 0) die('wrangler deploy --dry-run failed (see above).');
    console.log(`\nDry run OK. Bundle in ${out}`);
    return;
  }

  const who = wrangler(['whoami']);
  if (who.status !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
    die('Not signed in to Cloudflare. Run `pnpm exec wrangler login` in services/relay, then this again.');
  }

  let v = resolveVars(opts, opts.domain ? `https://${opts.domain}` : saved.RELAY_URL);
  console.log('\nDeploying with:');
  showVars(v);
  let url = deploy(v, opts.domain);
  console.log(`\nRelay: ${url}`);

  // First deploy with a key: the relay's own origin wasn't known yet. Now it is.
  if (v.CLERK_PUBLISHABLE_KEY && !v.CLERK_AUTHORIZED_PARTIES) {
    v = { ...v, CLERK_AUTHORIZED_PARTIES: new URL(url).origin };
    console.log(`\nSetting CLERK_AUTHORIZED_PARTIES to ${v.CLERK_AUTHORIZED_PARTIES} and deploying again.`);
    url = deploy(v, opts.domain);
  }
  save({ ...v, RELAY_URL: url });

  if (opts.smoke) {
    console.log('\nSmoke test:');
    // A new workers.dev name can take a few seconds to answer.
    let result = await smoke(url);
    for (let i = 0; !result.ok && i < 3; i++) {
      console.log('\nTrying again in 10 s…');
      await new Promise((r) => setTimeout(r, 10_000));
      result = await smoke(url);
    }
    if (!result.ok) die('The smoke test failed: the relay is deployed but not answering as it should.');
    if (!!v.CLERK_JWKS_URL !== !!result.accounts) die('The relay answered with accounts the other way from what was deployed.');
  }

  if (opts.brand) writeBrand(url);

  console.log(`\nDone. Relay: ${url}  (wss://${new URL(url).host})`);
  if (!opts.brand) console.log('Run again with --brand to put it in brand.json as links.relay.');
}

main().catch((e) => die(String(e?.stack ?? e)));
