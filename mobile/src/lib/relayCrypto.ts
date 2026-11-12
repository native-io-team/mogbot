/**
 * The phone's half of the relay's end-to-end channel (docs/relay.md, "The
 * encrypted channel"). The relay passes bytes it can't read: the Mac signs
 * the key exchange with its pinned identity key, so nothing between the two
 * can pose as the Mac or read a frame.
 *
 * Pure: the random source is passed in, so the tests run it under Node and
 * the Mac's tests check the same vectors (`relayVectors.json`).
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PAIRING_SCHEME, toBase64Url } from '@shipstudio/companion-protocol';
import { fingerprintOf, fromBase64Url } from './identity';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** What the Mac signs, and what the keys are bound to. */
export const relayTranscript = (phoneE: string, macE: string, fingerprint: string) =>
  `${PAIRING_SCHEME}:relay:v1\n${phoneE}\n${macE}\n${fingerprint}`;

/** What the Mac signs to log in to the relay (the relay checks it, the phone never sees it). */
export const relayMacLogin = (nonce: string, fingerprint: string) =>
  `${PAIRING_SCHEME}:relay-mac:v1\n${nonce}\n${fingerprint}`;

export interface RelayKeys {
  phoneToMac: Uint8Array;
  macToPhone: Uint8Array;
}

export function deriveKeys(shared: Uint8Array, transcript: string): RelayKeys {
  const okm = hkdf(sha256, shared, sha256(enc.encode(transcript)), enc.encode(`${PAIRING_SCHEME} relay v1`), 64);
  return { phoneToMac: okm.slice(0, 32), macToPhone: okm.slice(32, 64) };
}

/** 4 zero bytes then the counter, big-endian. */
export function nonceFor(counter: number): Uint8Array {
  const n = new Uint8Array(12);
  let c = BigInt(counter);
  for (let i = 11; i >= 4; i--) {
    n[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return n;
}

/** One direction's sealing or opening, its counter kept. */
export class Cipher {
  private counter = 0;
  constructor(private readonly key: Uint8Array) {}
  seal(text: string): Uint8Array {
    if (this.counter >= Number.MAX_SAFE_INTEGER) throw new Error('relay counter exhausted');
    return chacha20poly1305(this.key, nonceFor(this.counter++)).encrypt(enc.encode(text));
  }
  /** The plaintext, or null when it doesn't open (the channel must close). */
  open(bytes: Uint8Array): string | null {
    if (this.counter >= Number.MAX_SAFE_INTEGER) return null;
    try {
      const plain = chacha20poly1305(this.key, nonceFor(this.counter)).decrypt(bytes);
      this.counter++;
      return dec.decode(plain);
    } catch {
      return null;
    }
  }
}

/** The phone's first message and the secret it keeps until the Mac answers. */
export function startHandshake(random: (n: number) => Uint8Array): {
  hello: Uint8Array;
  secret: Uint8Array;
  e: string;
} {
  const secret = random(32);
  const e = toBase64Url(x25519.getPublicKey(secret));
  return { hello: enc.encode(JSON.stringify({ v: 1, e })), secret, e };
}

export interface Channel {
  send: Cipher;
  receive: Cipher;
}

/**
 * The Mac's answer checked against the pinned fingerprint, and the channel's
 * ciphers; null for anything that isn't the pinned Mac (close, send nothing).
 */
export function finishHandshake(
  answer: Uint8Array,
  mine: { secret: Uint8Array; e: string },
  fingerprint: string
): Channel | null {
  let reply: { v?: unknown; e?: unknown; publicKey?: unknown; signature?: unknown };
  try {
    reply = JSON.parse(dec.decode(answer));
  } catch {
    return null;
  }
  if (!reply || reply.v !== 1) return null;
  if (typeof reply.e !== 'string' || typeof reply.publicKey !== 'string') return null;
  if (typeof reply.signature !== 'string') return null;
  const macE = fromBase64Url(reply.e);
  const key = fromBase64Url(reply.publicKey);
  const sig = fromBase64Url(reply.signature);
  if (!macE || macE.length !== 32 || !key || key.length !== 32 || !sig || sig.length !== 64) {
    return null;
  }
  if (fingerprintOf(key) !== fingerprint) return null;
  const transcript = relayTranscript(mine.e, reply.e, fingerprint);
  try {
    if (!ed25519.verify(sig, enc.encode(transcript), key)) return null;
    const shared = x25519.getSharedSecret(mine.secret, macE);
    const keys = deriveKeys(shared, transcript);
    return { send: new Cipher(keys.phoneToMac), receive: new Cipher(keys.macToPhone) };
  } catch {
    return null;
  }
}
