import type { MacRelay } from './mac';

/** What the Worker is given. */
export interface Env {
  /** One Durable Object per Mac, named by its key's fingerprint. */
  MAC: DurableObjectNamespace<MacRelay>;
  /** Cloudflare's rate limiting binding, per client address. Optional: absent means no limit. */
  RATE_LIMITER?: RateLimit;
}
