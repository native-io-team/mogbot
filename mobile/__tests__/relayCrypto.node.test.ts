/**
 * The relay's end-to-end channel: the phone's half against a Mac built from
 * the spec (docs/relay.md), and the fixed vectors the Mac's Rust tests check
 * byte for byte (`UPDATE_VECTORS=1` rewrites them).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { toBase64Url } from '@shipstudio/companion-protocol';
import { fingerprintOf } from '../src/lib/identity';
import {
  Cipher,
  deriveKeys,
  finishHandshake,
  relayMacLogin,
  relayTranscript,
  startHandshake,
} from '../src/lib/relayCrypto';

const VECTORS = join(__dirname, '../../packages/companion-protocol/src/relayVectors.json');
const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const enc = new TextEncoder();

/** A Mac from the spec: answers the phone's hello, returns its own ciphers. */
function macAnswer(hello: Uint8Array, macSeed: Uint8Array, macX: Uint8Array) {
  const { e: phoneE } = JSON.parse(new TextDecoder().decode(hello)) as { e: string };
  const publicKey = ed25519.getPublicKey(macSeed);
  const fingerprint = fingerprintOf(publicKey);
  const macE = toBase64Url(x25519.getPublicKey(macX));
  const transcript = relayTranscript(phoneE, macE, fingerprint);
  const signature = ed25519.sign(enc.encode(transcript), macSeed);
  const answer = enc.encode(
    JSON.stringify({
      v: 1,
      e: macE,
      publicKey: toBase64Url(publicKey),
      signature: toBase64Url(signature),
    })
  );
  const phonePub = Uint8Array.from(
    atob(phoneE.replace(/-/g, '+').replace(/_/g, '/') + '='),
    (c) => c.charCodeAt(0)
  );
  const keys = deriveKeys(x25519.getSharedSecret(macX, phonePub), transcript);
  return {
    answer,
    fingerprint,
    transcript,
    keys,
    mac: { send: new Cipher(keys.macToPhone), receive: new Cipher(keys.phoneToMac) },
  };
}

describe('the relay channel', () => {
  it('opens with the pinned Mac and carries frames both ways', () => {
    const mine = startHandshake(() => bytes(1));
    const mac = macAnswer(mine.hello, bytes(2), bytes(3));
    const channel = finishHandshake(mac.answer, mine, mac.fingerprint);
    expect(channel).not.toBeNull();
    const up = channel!.send.seal('{"t":"challenge"}');
    expect(mac.mac.receive.open(up)).toBe('{"t":"challenge"}');
    const down = mac.mac.send.seal('{"t":"identity"}');
    expect(channel!.receive.open(down)).toBe('{"t":"identity"}');
  });

  it('refuses another key, a bad signature and a replayed frame', () => {
    const mine = startHandshake(() => bytes(1));
    const mac = macAnswer(mine.hello, bytes(2), bytes(3));
    const other = fingerprintOf(ed25519.getPublicKey(bytes(9)));
    expect(finishHandshake(mac.answer, mine, other)).toBeNull();
    const tampered = JSON.parse(new TextDecoder().decode(mac.answer));
    tampered.e = toBase64Url(x25519.getPublicKey(bytes(4)));
    expect(finishHandshake(enc.encode(JSON.stringify(tampered)), mine, mac.fingerprint)).toBeNull();
    const channel = finishHandshake(mac.answer, mine, mac.fingerprint)!;
    const frame = mac.mac.send.seal('one');
    expect(channel.receive.open(frame)).toBe('one');
    expect(channel.receive.open(frame)).toBeNull();
  });

  it('matches the vectors the Mac checks', () => {
    const mine = startHandshake(() => bytes(1));
    const mac = macAnswer(mine.hello, bytes(2), bytes(3));
    const phone = finishHandshake(mac.answer, mine, mac.fingerprint)!;
    const nonce = toBase64Url(bytes(5));
    const vectors = {
      note: 'docs/relay.md. Secrets are 32 bytes filled with the number given. Checked by mobile/__tests__/relayCrypto.node.test.ts and src-tauri companion::relay tests.',
      phoneSecretFill: 1,
      macIdentitySeedFill: 2,
      macSecretFill: 3,
      fingerprint: mac.fingerprint,
      phoneHello: new TextDecoder().decode(mine.hello),
      macAnswer: new TextDecoder().decode(mac.answer),
      transcript: mac.transcript,
      phoneToMacKey: toBase64Url(mac.keys.phoneToMac),
      macToPhoneKey: toBase64Url(mac.keys.macToPhone),
      phoneFrames: [
        { plain: '{"t":"challenge","challenge":"x"}', sealed: toBase64Url(phone.send.seal('{"t":"challenge","challenge":"x"}')) },
        { plain: 'second', sealed: toBase64Url(phone.send.seal('second')) },
      ],
      macFrames: [{ plain: '{"t":"identity"}', sealed: toBase64Url(mac.mac.send.seal('{"t":"identity"}')) }],
      macLogin: {
        nonce,
        message: relayMacLogin(nonce, mac.fingerprint),
        signature: toBase64Url(ed25519.sign(enc.encode(relayMacLogin(nonce, mac.fingerprint)), bytes(2))),
        publicKey: toBase64Url(ed25519.getPublicKey(bytes(2))),
      },
    };
    if (process.env.UPDATE_VECTORS === '1' || !existsSync(VECTORS)) {
      writeFileSync(VECTORS, JSON.stringify(vectors, null, 2) + '\n');
    }
    expect(JSON.parse(readFileSync(VECTORS, 'utf8'))).toEqual(vectors);
  });
});
