/**
 * Pairing with a Mac, and keeping what it gives us (docs/mobile.md, "Pairing").
 * The QR code holds a one-time code; the device token comes back over TLS and
 * lives only in the keychain.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import {
  HTTP,
  SUPPORTED,
  pairProofMessage,
  parsePairingLink,
  toBase64Url,
  type PairRequest,
  type PairResponse,
  type PairingLink,
  type Route,
} from '@shipstudio/companion-protocol';
import { newChallenge, proves } from './identity';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';

/** One paired Mac. Multiple Macs are P3. */
export interface Credentials {
  serverId: string;
  name: string;
  routes: Route[];
  deviceId: string;
  token: string;
  /** X25519, base64url: unused by direct routes, kept for the future relay. */
  secretKey: string;
  pairedAt: number;
  /**
   * The Mac's identity key, fingerprinted (from the pairing link, proven in
   * the pairing answer). Every `welcome` must be signed by it. Absent only
   * for a pairing made before identity keys: the first signed welcome pins it.
   */
  fingerprint?: string;
}

/**
 * A pairing link from a scan, a paste or another app, or null. Tailscale
 * routes only on a `*.ts.net` host; a development build also takes the mock
 * Mac on this machine (`pnpm mock`).
 */
export function parseLink(text: string): PairingLink | null {
  return parsePairingLink(text, {
    allowHost: __DEV__
      ? (url) => /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(url)
      : undefined,
  });
}

/**
 * A name from a link, fit to show: no control characters, no invisible
 * format characters (bidi overrides, zero-width spaces) that could make it
 * read as something it isn't, one line, at most 60 characters.
 */
export function cleanName(raw: string): string {
  const clean = raw
    .replace(/\s+/g, ' ')
    // Cc, and the Cf characters that reorder or hide text.
    .replace(
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g,
      ''
    )
    .trim()
    .slice(0, 60)
    .trim();
  return clean || 'your Mac';
}

/** What pairing from `link` would do to the Mac this phone has now. */
export type PairPlan =
  /** No Mac yet. */
  | { kind: 'new' }
  /** The same Mac (same id, same key): pairing again replaces this phone's old pairing. */
  | { kind: 'again' }
  /** A different Mac: it replaces the one paired now. */
  | { kind: 'replace'; current: string }
  /** Says it's the paired Mac but carries a different key: never paired. */
  | { kind: 'impostor'; current: string };

export function pairPlan(
  link: PairingLink,
  current: Pick<Credentials, 'serverId' | 'name' | 'fingerprint'> | null
): PairPlan {
  if (!current) return { kind: 'new' };
  if (current.serverId === link.serverId) {
    return current.fingerprint && current.fingerprint !== link.fingerprint
      ? { kind: 'impostor', current: current.name }
      : { kind: 'again' };
  }
  return { kind: 'replace', current: current.name };
}

/** The host a link would pair with, as the confirm screen shows it. */
export function linkHost(link: PairingLink): string {
  const route = usableRoutes(link.routes)[0] ?? link.routes[0];
  try {
    return new URL(route.url).host;
  } catch {
    return route.url;
  }
}

const KEY = 'shipstudio.mac';
// Excluded from backups and other devices: the token is this phone's alone.
const STORE_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadCredentials(): Promise<Credentials | null> {
  const raw = await SecureStore.getItemAsync(KEY, STORE_OPTS);
  return raw ? (JSON.parse(raw) as Credentials) : null;
}

export const saveCredentials = (c: Credentials) =>
  SecureStore.setItemAsync(KEY, JSON.stringify(c), STORE_OPTS);

export const forgetCredentials = () => SecureStore.deleteItemAsync(KEY, STORE_OPTS);

/**
 * P1 connects over Tailscale only. A LAN route needs the pinned-transport
 * native module (P2), and plain fetch can't pin a self-signed certificate.
 */
export const usableRoutes = (routes: Route[]) => routes.filter((r) => r.kind === 'tailscale');

export type PairFailure =
  | { kind: 'lan_only' }
  /** The answer wasn't signed by the key the link named. */
  | { kind: 'not_your_mac' }
  | { kind: 'tailscale_off' }
  | { kind: 'mac_unreachable' }
  | { kind: 'refused'; reason: Extract<PairResponse, { ok: false }>['reason']; message: string }
  | { kind: 'expired' }
  | { kind: 'other'; message: string };

export class PairError extends Error {
  constructor(readonly failure: PairFailure) {
    super(failure.kind);
  }
}

export const appInfo = () => ({
  version: Application.nativeApplicationVersion ?? '0.0.0',
  build: Application.nativeBuildVersion ?? '0',
});

/**
 * Ask the Mac to pair. The request stays open while someone at the desk
 * decides (up to 120 s), so the caller shows "Allow on your Mac…" meanwhile.
 */
export async function pair(link: PairingLink, signal?: AbortSignal): Promise<Credentials> {
  const routes = usableRoutes(link.routes);
  if (!routes.length) throw new PairError({ kind: 'lan_only' });
  const secret = Crypto.getRandomBytes(32);
  const challenge = newChallenge((n) => Crypto.getRandomBytes(n));
  const body: PairRequest = {
    code: link.code,
    device: {
      name: Device.deviceName ?? Device.modelName ?? 'Phone',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      ...(Device.modelName ? { model: Device.modelName } : {}),
      appVersion: appInfo().version,
      build: Constants.expoConfig?.extra?.official ? 'official' : 'self',
    },
    protocol: SUPPORTED,
    publicKey: toBase64Url(x25519.getPublicKey(secret)),
    challenge,
  };

  let lastNetworkFailure: PairFailure = { kind: 'mac_unreachable' };
  for (const route of routes) {
    let res: Response;
    try {
      res = await fetch(route.url.replace(/\/$/, '') + HTTP.pair, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastNetworkFailure = await diagnose(route.url);
      continue;
    }
    // A wrong, used or expired code is a bare 404 (the Mac says nothing more).
    if (res.status === 404) throw new PairError({ kind: 'expired' });
    if (!res.ok) throw new PairError({ kind: 'other', message: `The Mac answered ${res.status}.` });
    const answer = (await res.json()) as PairResponse;
    if (!answer.ok) {
      throw new PairError({ kind: 'refused', reason: answer.reason, message: answer.message });
    }
    // The answer must come from the key the link named, for the Mac it named:
    // a token from anyone else is thrown away, not kept.
    if (
      answer.serverId !== link.serverId ||
      !proves(answer.identity, pairProofMessage(challenge, link.serverId), link.fingerprint)
    ) {
      throw new PairError({ kind: 'not_your_mac' });
    }
    return {
      fingerprint: link.fingerprint,
      serverId: answer.serverId,
      name: cleanName(link.name),
      routes,
      deviceId: answer.deviceId,
      token: answer.token,
      secretKey: toBase64Url(secret),
      pairedAt: Date.now(),
    };
  }
  throw new PairError(lastNetworkFailure);
}

/**
 * Why a route didn't answer, as far as the phone can tell. A `*.ts.net` name
 * resolves only through Tailscale's own DNS, so "host not found" means this
 * phone isn't on the tailnet; a name that resolves but never answers means
 * the Mac (or the app on it) isn't there. React Native's fetch hides the
 * difference, so this asks with XMLHttpRequest, which keeps the OS's reason.
 */
export function diagnose(
  url: string,
  timeoutMs = 6000
): Promise<{ kind: 'tailscale_off' } | { kind: 'mac_unreachable' }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = timeoutMs;
    xhr.onload = () => resolve({ kind: 'mac_unreachable' }); // answered after all: blame the socket
    xhr.ontimeout = () => resolve({ kind: 'mac_unreachable' });
    xhr.onerror = () => {
      const reason = String(xhr.responseText ?? '');
      resolve(
        /hostname could not be found|resolve host|UnknownHost|No address associated|nodename nor servname/i.test(
          reason
        ) && /\.ts\.net/i.test(url)
          ? { kind: 'tailscale_off' }
          : { kind: 'mac_unreachable' }
      );
    };
    xhr.open('GET', url.replace(/\/$/, '') + HTTP.pair);
    xhr.send();
  });
}

const TAILSCALE_STORE =
  Platform.OS === 'android'
    ? 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'
    : 'https://apps.apple.com/app/tailscale/id1470499037';

/** The Tailscale app if it's installed, otherwise its store page. */
export async function openTailscale() {
  try {
    if (await Linking.canOpenURL('tailscale://')) return await Linking.openURL('tailscale://');
  } catch {
    // fall through to the store
  }
  await Linking.openURL(TAILSCALE_STORE);
}
