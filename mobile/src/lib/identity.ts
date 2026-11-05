/**
 * The Mac's identity, as this phone pins it (docs/mobile.md, "Pairing").
 *
 * The pairing link names the Mac's identity key by fingerprint. The answer
 * to pairing, and every `welcome` after it, signs a challenge this phone
 * chose fresh. A server that can't sign for the pinned key isn't the Mac this
 * phone paired with, whatever its name, its host or its certificate, and
 * the phone stops talking to it ("This isn't your Mac").
 *
 * Pure: the random source is passed in, so the tests run it under Node.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url, type IdentityProof } from '@shipstudio/companion-protocol';

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

/** The fingerprint of a proof's key, if the proof is well formed and signs `message`. */
export function provenFingerprint(
  proof: IdentityProof | undefined,
  message: string
): string | null {
  const key = proof ? fromBase64Url(proof.publicKey) : null;
  if (!key || key.length !== 32) return null;
  const fingerprint = fingerprintOf(key);
  return proves(proof, message, fingerprint) ? fingerprint : null;
}

export const NOT_YOUR_MAC =
  'This isn’t your Mac. The server this phone reached couldn’t prove it’s the Mac you paired with, so nothing was sent to it. If you set up this Mac again, pair again from it.';
