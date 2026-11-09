/**
 * Run the mock Mac:
 *
 *   pnpm mock                      # https://localhost:47443, self-signed
 *   pnpm mock --http --port 47450  # plain HTTP, e.g. behind `tailscale serve --https=47443`
 *   pnpm mock --public-url https://mac.tailnet.ts.net:47443
 *   pnpm mock --codex-only         # Claude Code not installed; every agent on Codex
 *   pnpm mock --takeover           # Designer driven in a terminal on the Mac
 *   pnpm mock --bars               # three bars in the Chief's chat: reaches "1 more"
 *   pnpm mock --team-setup         # 16 agents just imported: "Setting up your team" in the Chief's chat
 *   pnpm mock --importing          # the Chief mid-import, the Designer working: live bar + typing dots
 *   pnpm mock --heavy              # 17 agents, ~40 cards waiting, long chats
 *   pnpm mock --torture            # the chat torture set; /dev/torture?do=… drives events
 *   pnpm mock --live-work          # QA 2 running Cypress for 5 min (output, timer), Finance gone quiet
 *   pnpm mock --probe              # 50 agents, step-in, stale and orphaned cards, 3 accounts; /dev/probe?do=…
 *   pnpm mock --probe --restarted  # the same Mac after a restart cut Builder's turn off
 *   pnpm mock --impostor           # signs with a stranger's key: "This isn't your Mac"
 *   pnpm mock --http --cors        # for the web build (`pnpm qa:web` passes both)
 *
 * The identity key and paired phones live in dev/.certs (gitignored), so a
 * restart is the same Mac and a paired phone stays paired (`--state <dir>` to
 * keep them elsewhere).
 */

/* eslint-disable no-console -- a CLI prints to stdout */

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createMockServer } from './mock-server';

function selfSigned(dir: string) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', [
      // RSA: the iOS Simulator's keychain refuses an EC root.
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '825',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'extendedKeyUsage=serverAuth',
    ]);
  }
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

{
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const plain = args.includes('--http');
  // Paired phones and the identity key; `--state` keeps a run's apart (qa:web).
  const state = path.resolve(arg('--state') ?? path.join(__dirname, '.certs'));
  const tls = plain ? undefined : selfSigned(path.resolve(__dirname, '.certs'));
  const mock = createMockServer({
    port: Number(arg('--port') ?? (plain ? 47450 : 47443)),
    publicUrl: arg('--public-url'),
    devicesFile: path.join(state, 'devices.json'),
    ...(tls ? { tls: { key: tls.key, cert: tls.cert } } : {}),
    codexOnly: args.includes('--codex-only'),
    bothEngines: args.includes('--both-engines'),
    takeover: args.includes('--takeover'),
    bars: args.includes('--bars'),
    importing: args.includes('--importing'),
    teamSetup: args.includes('--team-setup'),
    cors: args.includes('--cors'),
    solo: args.includes('--solo'),
    heavy: args.includes('--heavy'),
    torture: args.includes('--torture'),
    liveWork: args.includes('--live-work'),
    probe: args.includes('--probe'),
    restarted: args.includes('--restarted'),
    ...(arg('--usage') === 'two-claude' || arg('--usage') === 'one-read'
      ? { usage: arg('--usage') as 'two-claude' | 'one-read' }
      : {}),
    identityFile: path.join(state, 'identity.pem'),
    // The same server id and paired phones, a different key: what a phone
    // sees when something else answers at its Mac's address.
    ...(args.includes('--impostor')
      ? { impostorKey: generateKeyPairSync('ed25519').privateKey }
      : {}),
  });
  // Stopped (Ctrl-C, or qa:web between phases): say goodbye as the real Mac's app does.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      mock.sayGoodbye();
      setTimeout(() => process.exit(0), 100);
    });
  }
  void mock.listen().then((url) => {
    const link = mock.pairingLink();
    console.log(`\nShip Studio mock Mac on ${url}\n`);
    if (tls) {
      console.log('Simulator, once per simulator (trust the self-signed certificate):');
      console.log(`  xcrun simctl keychain booted add-root-cert ${tls.certPath}\n`);
    }
    console.log('Pair the booted simulator:');
    console.log(`  xcrun simctl openurl booted '${link}'\n`);
    console.log(`Pairing link (one use; a fresh one: curl -sk ${url}/dev/link):\n  ${link}\n`);
  });
}
