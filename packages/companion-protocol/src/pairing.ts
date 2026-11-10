/**
 * Pairing and the plain-HTTP endpoints.
 *
 * The QR code holds a link, not a secret: a one-time pairing code that dies
 * after five minutes or one use, and the ways to reach the Mac. The device
 * token that follows is issued over the encrypted connection and never shown.
 */

import type { DevicePlatform, Route } from './model';
import type { ProtocolRange } from './version';
import { PAIRING_SCHEME, PREVIOUS_PAIRING_SCHEME } from './brand.gen';

// From brand.json, through the generated file both apps build against.
export { PAIRING_SCHEME, PREVIOUS_PAIRING_SCHEME };

/**
 * The other app's pairing scheme (the one this app grew out of). Its phone
 * app is a different app: a code from it is never paired with, only named.
 */
export const OTHER_APP_PAIRING_SCHEME = 'shipstudio-companion';
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * What a pairing QR code (or a pasted link) carries.
 *
 * A link is untrusted input: anyone can make one that says "Julian's MacBook
 * Pro" and points at their own server, and a Tailscale Funnel host has a
 * valid `*.ts.net` certificate too. So the phone asks before pairing from
 * any link, and pins `fingerprint`: before the pairing code goes, and on
 * every connection before the token goes, the Mac must sign a fresh
 * challenge with the key it names, along with the host the phone reached
 * (`MacIdentity`). Anything else and the phone stops ("This isn't your Mac").
 */
export interface PairingLink {
  /** Link format version, independent of the protocol version. */
  v: 1;
  /** One-time pairing code, 128 bits, base32. */
  code: string;
  /** The Mac's stable id, so a re-pair replaces rather than duplicates it. */
  serverId: string;
  /** The Mac's name, for "Pair with Julian's MacBook Pro?". */
  name: string;
  /** Exactly one: the host the confirm screen shows is the only one tried. */
  routes: Route[];
  /**
   * The Mac's identity key: the first 16 bytes of SHA-256 over its Ed25519
   * public key, base64url (22 characters).
   */
  fingerprint: string;
}

/** A signature by the Mac's identity key over a challenge the phone chose. */
export interface IdentityProof {
  /** Ed25519 public key, base64url (32 bytes). Its fingerprint must be the pinned one. */
  publicKey: string;
  /** Ed25519 signature, base64url (64 bytes), over `macProofMessage` or `pairProofMessage`. */
  signature: string;
}

/**
 * The Mac proving who it is before the phone says anything secret: the
 * `identity` frame on the socket and `POST /v1/identity` before pairing.
 * `hosts` are the names the Mac serves itself on (`tailscale serve`), and
 * the phone goes on only if the host it actually reached is one of them,
 * so a server that merely relays the Mac's answers can't pass it on.
 */
export interface MacIdentity {
  serverId: string;
  /** Lowercase host names, no port (`hostOf`). */
  hosts: string[];
  /** Over `macProofMessage(challenge, serverId, hosts)`. */
  identity: IdentityProof;
}

/**
 * The hosts as a signed line: lowercase, sorted, comma separated. A host
 * name can't hold a comma or a newline, so the line can't be read two ways.
 */
const hostLine = (hosts: string[]) =>
  [...hosts]
    .map((h) => h.toLowerCase())
    .sort()
    .join(',');

/**
 * What `MacIdentity.identity` signs. The Mac's `identity::mac_message`, byte
 * for byte. Each signed message starts with its own `<scheme>:<kind>:v2`
 * line, so a signature made for one purpose is never valid for another.
 */
export const macProofMessage = (challenge: string, serverId: string, hosts: string[]) =>
  `${PAIRING_SCHEME}:identity:v2\n${challenge}\n${serverId}\n${hostLine(hosts)}`;

/**
 * What `PairResponse.identity` signs: the challenge, the Mac, the hosts it
 * serves on, and the device it just made. The Mac's `identity::pair_message`.
 */
export const pairProofMessage = (
  challenge: string,
  serverId: string,
  hosts: string[],
  deviceId: string
) => `${PAIRING_SCHEME}:pair:v2\n${challenge}\n${serverId}\n${hostLine(hosts)}\n${deviceId}`;

/** A route URL's host as the Mac signs it: lowercase, no port. Null for no URL. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/**
 * A Tailscale route's URL as only `tailscale serve` makes it:
 * `https://<machine>.<tailnet>.ts.net[:port][/]`, nothing else (no path,
 * no user info, no other domain).
 */
export function isTailnetUrl(url: string): boolean {
  return /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net(?::\d{1,5})?\/?$/i.test(url);
}

export interface ParseOptions {
  /**
   * Also accept a Tailscale route on this other host (the mock Mac in
   * development and tests). Never set in a release build.
   */
  allowHost?: (url: string) => boolean;
}

/** `<PAIRING_SCHEME>://pair?d=<base64url(JSON)>`. A custom scheme, so the camera opens the app. */
export function formatPairingLink(link: PairingLink): string {
  return `${PAIRING_SCHEME}://pair?d=${toBase64Url(JSON.stringify(link))}`;
}

/** Why a pasted or scanned text isn't a link this app can pair from. */
export type LinkProblem =
  /** Not a pairing link at all, or one that can't be used. */
  | 'invalid'
  /**
   * A pairing link from a Mac too old to prove who it is (no identity
   * fingerprint): the Mac's app needs updating before this phone pairs.
   */
  | 'old_mac'
  /**
   * A pairing link from this app's Mac build from before its last rename
   * (`PREVIOUS_PAIRING_SCHEME`): the Mac is running an old copy, which shows
   * the old name everywhere. Update the app on the Mac, then make a new code.
   */
  | 'renamed_mac'
  /** A pairing link for the other app's phone app (`OTHER_APP_PAIRING_SCHEME`). */
  | 'other_app';

export type ParsedLink = { ok: true; link: PairingLink } | { ok: false; problem: LinkProblem };

/**
 * The link's contents, or why not. A usable link is v1 with exactly one
 * route (so the host the confirm screen shows is the only one the phone
 * will try), a Tailscale route only on a `*.ts.net` host, and the Mac's
 * identity fingerprint.
 */
export function readPairingLink(text: string, options: ParseOptions = {}): ParsedLink {
  const invalid = { ok: false, problem: 'invalid' } as const;
  const trimmed = text.trim();
  const isLink = (scheme: string | null) =>
    !!scheme && scheme !== PAIRING_SCHEME && trimmed.startsWith(`${scheme}://pair?`);
  if (isLink(PREVIOUS_PAIRING_SCHEME)) return { ok: false, problem: 'renamed_mac' };
  if (isLink(OTHER_APP_PAIRING_SCHEME)) return { ok: false, problem: 'other_app' };
  const match = new RegExp(`^${PAIRING_SCHEME}://pair\\?d=([A-Za-z0-9_-]+)$`).exec(trimmed);
  if (!match) return invalid;
  try {
    const link = JSON.parse(fromBase64Url(match[1])) as Partial<PairingLink>;
    if (link.v !== 1 || typeof link.code !== 'string' || typeof link.serverId !== 'string') {
      return invalid;
    }
    if (typeof link.name !== 'string' || !Array.isArray(link.routes) || link.routes.length !== 1) {
      return invalid;
    }
    const routesOk = link.routes.every(
      (r) =>
        (r.kind === 'tailscale' || r.kind === 'lan') &&
        typeof r.url === 'string' &&
        (r.kind === 'tailscale'
          ? isTailnetUrl(r.url) || options.allowHost?.(r.url) === true
          : // A LAN route is only usable with its certificate pin.
            r.url.startsWith('https://') && typeof r.pin === 'string')
    );
    if (!routesOk) return invalid;
    // Everything else is right and there's no fingerprint: a Mac from
    // before identity keys. Never paired with, but worth saying why.
    if (link.fingerprint === undefined) return { ok: false, problem: 'old_mac' };
    if (typeof link.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(link.fingerprint)) {
      return invalid;
    }
    return { ok: true, link: link as PairingLink };
  } catch {
    return invalid;
  }
}

/** `readPairingLink`'s link, or null for anything that can't be paired from. */
export function parsePairingLink(text: string, options: ParseOptions = {}): PairingLink | null {
  const read = readPairingLink(text, options);
  return read.ok ? read.link : null;
}

/** `POST /v1/identity`: the Mac proves who it is before the phone sends a pairing code. */
export interface IdentityRequest {
  protocol: ProtocolRange;
  /** 32 random bytes, base64url, fresh for this request. */
  challenge: string;
}

export type IdentityResponse =
  | ({ ok: true; protocol: number } & MacIdentity)
  | {
      ok: false;
      reason: 'update_app' | 'update_mac' | 'unavailable';
      message: string;
    };

/** `POST /v1/pair`. Held open until the user allows or denies it on the Mac (at most 120 s). */
export interface PairRequest {
  code: string;
  device: {
    name: string;
    platform: DevicePlatform;
    model?: string;
    appVersion: string;
    build: 'official' | 'self';
  };
  protocol: ProtocolRange;
  /**
   * X25519 public key, base64url. Unused by direct routes; kept so the future
   * relay can encrypt end to end without pairing again.
   */
  publicKey: string;
  /** 32 random bytes, base64url, for the Mac to sign (`PairResponse.identity`). */
  challenge: string;
}

export type PairResponse =
  | {
      ok: true;
      deviceId: string;
      /** 256-bit device token. Shown nowhere; the phone keeps it in the keychain. */
      token: string;
      serverId: string;
      /** For the future relay. Empty until a Mac issues one (P1 doesn't). */
      serverPublicKey: string;
      /** The hosts the Mac serves on, as signed (`hostOf`). */
      hosts: string[];
      /** Over `pairProofMessage(PairRequest.challenge, serverId, hosts, deviceId)`. */
      identity: IdentityProof;
    }
  | {
      ok: false;
      reason: 'expired' | 'used' | 'denied' | 'timeout' | 'update_app' | 'update_mac';
      message: string;
    };

/**
 * The HTTP endpoints besides pairing. All take `Authorization: Bearer <token>`.
 * Big files stay off the socket so a 25 MB upload never holds up a message.
 */
export const HTTP = {
  /** POST `IdentityRequest`, unauthenticated; answers `IdentityResponse`. */
  identity: '/v1/identity',
  pair: '/v1/pair',
  ws: '/v1/ws',
  /** PUT, raw body; `X-Name` header (URI-encoded) and `Content-Type`. Answers a `BlobRef`. Staged for 1 hour. */
  uploadBlob: '/v1/blobs',
  /** GET: a blob the Mac produced (screenshot, fetched path). Supports `Range`. */
  blob: (blobId: string) => `/v1/blobs/${encodeURIComponent(blobId)}`,
  /**
   * GET: a chat attachment, by its path relative to the agent's home
   * (`attachments/<message id>/<name>`, as `Attachment.path` carries it).
   * `?w=` for an image thumbnail. The route is that path under the agent:
   * `/v1/agents/<id>/attachments/<message id>/<name>`, never the
   * `attachments/` segment twice (which the Mac answered with a 404, and
   * every image on the phone was an empty box).
   */
  attachment: (agentId: string, path: string) => {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments[0] === 'attachments') segments.shift();
    return `/v1/agents/${encodeURIComponent(agentId)}/attachments/${segments
      .map(encodeURIComponent)
      .join('/')}`;
  },
} as const;

// ---- base64url without Buffer (the phone has no Node) -----------------------

/** Bytes (or a string's UTF-8) as unpadded base64url. */
export function toBase64Url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}
