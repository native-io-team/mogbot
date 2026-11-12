#!/usr/bin/env node
// Smoke test for a running relay (docs/relay-launch.md): health, a Mac login
// with a throwaway Ed25519 key, a phone to an offline Mac (4404), and, with
// that Mac logged in, a phone either let through (accounts off) or turned
// away 4402 (accounts on). Nothing it does lasts: the key is made here and
// thrown away, so its Durable Object is never used again.
//
//   node scripts/smoke.mjs https://mogbot-relay.<you>.workers.dev
//   node scripts/smoke.mjs http://127.0.0.1:8787        # wrangler dev
//
// Node 22+ (global WebSocket and WebCrypto Ed25519).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 10_000;

/** The pairing scheme the relay signs with, from the repo's brand.json. */
function pairingScheme() {
  const brand = JSON.parse(readFileSync(join(here, '../../../brand.json'), 'utf8'));
  return brand.companion.scheme;
}

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `https://host` (or http/ws/wss) → the web and socket bases. */
export function bases(url) {
  const u = new URL(url);
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) throw new Error(`not a relay URL: ${url}`);
  return { web: `${secure ? 'https' : 'http'}://${u.host}`, ws: `${secure ? 'wss' : 'ws'}://${u.host}` };
}

async function newMacKey() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return { fingerprint: b64url(digest.subarray(0, 16)), publicKey: b64url(raw), key: pair.privateKey };
}

/** A socket whose messages and close can be awaited in order. */
function socket(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const queue = [];
  const waiters = [];
  let closed = null;
  const closeWaiters = [];
  ws.addEventListener('message', (e) => {
    const w = waiters.shift();
    if (w) w(e.data);
    else queue.push(e.data);
  });
  ws.addEventListener('close', (e) => {
    closed = { code: e.code, reason: e.reason };
    closeWaiters.splice(0).forEach((w) => w(closed));
  });
  ws.addEventListener('error', () => {});
  const timed = (p, what) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), TIMEOUT_MS)),
    ]);
  return {
    ws,
    next: () => timed(queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)), 'a message'),
    closed: () => timed(closed ? Promise.resolve(closed) : new Promise((r) => closeWaiters.push(r)), 'the close'),
    opened: () =>
      timed(
        new Promise((resolve, reject) => {
          if (ws.readyState === 1) return resolve();
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('close', (e) => reject(new Error(`closed ${e.code} before opening`)), { once: true });
        }),
        'the socket to open'
      ),
  };
}

export async function smoke(url, { log = console.log } = {}) {
  const { web, ws } = bases(url);
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. Health.
  try {
    const res = await fetch(`${web}/health`);
    const text = await res.text();
    check('GET /health', res.status === 200 && text === 'ok', `${res.status} ${JSON.stringify(text)}`);
  } catch (e) {
    check('GET /health', false, String(e));
  }

  // 2. A phone to a Mac that has never been online: 4404 mac_offline.
  const offline = await newMacKey();
  try {
    const phone = socket(`${ws}/v1/phone/${offline.fingerprint}`);
    const c = await phone.closed();
    check('phone to an offline Mac closes 4404', c.code === 4404, `${c.code} ${c.reason}`);
  } catch (e) {
    check('phone to an offline Mac closes 4404', false, String(e));
  }

  // 3. A Mac login with a throwaway key.
  const mac = await newMacKey();
  let macWs = null;
  let accounts = null;
  try {
    macWs = socket(`${ws}/v1/mac/${mac.fingerprint}`);
    const challenge = JSON.parse(await macWs.next());
    if (challenge.t !== 'challenge' || typeof challenge.nonce !== 'string') throw new Error(`no challenge: ${JSON.stringify(challenge)}`);
    const message = `${pairingScheme()}:relay-mac:v1\n${challenge.nonce}\n${mac.fingerprint}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, mac.key, new TextEncoder().encode(message)));
    macWs.ws.send(JSON.stringify({ t: 'auth', v: 1, publicKey: mac.publicKey, signature: b64url(sig) }));
    const ready = JSON.parse(await macWs.next());
    check('Mac login (signed challenge) answers ready', ready.t === 'ready', JSON.stringify(ready));
  } catch (e) {
    check('Mac login (signed challenge) answers ready', false, String(e));
    macWs = null;
  }

  // 4. A phone to that Mac: through with accounts off, 4402 with them on (it isn't linked).
  if (macWs) {
    try {
      const phone = socket(`${ws}/v1/phone/${mac.fingerprint}`);
      const first = await Promise.race([
        macWs.next().then((m) => ({ macSaid: JSON.parse(m) })),
        phone.closed().then((c) => ({ closed: c })),
      ]);
      if (first.macSaid?.t === 'open') {
        accounts = false;
        check('phone to the logged-in Mac opens a channel (accounts off)', true, `ch ${first.macSaid.ch}`);
        phone.ws.close(1000);
      } else if (first.closed?.code === 4402) {
        accounts = true;
        check('phone to an unlinked Mac closes 4402 sign_in_needed (accounts on)', true);
      } else {
        check('phone to the logged-in Mac', false, JSON.stringify(first));
      }
    } catch (e) {
      check('phone to the logged-in Mac', false, String(e));
    }
    macWs.ws.close(1000);
  }

  // 5. With accounts on, the /link page loads Clerk.
  if (accounts) {
    const code = `${mac.fingerprint}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    try {
      const res = await fetch(`${web}/link?code=${code}`);
      const html = await res.text();
      check('GET /link loads Clerk', res.status === 200 && html.includes('clerk.browser.js'));
    } catch (e) {
      check('GET /link loads Clerk', false, String(e));
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
  return { ok: failed === 0, accounts };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node scripts/smoke.mjs <relay url>');
    process.exit(2);
  }
  smoke(url).then(
    (r) => process.exit(r.ok ? 0 : 1),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
}
