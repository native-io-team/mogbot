/**
 * The relay's wire shapes, as both apps read them (docs/relay.md). The relay
 * passes bytes it can't read; everything here travels inside the end to end
 * channel except the close codes and the keep-alive.
 */

import * as brandGen from './brand.gen';

/**
 * The relay's own base URL from brand.json (`links.relay`), or null for a
 * build without one (a fork): then no relay route is ever accepted and the
 * phone uses Tailscale only. Read loosely, so a `brand.gen.ts` from before
 * the relay (no `RELAY_URL` export) means "no relay", not a build error.
 */
export const RELAY_URL: string | null = (() => {
  const v = (brandGen as unknown as Record<string, unknown>).RELAY_URL;
  return typeof v === 'string' && v ? v : null;
})();

/** The relay's host (lowercase, no port), or null with no relay. */
export const RELAY_HOST: string | null = (() => {
  if (!RELAY_URL) return null;
  try {
    return new URL(RELAY_URL).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
})();

/** The relay closes a phone's socket with this when that Mac isn't connected to it. */
export const RELAY_CLOSE_MAC_OFFLINE = 4404;
/**
 * The relay closes a phone's socket with this when that Mac is connected but
 * not signed in to an account (docs/relay.md, "Accounts": `sign_in_needed`).
 */
export const RELAY_CLOSE_SIGN_IN_NEEDED = 4402;
/** Past the relay's 8 phone sockets per Mac. */
export const RELAY_CLOSE_TOO_MANY = 4429;

/** An HTTP body over the channel is cut into pieces this size (before base64url). */
export const RELAY_HTTP_CHUNK = 128 * 1024;

/** The phone's keep-alive to the relay: text `ping` (the relay answers `pong`). */
export const RELAY_PING_MS = 25_000;

/** The phone's path on the relay for the Mac with this fingerprint. */
export const relayPhonePath = (fingerprint: string) => `/v1/phone/${fingerprint}`;

/** `wss://<relay host>/v1/phone/<fingerprint>`, or null with no relay. */
export function relayPhoneUrl(fingerprint: string, base: string | null = RELAY_URL): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    return `wss://${u.host}${relayPhonePath(fingerprint)}`;
  } catch {
    return null;
  }
}

/**
 * A relay route's URL as only the Mac makes it: `wss://<relay host>[:port]`
 * then exactly `/v1/phone/<fingerprint>`, for the Mac the link pins. The host
 * is the brand's relay (`relayHost`, by default `RELAY_HOST`), or one
 * `allowHost` accepts (the mock relay in development and tests; never in a
 * release build).
 */
export function isRelayUrl(
  url: string,
  fingerprint: string,
  options: { allowHost?: (url: string) => boolean; relayHost?: string | null } = {}
): boolean {
  const relayHost = options.relayHost === undefined ? RELAY_HOST : options.relayHost;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.pathname !== relayPhonePath(fingerprint)) return false;
  // Exactly as written: no `..` or doubled slashes the parser would tidy away.
  if (url !== `${u.protocol}//${u.host}${u.pathname}`) return false;
  if (u.protocol === 'wss:' && relayHost && u.hostname.toLowerCase() === relayHost.toLowerCase()) {
    return true;
  }
  return options.allowHost?.(url) === true;
}

// ---- HTTP over the channel ----------------------------------------------------------

/**
 * A request the Tailscale route makes in plain HTTP (identity, pair, blobs,
 * attachments). `body` is base64url; `more` says `httpBody` frames follow.
 */
export interface RelayHttpRequest {
  t: 'http';
  id: number;
  method: string;
  /** `/v1/…`, with any query. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  more?: true;
}

export interface RelayHttpResponse {
  t: 'httpRes';
  id: number;
  status: number;
  headers: Record<string, string>;
  body?: string;
  more?: true;
}

/** The rest of a body over `RELAY_HTTP_CHUNK`, either way, until `more` is false. */
export interface RelayHttpBody {
  t: 'httpBody';
  id: number;
  body: string;
  more: boolean;
}

export type RelayHttpFrame = RelayHttpRequest | RelayHttpResponse | RelayHttpBody;
