/**
 * The Mac's relay login (docs/relay.md, "Mac ↔ relay"): it signs a fresh nonce
 * with the same Ed25519 identity key the phone pinned at pairing.
 */

/**
 * The pairing scheme, `PAIRING_SCHEME` in packages/companion-protocol/src/brand.gen.ts
 * (from brand.json). This package can't import that file at deploy time, so the
 * one copy lives here and a test checks it against the generated file.
 */
export const PAIRING_SCHEME = 'mogbot-companion';

/** A fingerprint is base64url (unpadded) of the first 16 bytes of SHA-256(raw public key). */
export const FINGERPRINT_RE = /^[A-Za-z0-9_-]{22}$/;

export function macLoginMessage(nonce: string, fingerprint: string): string {
  return `${PAIRING_SCHEME}:relay-mac:v1\n${nonce}\n${fingerprint}`;
}

export function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict unpadded base64url, or null. */
export function fromB64url(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function fingerprintOf(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  return toB64url(digest.subarray(0, 16));
}

/** True only when `publicKey` is the Mac named by `fingerprint` and it signed this nonce. */
export async function verifyMacLogin(
  fingerprint: string,
  nonce: string,
  publicKeyB64: unknown,
  signatureB64: unknown
): Promise<boolean> {
  const publicKey = fromB64url(publicKeyB64);
  const signature = fromB64url(signatureB64);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) return false;
  if ((await fingerprintOf(publicKey)) !== fingerprint) return false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      new TextEncoder().encode(macLoginMessage(nonce, fingerprint))
    );
  } catch {
    return false;
  }
}
