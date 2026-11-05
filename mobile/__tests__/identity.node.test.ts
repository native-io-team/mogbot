/**
 * The Mac's identity, pinned: before the phone sends a pairing code or its
 * token, the Mac proves who it is, for the host the phone reached. A server
 * that can't, whatever it calls itself and however it got its answers, gets
 * nothing. Against the mock Mac (honest, with another key, and behind a
 * relay on another host), through the app's real transport and pairing flow.
 */

import {
  formatPairingLink,
  macProofMessage,
  pairProofMessage,
  parsePairingLink,
  type ClientFrame,
  type LinkState,
} from '@shipstudio/companion-protocol';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createMockServer, mockIdentity } from '../dev/mock-server';
import {
  checkMac,
  checkPairAnswer,
  fingerprintOf,
  fromBase64Url,
  newChallenge,
  proves,
} from '../src/lib/identity';
import { pairWith, PairError } from '../src/lib/pairFlow';
import { DirectTransport } from '../src/lib/transport';
import { provenBy, random, until } from './helpers';

jest.setTimeout(20_000);

describe('identity proofs', () => {
  const mac = mockIdentity();
  const challenge = newChallenge(random);
  const hosts = ['julians-mbp.tail1.ts.net'];
  const pinned = { fingerprint: mac.fingerprint, serverId: 'srv_1' };
  const answer = (over: Partial<{ serverId: string; hosts: string[]; key: typeof mac }> = {}) => {
    const serverId = over.serverId ?? 'srv_1';
    const h = over.hosts ?? hosts;
    return {
      serverId,
      hosts: h,
      identity: (over.key ?? mac).prove(macProofMessage(challenge, serverId, h)),
    };
  };
  const reached = 'https://julians-mbp.tail1.ts.net:47443';

  it('fingerprint the way the Mac does', () => {
    // identity.rs: fingerprint_of([0; 32]).
    expect(fingerprintOf(new Uint8Array(32))).toBe('Zmh6rfhivXdsj8GLjp-OIA');
    expect(fingerprintOf(fromBase64Url(mac.publicKey)!)).toBe(mac.fingerprint);
  });

  it('verify only for the pinned key and the exact message', () => {
    const message = macProofMessage(challenge, 'srv_1', hosts);
    const proof = mac.prove(message);
    expect(proves(proof, message, mac.fingerprint)).toBe(true);
    expect(proves(proof, macProofMessage(challenge, 'srv_2', hosts), mac.fingerprint)).toBe(false);
    expect(
      proves(proof, macProofMessage(newChallenge(random), 'srv_1', hosts), mac.fingerprint)
    ).toBe(false);
    // Someone else's key, however valid its signature.
    const forged = mockIdentity().prove(message);
    expect(proves(forged, message, mac.fingerprint)).toBe(false);
    // The socket's proof isn't a pairing answer.
    expect(proves(proof, pairProofMessage(challenge, 'srv_1', hosts, ''), mac.fingerprint)).toBe(
      false
    );
    expect(proves(undefined, 'x', mac.fingerprint)).toBe(false);
    expect(proves({ publicKey: 'junk!', signature: '' }, 'x', mac.fingerprint)).toBe(false);
  });

  it('hold the Mac to its key, its id and the host the phone reached', () => {
    expect(checkMac(answer(), pinned, challenge, reached)).toBe('ok');
    // Host names are compared without case or port.
    expect(checkMac(answer(), pinned, challenge, 'https://JULIANS-MBP.tail1.ts.net')).toBe('ok');
    // Another key, with the paired Mac's id: an impostor.
    expect(checkMac(answer({ key: mockIdentity() }), pinned, challenge, reached)).toBe(
      'not_your_mac'
    );
    // The real Mac's proof, reached somewhere it doesn't serve: a relay.
    expect(checkMac(answer(), pinned, challenge, 'https://attacker.tail9.ts.net:47443')).toBe(
      'not_your_mac'
    );
    // A relay can't add its own host: the signature covers the list.
    const relayed = answer();
    expect(
      checkMac(
        { ...relayed, hosts: [...hosts, 'attacker.tail9.ts.net'] },
        pinned,
        challenge,
        'https://attacker.tail9.ts.net'
      )
    ).toBe('not_your_mac');
    // A different Mac id: the Mac started over (or it isn't the Mac): pair again.
    expect(checkMac(answer({ serverId: 'srv_new' }), pinned, challenge, reached)).toBe('mac_reset');
    // Nothing, or a stale challenge.
    expect(checkMac(undefined, pinned, challenge, reached)).toBe('not_your_mac');
    expect(checkMac(answer(), pinned, newChallenge(random), reached)).toBe('not_your_mac');
  });

  it('check a pairing answer for the device it made and the host it came from', () => {
    const signed = (deviceId: string) => ({
      serverId: 'srv_1',
      deviceId,
      hosts,
      identity: mac.prove(pairProofMessage(challenge, 'srv_1', hosts, deviceId)),
    });
    expect(checkPairAnswer(signed('dev_1'), pinned, challenge, reached)).toBe(true);
    expect(
      checkPairAnswer({ ...signed('dev_1'), deviceId: 'dev_2' }, pinned, challenge, reached)
    ).toBe(false);
    expect(
      checkPairAnswer(signed('dev_1'), pinned, challenge, 'https://attacker.tail9.ts.net')
    ).toBe(false);
  });
});

/**
 * A server on another host that passes everything to the Mac and back:
 * HTTP and the socket. `seen` records what the phone sent through it.
 */
function relayTo(target: string) {
  const seen: { paths: string[]; frames: ClientFrame[] } = { paths: [], frames: [] };
  const server = http.createServer((req, res) => {
    seen.paths.push(req.url ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const out = http.request(
        target + (req.url ?? ''),
        { method: req.method, headers: { 'content-type': 'application/json' } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, { 'content-type': 'application/json' });
          up.pipe(res);
        }
      );
      out.end(Buffer.concat(chunks));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (phone) => {
    const mac = new WebSocket(target.replace(/^http/, 'ws') + '/v1/ws');
    const queue: string[] = [];
    phone.on('message', (raw) => {
      const text = (raw as Buffer).toString();
      seen.frames.push(JSON.parse(text) as ClientFrame);
      if (mac.readyState === WebSocket.OPEN) mac.send(text);
      else queue.push(text);
    });
    mac.on('open', () => queue.splice(0).forEach((q) => mac.send(q)));
    mac.on('message', (raw) => phone.send((raw as Buffer).toString()));
    mac.on('close', () => phone.close());
    phone.on('close', () => mac.close());
  });
  return {
    seen,
    /** On 127.0.0.1: a different host from the Mac's `localhost`. */
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as { port: number };
          resolve(`http://127.0.0.1:${port}`);
        })
      ),
    close: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        server.close(() => resolve());
      }),
  };
}

describe('against a server', () => {
  const open = (url: string, token: string, mac: { fingerprint: string; serverId: string }) =>
    new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(mac),
    });

  it('the paired Mac proves itself, and only then gets the token', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    const url = await mock.listen();
    const { token } = mock.issueToken();
    const t = open(url, token, mock);
    await until(() => t.state.kind === 'connected');
    expect(t.identityVerified).toBe(true);
    t.close();
    await mock.close();
  });

  // The audit's attack: a server with the paired Mac's name and id, and its
  // own key. The phone stops at the proof, before the token.
  it('a server that says it is the Mac but signs with another key gets nothing', async () => {
    const real = createMockServer({ quiet: true, allowAfterMs: 0 });
    const impostor = createMockServer({
      quiet: true,
      allowAfterMs: 0,
      impostorKey: generateKeyPairSync('ed25519').privateKey,
    });
    const url = await impostor.listen();
    const { token } = impostor.issueToken();
    const relay = relayTo(url);
    const via = await relay.listen();
    // Through a recording relay on the impostor's own host name.
    const t = new DirectTransport({
      routes: [{ kind: 'tailscale', url: via }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      ...provenBy(real),
    });
    const states: LinkState[] = [];
    t.onState((s) => states.push(s));
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'not_your_mac' });
    expect(t.refusal?.message).toMatch(/couldn’t prove it’s the Mac you paired with/);
    expect(t.identityVerified).toBe(false);
    expect(states.some((s) => s.kind === 'connected')).toBe(false);
    // What it sent: one challenge. No hello, no token.
    expect(relay.seen.frames.map((f) => f.t)).toEqual(['challenge']);
    expect(JSON.stringify(relay.seen.frames)).not.toContain(token);
    await expect(t.request('agents.overview', {})).rejects.toThrow(/Not connected/);
    // And it doesn't keep trying on its own.
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.state.kind).toBe('refused');
    t.close();
    await relay.close();
    await impostor.close();
  });

  // The relay attack: every signature is the real Mac's, passed through a
  // server on another host. The Mac signs where it serves; the phone
  // reached somewhere else, and stops before its token goes.
  it('the real Mac behind a relay on another host gets no token', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    const url = await mock.listen();
    const { token } = mock.issueToken();
    const relay = relayTo(url);
    const via = await relay.listen();
    const t = open(via, token, mock);
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'not_your_mac' });
    expect(relay.seen.frames.map((f) => f.t)).toEqual(['challenge']);
    expect(JSON.stringify(relay.seen.frames)).not.toContain(token);
    t.close();
    await relay.close();
    await mock.close();
  });

  it('a Mac that started over with a new id is told apart, and still gets nothing', async () => {
    const reset = createMockServer({ quiet: true, allowAfterMs: 0, serverId: 'srv_new' });
    const url = await reset.listen();
    const { token } = reset.issueToken();
    const t = open(url, token, { fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA', serverId: 'srv_mock' });
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'mac_reset' });
    expect(t.refusal?.message).toMatch(/Pair again/);
    t.close();
    await reset.close();
  });

  it('a Mac from before protocol 2 is named, not retried forever', async () => {
    const old = createMockServer({ quiet: true, allowAfterMs: 0, protocolOne: true });
    const url = await old.listen();
    const t = open(url, old.issueToken().token, old);
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'update_mac' });
    expect(t.refusal?.message).toMatch(/Update it on the Mac/);
    t.close();
    await old.close();
  });
});

describe('pairing', () => {
  const deps = {
    fetch,
    random,
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

  it('pairs with the Mac the link names, keeping only the route that answered', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const paired = await pairWith(link, deps);
    expect(paired.fingerprint).toBe(mock.fingerprint);
    expect(paired.route).toEqual(link.routes[0]);
    await mock.close();
  });

  it('sends a relay neither the code nor anything else, and keeps no token', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    const url = await mock.listen();
    const relay = relayTo(url);
    const via = await relay.listen();
    const real = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    // The Mac's own link with the relay's address in it.
    const link = { ...real, routes: [{ kind: 'tailscale' as const, url: via }] };
    expect(await failure(pairWith(link, deps))).toBe('not_your_mac');
    expect(relay.seen.paths).toEqual(['/v1/identity']);
    // The code was never spent: the real Mac still takes it.
    expect((await pairWith(real, deps)).serverId).toBe(mock.serverId);
    await relay.close();
    await mock.close();
  });

  it('a link with another key is refused before the code goes', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const forged = { ...link, fingerprint: mockIdentity().fingerprint };
    expect(await failure(pairWith(forged, deps))).toBe('not_your_mac');
    expect((await pairWith(link, deps)).deviceId).toMatch(/^dev_/);
    await mock.close();
  });

  it('an old Mac is told apart: update it to pair', async () => {
    const old = createMockServer({ quiet: true, allowAfterMs: 0, protocolOne: true });
    await old.listen();
    const link = parsePairingLink(old.pairingLink(), { allowHost: () => true })!;
    const err = await pairWith(link, deps).catch((e: PairError) => e.failure);
    expect(err).toMatchObject({ kind: 'refused', reason: 'update_mac' });
    await old.close();
  });

  // The bug a real phone hit: "Allow on your Mac" before anything had
  // reached it. The desk is asking only once the code has gone.
  it('says it is asking the desk only after the Mac proved itself and the code went', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const order: string[] = [];
    await pairWith(link, {
      ...deps,
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        order.push(`fetch ${new URL(url).pathname}`);
        return fetch(input, init);
      },
      onStep: (step) => order.push(`step ${step}`),
    });
    expect(order).toEqual(['step reaching', 'fetch /v1/identity', 'fetch /v1/pair', 'step asking']);
    await mock.close();
  });

  it('never says the desk is asking when the Mac could not prove itself', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const steps: string[] = [];
    const forged = { ...link, fingerprint: mockIdentity().fingerprint };
    expect(await failure(pairWith(forged, { ...deps, onStep: (s) => steps.push(s) }))).toBe(
      'not_your_mac'
    );
    expect(steps).toEqual(['reaching']);
    await mock.close();
  });

  // An unreachable tailnet host doesn't fail fast: it hangs. It gets
  // seconds, then the reason, never a spinner forever.
  it('gives up on a Mac that never answers, and says why', async () => {
    const silent = http.createServer(() => {
      // Never answers.
    });
    const url = await new Promise<string>((resolve) =>
      silent.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(silent.address() as { port: number }).port}`)
      )
    );
    const mock = createMockServer({ quiet: true });
    const real = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const link = { ...real, routes: [{ kind: 'tailscale' as const, url }] };
    const diagnosed: string[] = [];
    const steps: string[] = [];
    const started = Date.now();
    const err = await pairWith(link, {
      ...deps,
      identityTimeoutMs: 300,
      onStep: (s) => steps.push(s),
      diagnose: (u) => {
        diagnosed.push(u);
        return Promise.resolve({ kind: 'tailscale_off' as const });
      },
    }).catch((e: PairError) => e.failure);
    expect(err).toEqual({ kind: 'tailscale_off' });
    expect(diagnosed).toEqual([url]);
    expect(steps).toEqual(['reaching']);
    expect(Date.now() - started).toBeLessThan(5000);
    // With no diagnosis to give: unreachable.
    const plain = await pairWith(link, {
      ...deps,
      identityTimeoutMs: 300,
      diagnose: undefined,
    }).catch((e: PairError) => e.failure);
    expect(plain).toEqual({ kind: 'mac_unreachable' });
    silent.closeAllConnections();
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it('stops waiting on the desk a little after its window, and says so', async () => {
    // A desk that never decides inside the phone's (shortened) window.
    const mock = createMockServer({ quiet: true, allowAfterMs: 800 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const steps: string[] = [];
    const err = await pairWith(link, {
      ...deps,
      pairTimeoutMs: 300,
      onStep: (s) => steps.push(s),
    }).catch((e: PairError) => e.failure);
    expect(err).toEqual({ kind: 'no_answer' });
    expect(steps).toEqual(['reaching', 'asking']);
    await mock.close();
  });

  it('a cancel is a cancel, not a failure to explain', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 800 });
    await mock.listen();
    const link = parsePairingLink(mock.pairingLink(), { allowHost: () => true })!;
    const controller = new AbortController();
    const going = pairWith(link, {
      ...deps,
      signal: controller.signal,
      onStep: (s) => s === 'asking' && setTimeout(() => controller.abort(), 50),
    });
    const err = await going.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PairError);
    await mock.close();
  });

  it('round-trips a link with exactly one route', () => {
    const mock = createMockServer({ quiet: true });
    const text = formatPairingLink({
      v: 1,
      code: 'C',
      serverId: 's',
      name: 'n',
      routes: [{ kind: 'tailscale', url: 'https://m.tail1.ts.net' }],
      fingerprint: mock.fingerprint,
    });
    expect(parsePairingLink(text)?.routes).toHaveLength(1);
  });
});
