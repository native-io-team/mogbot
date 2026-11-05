/**
 * A secure input card's value goes to the Mac over TLS on Tailscale and
 * nowhere else: not the cache, the outbox, drafts or the store, and never
 * over any other route. Against the mock Mac on HTTPS, through the app's
 * real transport and sync rules.
 */

import type { CompanionEvent, Cursor } from '@shipstudio/companion-protocol';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { provenBy, until } from './helpers';

// What would reach the disk: every write captured instead.
const written: string[] = [];
jest.mock('../src/lib/persist', () => ({
  readJson: () => Promise.resolve(null),
  writeJson: (_name: string, value: unknown) => {
    written.push(JSON.stringify(value));
    return Promise.resolve();
  },
  removeJson: () => Promise.resolve(),
  debounced: (run: () => Promise<void>) => ({
    schedule: () => void run(),
    flush: run,
    cancel: () => {},
  }),
}));

// jest.mock is hoisted above these, so they load with it in place.
import { toCache, toOutbox } from '../src/lib/cache';
import { flushDrafts } from '../src/lib/drafts';
import { secretRouteProblem, sendSecret } from '../src/lib/secrets';
import { getApp } from '../src/lib/store';
import { applyEvent, emptySync } from '../src/lib/sync';
import { DirectTransport } from '../src/lib/transport';

jest.setTimeout(20_000);

const VALUE = 'sk_live_51NeverWriteMeDown';

/**
 * The mock's certificate: `dev/.certs` (made by `pnpm mock`, and gitignored),
 * or on a clean checkout a throwaway one made here and removed afterwards.
 * Null when there's neither: no openssl to make one.
 */
function testCerts(): { key: Buffer; cert: Buffer; cleanup: () => void } | null {
  const saved = join(__dirname, '../dev/.certs');
  if (existsSync(join(saved, 'key.pem')) && existsSync(join(saved, 'cert.pem'))) {
    return {
      key: readFileSync(join(saved, 'key.pem')),
      cert: readFileSync(join(saved, 'cert.pem')),
      cleanup: () => {},
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'companion-test-certs-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );
    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
      cleanup,
    };
  } catch {
    cleanup();
    return null;
  }
}

const tls = testCerts();
if (!tls) {
  console.warn(
    'secrets.node.test: skipped. No dev/.certs and no openssl to make a temporary certificate. Run `pnpm mock` once to create dev/.certs.'
  );
}
afterAll(() => tls?.cleanup());

/** The mock's certificate is self-signed; the app trusts the real `*.ts.net` one. */
class SelfSignedOk extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { rejectUnauthorized: false });
  }
}

(tls ? describe : describe.skip)('secrets', () => {
  const mock = createMockServer({
    quiet: true,
    allowAfterMs: 0,
    tls: tls ? { key: tls.key, cert: tls.cert } : undefined,
  });
  let t: DirectTransport;
  let state = emptySync();
  const frames: string[] = [];

  beforeAll(async () => {
    const url = await mock.listen();
    expect(url).toMatch(/^https:/);
    const { token } = mock.issueToken();
    t = new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => state.cursor ?? undefined,
      foreground: true,
      WebSocketImpl: SelfSignedOk as unknown as typeof globalThis.WebSocket,
      ...provenBy(mock),
    });
    t.onEvent((e: CompanionEvent, c?: Cursor) => {
      frames.push(JSON.stringify(e));
      state = applyEvent(state, e, c);
    });
    await until(() => state.syncedAt != null);
  });

  afterAll(async () => {
    t.close();
    await mock.close();
  });

  it('only goes over HTTPS on Tailscale, to the Mac this phone pinned', () => {
    const ts = { kind: 'tailscale', url: 'https://mac.tail1.ts.net:47443' } as const;
    expect(secretRouteProblem(ts, true)).toBe(null);
    expect(
      secretRouteProblem({ kind: 'tailscale', url: 'http://mac.tail1.ts.net:47443' }, true)
    ).toMatch(/only go over Tailscale/);
    expect(secretRouteProblem({ kind: 'lan', url: 'https://192.168.1.20:47444' }, true)).toMatch(
      /only go over Tailscale/
    );
    expect(secretRouteProblem(null, true)).toMatch(/needs your Mac/);
    // A Tailscale route whose welcome wasn't signed by the pinned key.
    expect(secretRouteProblem(ts, false)).toMatch(/hasn’t proved it’s the Mac you paired with/);
    expect(t.identityVerified).toBe(true);
  });

  it('is refused before it leaves the phone on any other route', async () => {
    const request = jest.fn();
    const unproven = { state: t.state, route: t.route, identityVerified: false, request };
    await expect(sendSecret(unproven as never, 'fin', 'req_secret', [VALUE])).rejects.toThrow(
      /hasn’t proved/
    );
    const plain = {
      state: t.state,
      route: { kind: 'tailscale', url: 'http://x' },
      identityVerified: true,
      request,
    };
    await expect(sendSecret(plain as never, 'fin', 'req_secret', [VALUE])).rejects.toThrow(
      /only go over Tailscale/
    );
    const offline = {
      state: { kind: 'connecting', attempt: 1 },
      route: t.route,
      identityVerified: true,
      request,
    };
    await expect(sendSecret(offline as never, 'fin', 'req_secret', [VALUE])).rejects.toThrow(
      /needs your Mac/
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('reaches the Mac once and lands nowhere on the phone', async () => {
    const saved = await sendSecret(t, 'fin', 'req_secret', [VALUE]);
    expect(saved.name).toBe('Stripe key');
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    const card = () =>
      state.chats.fin?.messages.find((m) => m.approval?.requestId === 'req_secret') ??
      frames.find((f) => f.includes('req_secret'));
    await until(() =>
      frames.some((f) => f.includes('req_secret') && f.includes('"status":"allowed"'))
    );
    expect(card()).toBeTruthy();
    // The agent now lists it by name, and only by name.
    const fin = state.overview?.agents.find((a) => a.id === 'fin');
    expect(fin?.secrets?.map((s) => s.name)).toEqual(['Stripe key']);

    // Everything the app would keep: the cache, its outbox, drafts, the store.
    await flushDrafts();
    const kept = [
      JSON.stringify(toCache(state)),
      JSON.stringify(toOutbox(state)),
      JSON.stringify(state.pending),
      JSON.stringify(getApp()),
      ...written,
      ...frames,
    ];
    for (const k of kept) expect(k).not.toContain(VALUE);
    // A second save of the same card is the Mac's to refuse.
    await expect(sendSecret(t, 'fin', 'req_secret', [VALUE])).rejects.toThrow();
  });
});
