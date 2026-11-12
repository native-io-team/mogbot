/**
 * The Mac's identity, as this phone pins it (docs/mobile.md, "Pairing").
 *
 * The pairing link names the Mac's identity key by fingerprint. Before this
 * phone sends a pairing code, and on every connection before it sends its
 * token, the Mac signs a challenge this phone chose fresh, with its server
 * id and the host names it serves itself on. A server that can't sign for
 * the pinned key, or whose signed hosts don't include the host this phone
 * actually reached, isn't the Mac this phone paired with, whatever its name,
 * its host or its certificate, and the phone stops there with nothing
 * private sent ("This isn't your Mac").
 *
 * Pure: the random source is passed in, so the tests run it under Node.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  hostOf,
  macProofMessage,
  pairProofMessage,
  toBase64Url,
  type IdentityProof,
  type MacIdentity,
} from '@shipstudio/companion-protocol';

/** base64url (padded or not) to bytes, or null for anything else. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Standard base64 (as expo-file-system reads a file) to the URL-safe alphabet. */
export const standardToUrl = (b64: string) =>
  b64.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The first 16 bytes of SHA-256 over the raw key, base64url: `identity::fingerprint_of`. */
export function fingerprintOf(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey).slice(0, 16));
}

/** 32 random bytes, base64url: what the Mac is asked to sign. */
export function newChallenge(random: (n: number) => Uint8Array): string {
  return toBase64Url(random(32));
}

/**
 * Whether `proof` signs `message` by the key `fingerprint` names. Anything
 * missing or malformed is a no.
 */
export function proves(
  proof: IdentityProof | undefined,
  message: string,
  fingerprint: string
): boolean {
  if (!proof || typeof proof.publicKey !== 'string' || typeof proof.signature !== 'string') {
    return false;
  }
  const key = fromBase64Url(proof.publicKey);
  const sig = fromBase64Url(proof.signature);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  if (fingerprintOf(key) !== fingerprint) return false;
  try {
    return ed25519.verify(sig, new TextEncoder().encode(message), key);
  } catch {
    return false;
  }
}

/** What this phone expects of the Mac it pinned. */
export interface Pinned {
  fingerprint: string;
  serverId: string;
}

/**
 * - `ok`: the pinned key signed this challenge, for the pinned Mac, and the
 *   host this phone reached is one the Mac serves on.
 * - `mac_reset`: a server answering with another Mac id. Either the Mac
 *   started over with a new key (and removed its phones), or it's not the
 *   Mac at all: either way, pair again from the Mac itself.
 * - `not_your_mac`: anything else (another key, a relay on another host,
 *   nothing signed).
 */
export type MacVerdict = 'ok' | 'not_your_mac' | 'mac_reset';

export function checkMac(
  answer: Partial<MacIdentity> | null | undefined,
  pinned: Pinned,
  challenge: string,
  reachedUrl: string
): MacVerdict {
  const reached = hostOf(reachedUrl);
  if (!answer || !challenge || !reached || !Array.isArray(answer.hosts)) return 'not_your_mac';
  if (typeof answer.serverId !== 'string') return 'not_your_mac';
  if (answer.serverId !== pinned.serverId) return 'mac_reset';
  const hosts = answer.hosts.filter((h): h is string => typeof h === 'string');
  if (
    !proves(answer.identity, macProofMessage(challenge, answer.serverId, hosts), pinned.fingerprint)
  ) {
    return 'not_your_mac';
  }
  return hosts.some((h) => h.toLowerCase() === reached) ? 'ok' : 'not_your_mac';
}

/**
 * The pairing answer: signed by the pinned key over this challenge, this
 * Mac, the device it made, and hosts that include the one this phone reached.
 */
export function checkPairAnswer(
  answer: { serverId: string; deviceId: string; hosts?: string[]; identity?: IdentityProof },
  pinned: Pinned,
  challenge: string,
  reachedUrl: string
): boolean {
  const reached = hostOf(reachedUrl);
  if (!reached || answer.serverId !== pinned.serverId || !Array.isArray(answer.hosts)) {
    return false;
  }
  return (
    answer.hosts.some((h) => typeof h === 'string' && h.toLowerCase() === reached) &&
    proves(
      answer.identity,
      pairProofMessage(challenge, answer.serverId, answer.hosts, answer.deviceId),
      pinned.fingerprint
    )
  );
}

export const NOT_YOUR_MAC =
  'The server at this address couldn’t prove it’s the Mac you paired with, so this phone sent it nothing private: not its pairing, not your messages. If you set this Mac up again, pair again from it.';

export const MAC_RESET =
  'The Mac at this address has a different identity from the one this phone paired with, so this phone sent it nothing private. That happens when the app on your Mac lost its key and started over, which removes every paired phone. Pair again from your Mac.';

export const PAIR_AGAIN =
  'This pairing was made before the app checked your Mac’s identity, so it can’t be trusted any more. Pair again: on your Mac, click the phone line at the bottom of the sidebar, then “Pair your phone”.';

export const PAIRING_LOST =
  'This phone’s pairing couldn’t be read, so it was removed. Your agents and their chats are still on your Mac. Pair again: on your Mac, click the phone line at the bottom of the sidebar, then “Pair your phone”.';

export const UPDATE_MAC =
  'The app on your Mac is too old for this phone. Update it on the Mac, then try again.';
