import type { MacRelay } from './mac';

/** What the Worker is given. */
export interface Env {
  /** One Durable Object per Mac, named by its key's fingerprint. */
  MAC: DurableObjectNamespace<MacRelay>;
  /** Cloudflare's rate limiting binding, per client address. Optional: absent means no limit. */
  RATE_LIMITER?: RateLimit;
  /**
   * Accounts (README, "Accounts"). All public values. Empty or absent
   * `CLERK_JWKS_URL` turns accounts off: no gating, every Mac's phones allowed.
   */
  /** Clerk's publishable key, for the `/link` page. */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Clerk's JWKS, e.g. `https://<frontend api>/.well-known/jwks.json`. */
  CLERK_JWKS_URL?: string;
  /** When set, a session token's `iss` must equal it. */
  CLERK_ISSUER?: string;
  /** When set (comma list of origins), a session token's `azp` must be one of them. */
  CLERK_AUTHORIZED_PARTIES?: string;
  /**
   * Clerk's secret key (a Worker secret, never a var): deleting an account
   * ("Delete my account" on the Mac) and noticing one deleted elsewhere.
   * Absent: deleting answers `unavailable`.
   */
  CLERK_SECRET_KEY?: string;
  /** Clerk's Backend API. Tests point it elsewhere. */
  CLERK_API_URL?: string;
}

export function accountsOn(env: Env): boolean {
  return !!env.CLERK_JWKS_URL?.trim();
}
