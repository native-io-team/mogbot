/**
 * The Mac's identity, pinned: a server that can't sign for the key the
 * pairing link named gets nothing, whatever it calls itself. Against the
 * mock Mac (honest, and one signing with another key), through the app's
 * real transport.
 */

import {
  pairProofMessage,
  welcomeProofMessage,
  type LinkState,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { createMockServer, mockIdentity } from '../dev/mock-server';
import { fingerprintOf, fromBase64Url, newChallenge, proves } from '../src/lib/identity';
import { checkWelcome } from '../src/lib/pin';
import { DirectTransport } from '../src/lib/transport';
import { until } from './helpers';

jest.setTimeout(20_000);

const random = (n: number) => new Uint8Array(randomBytes(n));

describe('identity proofs', () => {
  const mac = mockIdentity();
  const challenge = newChallenge(random);

  it('fingerprint the way the Mac does', () => {
    // identity.rs: fingerprint_of([0; 32]).
    expect(fingerprintOf(new Uint8Array(32))).toBe('Zmh6rfhivXdsj8GLjp-OIA');
    expect(fingerprintOf(fromBase64Url(mac.publicKey)!)).toBe(mac.fingerprint);
  });

  it('verify only for the pinned key and the exact message', () => {
    const proof = mac.prove(pairProofMessage(challenge, 'srv_1'));
    expect(proves(proof, pairProofMessage(challenge, 'srv_1'), mac.fingerprint)).toBe(true);
    expect(proves(proof, pairProofMessage(challenge, 'srv_2'), mac.fingerprint)).toBe(false);
    expect(proves(proof, pairProofMessage(newChallenge(random), 'srv_1'), mac.fingerprint)).toBe(
      false
    );
    // Someone else's key, however valid its signature.
    const other = mockIdentity();
    const forged = other.prove(pairProofMessage(challenge, 'srv_1'));
    expect(proves(forged, pairProofMessage(challenge, 'srv_1'), mac.fingerprint)).toBe(false);
    // A pairing answer isn't a welcome.
    expect(proves(proof, welcomeProofMessage(challenge, 'srv_1', 'dev'), mac.fingerprint)).toBe(
      false
    );
    expect(proves(undefined, 'x', mac.fingerprint)).toBe(false);
    expect(proves({ publicKey: 'junk!', signature: '' }, 'x', mac.fingerprint)).toBe(false);
  });

  it('pins on the first signed welcome of a pairing made before identity keys', () => {
    const w = (identity?: WelcomeFrame['identity'], deviceId = 'dev_1') =>
      ({ server: { id: 'srv_1' }, deviceId, identity }) as WelcomeFrame;
    const signed = mac.prove(welcomeProofMessage(challenge, 'srv_1', 'dev_1'));
    const unpinned = { serverId: 'srv_1', deviceId: 'dev_1' };
    expect(checkWelcome(unpinned, w(signed), challenge)).toEqual({
      verdict: 'ok',
      pin: mac.fingerprint,
    });
    expect(checkWelcome(unpinned, w(undefined), challenge)).toEqual({ verdict: 'unproven' });
    const pinned = { ...unpinned, fingerprint: mac.fingerprint };
    expect(checkWelcome(pinned, w(signed), challenge).verdict).toBe('ok');
    // Once pinned, nothing unsigned or signed by another key gets through.
    expect(checkWelcome(pinned, w(undefined), challenge).verdict).toBe('mismatch');
    const other = mockIdentity().prove(welcomeProofMessage(challenge, 'srv_1', 'dev_1'));
    expect(checkWelcome(pinned, w(other), challenge).verdict).toBe('mismatch');
    // A welcome for another device can't be replayed at this one.
    expect(checkWelcome(pinned, w(signed, 'dev_2'), challenge).verdict).toBe('mismatch');
  });
});

describe('against a server', () => {
  const open = (url: string, token: string, pinned: Parameters<typeof checkWelcome>[0]) =>
    new DirectTransport({
      routes: [{ kind: 'tailscale', url }],
      token,
      app: { version: '0.1.0', runtimeVersion: 'test' },
      getResume: () => undefined,
      foreground: true,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      challenge: () => newChallenge(random),
      checkWelcome: (w, c) => checkWelcome(pinned, w, c).verdict,
    });

  it('the paired Mac is verified', async () => {
    const mock = createMockServer({ quiet: true, allowAfterMs: 0 });
    const url = await mock.listen();
    const { token, deviceId } = mock.issueToken();
    const t = open(url, token, {
      fingerprint: mock.fingerprint,
      serverId: mock.serverId,
      deviceId,
    });
    await until(() => t.state.kind === 'connected');
    expect(t.identityVerified).toBe(true);
    t.close();
    await mock.close();
  });

  // The audit's attack: a server with the paired Mac's name and id, and its
  // own key. The phone stops at the welcome and sends it nothing.
  it('a server that says it is the Mac but signs with another key is refused for good', async () => {
    const real = createMockServer({ quiet: true, allowAfterMs: 0 });
    const impostor = createMockServer({
      quiet: true,
      allowAfterMs: 0,
      impostorKey: generateKeyPairSync('ed25519').privateKey,
    });
    const url = await impostor.listen();
    const { token, deviceId } = impostor.issueToken();
    const t = open(url, token, {
      fingerprint: real.fingerprint,
      serverId: real.serverId,
      deviceId,
    });
    const states: LinkState[] = [];
    t.onState((s) => states.push(s));
    await until(() => t.state.kind === 'refused');
    expect(t.state).toEqual({ kind: 'refused', reason: 'not_your_mac' });
    expect(t.refusal?.message).toMatch(/This isn’t your Mac/);
    expect(t.identityVerified).toBe(false);
    expect(states.some((s) => s.kind === 'connected')).toBe(false);
    await expect(t.request('agents.overview', {})).rejects.toThrow(/Not connected/);
    // And it doesn't keep trying on its own.
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.state.kind).toBe('refused');
    t.close();
    await impostor.close();
  });
});
