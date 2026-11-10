#!/usr/bin/env node
/**
 * Check an updater bundle's signature the way the app's updater will, before
 * it is published: a release whose .sig doesn't match the public key baked
 * into the app (tauri.conf.json plugins.updater.pubkey) is refused by every
 * installed copy, silently, until the next release.
 *
 *   node scripts/verify-updater-sig.mjs <bundle.app.tar.gz> <bundle.sig> [--version 1.0.1]
 *
 * The .sig is minisign (what `tauri signer sign` writes, base64 of the text):
 *   untrusted comment: …
 *   base64(alg[2] keyid[8] signature[64])     alg "ED": signs BLAKE2b-512(file)
 *   trusted comment: timestamp:…\tfile:…\tversion:…
 *   base64(global signature[64])              signs signature ‖ trusted comment
 *
 * With --version, the trusted comment must carry exactly that version
 * (`requireSignedVersion` in the app refuses one that doesn't).
 * Exit 0 when valid, 1 with the reason otherwise.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg) {
  console.error(`updater signature: ${msg}`);
  process.exit(1);
}

/** Lines of a base64-wrapped minisign text file. */
function minisignLines(b64) {
  const text = Buffer.from(b64.trim(), 'base64').toString('utf8');
  return text.split('\n').map((l) => l.replace(/\r$/, ''));
}

export function parsePublicKey(b64) {
  const lines = minisignLines(b64);
  if (!lines[0]?.startsWith('untrusted comment:')) throw new Error('public key: no comment line');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('public key: not an Ed25519 minisign key');
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

export function parseSignature(b64) {
  const lines = minisignLines(b64);
  if (!lines[0]?.startsWith('untrusted comment:')) throw new Error('signature: no comment line');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 74) throw new Error('signature: wrong length');
  const alg = raw.subarray(0, 2).toString();
  if (alg !== 'ED' && alg !== 'Ed') throw new Error(`signature: unknown algorithm ${alg}`);
  const prefix = 'trusted comment: ';
  if (!lines[2]?.startsWith(prefix)) throw new Error('signature: no trusted comment');
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (globalSig.length !== 64) throw new Error('signature: no global signature');
  return {
    prehashed: alg === 'ED',
    keyId: raw.subarray(2, 10),
    sig: raw.subarray(10),
    trusted: lines[2].slice(prefix.length),
    globalSig,
  };
}

function edKey(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

/** Throws with the reason when `data` isn't validly signed; returns the trusted fields. */
export function verifyUpdaterSignature(data, sigB64, pubkeyB64, expectedVersion) {
  const pub = parsePublicKey(pubkeyB64);
  const sig = parseSignature(sigB64);
  if (!pub.keyId.equals(sig.keyId)) {
    throw new Error('signed with a different key than the one in tauri.conf.json');
  }
  const key = edKey(pub.key);
  const message = sig.prehashed ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, sig.sig))
    throw new Error('the bundle does not match its signature');
  const global = Buffer.concat([sig.sig, Buffer.from(sig.trusted, 'utf8')]);
  if (!verify(null, global, key, sig.globalSig)) throw new Error('the trusted comment was altered');
  const fields = Object.fromEntries(
    sig.trusted.split('\t').map((kv) => {
      const at = kv.indexOf(':');
      return at < 0 ? [kv, ''] : [kv.slice(0, at), kv.slice(at + 1)];
    })
  );
  if (expectedVersion !== undefined && fields.version !== expectedVersion) {
    throw new Error(
      `signed for version ${fields.version ?? '(none)'}, not ${expectedVersion} (sign with --app-version)`
    );
  }
  return fields;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const vi = args.indexOf('--version');
  const version = vi >= 0 ? args[vi + 1] : undefined;
  const [bundle, sigPath] = vi >= 0 ? args.filter((_, i) => i !== vi && i !== vi + 1) : args;
  if (!bundle || !sigPath)
    die('usage: verify-updater-sig.mjs <bundle> <bundle.sig> [--version x.y.z]');
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!pubkey) die('tauri.conf.json has no plugins.updater.pubkey');
  try {
    const fields = verifyUpdaterSignature(
      readFileSync(bundle),
      readFileSync(sigPath, 'utf8'),
      pubkey,
      version
    );
    console.log(`ok  signed by the app's update key, version ${fields.version ?? '(none)'}`);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}
