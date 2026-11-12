/**
 * The relay route (docs/relay.md) through the app's real transport and
 * pairing flow, against the mock Mac behind the mock relay: the channel
 * opens only for the pinned key, frames and HTTP go through it, the relay's
 * own answers (4404 offline, 4402 signed out) reach the link state, and the
 * routes fall back to Tailscale and back.
 */

import {
  readPairingLink,
  type CompanionEvent,
  type LinkState,
  type PairingLink,
} from '@shipstudio/companion-protocol';
import { generateKeyPairSync } from 'node:crypto';
import { WebSocket } from 'ws';
import { createMockServer } from '../dev/mock-server';
import { pairWith, PairError } from '../src/lib/pairFlow';
import { relayRequest } from '../src/lib/relayHttp';
import { DirectTransport, SECOND_TRY_MS, type LocalFiles } from '../src/lib/transport';
import { provenBy, random, until } from './helpers';

jest.setTimeout(20_000);

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
type Mock = ReturnType<typeof createMockServer>;

/** The phone's files, in memory. */
function memoryFiles(): LocalFiles & { kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>();
  const picked = new Map<string, Uint8Array>();
  return {
    kept,
    read: (uri) => Promise.resolve(picked.get(uri) ?? new Uint8Array(Buffer.from(uri))),
    cached: (key) => Promise.resolve(kept.has(key) ? `file:///cache/${key}` : null),
    write: (key, bytes) => {
      kept.set(key, bytes);
      return Promise.resolve(`file:///cache/${key}`);
    },
  };
}

function open(mock: Mock, routes: PairingLink['routes'], token: string, files?: LocalFiles) {
  const events: CompanionEvent[] = [];
  const states: LinkState[] = [];
  const t = new DirectTransport({
    routes,
    token,
    app: { version: '0.1.0', runtimeVersion: 'test' },
    getResume: () => undefined,
    foreground: true,
    WebSocketImpl: WS,
    random,
    files,
    ...provenBy(mock),
  });
  t.onEvent((e) => events.push(e));
  t.onState((s) => states.push(s));
  return { t, events, states };
}

const deps = {
  fetch,
  random,
  WebSocketImpl: WS,
  device: {
    name: 'Test Phone',
    platform: 'ios' as const,
    appVersion: '0.1.0',
    build: 'self' as const,
  },
  publicKey: 'pk',
  diagnose: () => Promise.resolve({ kind: 'mac_unreachable' as const }),
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof PairError ? e.failure.kind : String(e))
  );

/** The dev build's rule (`pairing.ts` `isDevHost`): the mock relay on this machine. */
const devRelay = (url: string) =>
  /^wss?:\/\/localhost:\d+\/v1\/phone\/[A-Za-z0-9_-]{22}$/.test(url) ||
  /^https?:\/\/localhost:\d+\/?$/.test(url);

describe('over the relay', () => {
  const mock = createMockServer({ quiet: true, allowAfterMs: 0, draftEveryMs: 15, relay: true });
  let tailscale = '';
  const relay = () => mock.relay!;
  const routes = () => [
    { kind: 'relay' as const, url: relay().url },
    { kind: 'tailscale' as const, url: tailscale },
  ];

  beforeAll(async () => {
    tailscale = await mock.listen();
  });
  afterAll(() => mock.close());
  afterEach(() => {
    relay().setMac('online');
    relay().setDown(false);
    mock.setDirect(true);
  });

  it('pairs from a link carrying the relay route: identity and pair as HTTP frames', async () => {
    const read = readPairingLink(mock.pairingLink(), { allowHost: devRelay, relayHost: null });
    expect(read.ok).toBe(true);
    const link = (read as { link: PairingLink }).link;
    expect(link.routes).toEqual([{ kind: 'relay', url: relay().url }]);
    // Tailscale is off: only the relay can carry it.
    mock.setDirect(false);
    const steps: string[] = [];
    const paired = await pairWith(link, { ...deps, onStep: (s) => void steps.push(s) });
    expect(paired.fingerprint).toBe(mock.fingerprint);
    expect(paired.route).toEqual(link.routes[0]);
    expect(paired.token).toBeTruthy();
    expect(steps).toEqual(['reaching', 'asking']);
  });

  it('connects through it and answers requests', async () => {
    const { token } = mock.issueToken();
    mock.setDirect(false);
    const { t, events } = open(mock, routes(), token);
    await until(() => t.state.kind === 'connected');
    expect(t.state).toMatchObject({ kind: 'connected', route: 'relay' });
    expect(t.identityVerified).toBe(true);
    await until(() => events.some((e) => e.type === 'sync.caughtUp'));
    const overview = await t.request('agents.overview', {});
    expect(overview.agents.length).toBeGreaterThan(0);
    t.close();
  });

  it('uploads and downloads files through it, in pieces, ending as a file URI', async () => {
    const { token } = mock.issueToken();
    const files = memoryFiles();
    const { t } = open(mock, routes(), token, files);
    await until(() => t.state.kind === 'connected');
    // Past one 128 KiB piece each way.
    const bytes = new Uint8Array(300 * 1024).map((_, i) => i % 251);
    files.read = () => Promise.resolve(bytes);
    const progress: number[] = [];
    const ref = await t.upload(
      { uri: 'file:///pick/big.bin', name: 'big file.bin', mime: 'application/octet-stream' },
      (f) => void progress.push(f)
    );
    expect(ref).toMatchObject({ name: 'big file.bin', size: bytes.length });
    expect(progress.at(-1)).toBe(1);
    const uri = await t.download({ blobId: ref.blobId });
    expect(uri).toBe(`file:///cache/blob/${ref.blobId}`);
    expect(Buffer.from(files.kept.get(`blob/${ref.blobId}`)!).equals(Buffer.from(bytes))).toBe(
      true
    );
    // A second ask is the cached copy: nothing more through the relay.
    const before = relay().opened;
    expect(await t.download({ blobId: ref.blobId })).toBe(uri);
    expect(relay().opened).toBe(before);
    // Without its token, the Mac says no, through the relay as on Tailscale.
    const res = await relayRequest(
      relay().url,
      { fingerprint: mock.fingerprint, random, WebSocketImpl: WS },
      { method: 'GET', path: `/v1/blobs/${ref.blobId}` }
    );
    expect(res.status).toBe(401);
    t.close();
  });

  it('the Mac away (4404): says it’s offline, and pairing says so too', async () => {
    const { token } = mock.issueToken();
    const { t } = open(mock, [{ kind: 'relay', url: relay().url }], token);
    await until(() => t.state.kind === 'connected');
    relay().setMac('offline');
    await until(() => t.state.kind === 'reconnecting');
    expect(t.state).toMatchObject({ kind: 'reconnecting', relaySaid: 'mac_offline' });
    // Back: connected again, and the relay's word forgotten.
    relay().setMac('online');
    await until(() => t.state.kind === 'connected', 10_000);
    expect(t.state).not.toHaveProperty('relaySaid');
    t.close();

    relay().setMac('offline');
    const link = readPairingLink(mock.pairingLink(), { allowHost: devRelay, relayHost: null });
    expect(await failure(pairWith((link as { link: PairingLink }).link, deps))).toBe('mac_offline');
  });

  it('the Mac signed out (4402): says to sign in on it, and pairing says so too', async () => {
    relay().setMac('sign_in_needed');
    const { token } = mock.issueToken();
    const { t, states } = open(mock, [{ kind: 'relay', url: relay().url }], token);
    await until(() => states.some((s) => 'relaySaid' in s && s.relaySaid === 'sign_in_needed'));
    expect(t.state).toMatchObject({ kind: 'connecting', relaySaid: 'sign_in_needed' });
    t.close();
    const link = readPairingLink(mock.pairingLink(), { allowHost: devRelay, relayHost: null });
    expect(await failure(pairWith((link as { link: PairingLink }).link, deps))).toBe(
      'sign_in_needed'
    );
  });

  it('falls back to Tailscale when the relay fails, and back to the relay when Tailscale does', async () => {
    relay().setDown(true);
    const { token } = mock.issueToken();
    const { t } = open(mock, routes(), token);
    await until(() => t.state.kind === 'connected', 10_000);
    expect(t.state).toMatchObject({ kind: 'connected', route: 'tailscale' });
    relay().setDown(false);
    mock.setDirect(false);
    await until(() => t.state.kind === 'connected' && t.state.route === 'relay', 15_000);
    t.close();
  });

  it('a slow first try over the relay gets a second one beside it', async () => {
    const { token } = mock.issueToken();
    relay().stallNext(1);
    const started = Date.now();
    const { t } = open(mock, [{ kind: 'relay', url: relay().url }], token);
    await until(() => t.state.kind === 'connected', 10_000);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(SECOND_TRY_MS);
    // Well inside the first try's 16 s budget: the spare got there.
    expect(took).toBeLessThan(SECOND_TRY_MS + 3000);
    expect(t.recentTrail().map((e) => e.what)).toContain('second try got through first');
    t.close();
  });
});

describe('a relay answered by another key', () => {
  it('is not your Mac: the channel never opens, nothing private goes', async () => {
    const impostor = createMockServer({
      quiet: true,
      allowAfterMs: 0,
      relay: true,
      impostorKey: generateKeyPairSync('ed25519').privateKey,
    });
    await impostor.listen();
    const { token } = impostor.issueToken();
    const { t } = open(impostor, [{ kind: 'relay', url: impostor.relay!.url }], token);
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'not_your_mac' });
    t.close();
    const link = readPairingLink(impostor.pairingLink(), { allowHost: devRelay, relayHost: null });
    expect(await failure(pairWith((link as { link: PairingLink }).link, deps))).toBe(
      'not_your_mac'
    );
    await impostor.close();
  });
});
