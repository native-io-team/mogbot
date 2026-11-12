/**
 * Verifies a Clerk session token (an RS256 JWT) against Clerk's public keys.
 * No Clerk secret: only the JWKS, fetched and kept in memory.
 */
import { fromB64url } from './auth';

/** How long fetched keys are trusted before they're fetched again. */
export const JWKS_TTL_MS = 10 * 60_000;
/** An unknown `kid` refetches the keys (Clerk rotated them), at most this often. */
const REFETCH_MIN_MS = 30_000;
/** Clock skew allowed on `exp` and `nbf`, in seconds. */
export const CLOCK_SKEW_S = 60;

export type ClerkCheck = {
  jwksUrl: string;
  issuer?: string;
  /** Allowed `azp` origins; empty means not checked. */
  authorizedParties: string[];
};

export type Verified =
  | { ok: true; userId: string; email: string | null }
  | { ok: false; reason: 'token_invalid' | 'token_expired' | 'keys_unavailable' };

type Keys = { keys: Map<string, CryptoKey>; fetchedAt: number };
const cache = new Map<string, Keys>();

async function fetchKeys(url: string, now: number): Promise<Keys> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
    const k = jwk as JsonWebKey & { kid?: unknown; use?: unknown };
    if (k.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string') continue;
    if (k.alg !== undefined && k.alg !== 'RS256') continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
      keys.set(k.kid, key);
    } catch {
      // Not a usable key; the rest may be.
    }
  }
  const entry = { keys, fetchedAt: now };
  cache.set(url, entry);
  return entry;
}

async function keyFor(url: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  let entry = cache.get(url);
  if (!entry || now - entry.fetchedAt > JWKS_TTL_MS) entry = await fetchKeys(url, now);
  else if (!entry.keys.has(kid) && now - entry.fetchedAt > REFETCH_MIN_MS) {
    entry = await fetchKeys(url, now);
  }
  return entry.keys.get(kid);
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = fromB64url(part);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyClerkToken(
  token: unknown,
  check: ClerkCheck,
  nowMs = Date.now()
): Promise<Verified> {
  const invalid = { ok: false, reason: 'token_invalid' } as const;
  if (typeof token !== 'string' || token.length > 8192) return invalid;
  const parts = token.split('.');
  if (parts.length !== 3) return invalid;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  const signature = fromB64url(parts[2]);
  if (!header || !claims || !signature) return invalid;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return invalid;

  let key: CryptoKey | undefined;
  try {
    key = await keyFor(check.jwksUrl, header.kid, nowMs);
  } catch {
    return { ok: false, reason: 'keys_unavailable' };
  }
  if (!key) return invalid;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let good = false;
  try {
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  } catch {
    good = false;
  }
  if (!good) return invalid;

  const now = nowMs / 1000;
  if (typeof claims.exp !== 'number') return invalid;
  if (now > claims.exp + CLOCK_SKEW_S) return { ok: false, reason: 'token_expired' };
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || now + CLOCK_SKEW_S < claims.nbf) return invalid;
  }
  if (check.issuer && claims.iss !== check.issuer) return invalid;
  if (check.authorizedParties.length > 0) {
    if (typeof claims.azp !== 'string' || !check.authorizedParties.includes(claims.azp)) {
      return invalid;
    }
  }
  if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 256) {
    return invalid;
  }
  const email =
    typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null;
  return { ok: true, userId: claims.sub, email };
}
