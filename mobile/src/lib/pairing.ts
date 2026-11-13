/**
 * Pairing with a Mac, and keeping what it gives us (docs/mobile.md, "Pairing").
 * The QR code holds a one-time code; the device token comes back over TLS and
 * lives only in the keychain.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { isScreenshotsBuild } from './screenshots';
import {
  HTTP,
  readPairingLink,
  toBase64Url,
  type ParsedLink,
  type PairingLink,
  type Route,
  PAIR_WHERE,
  PAIR_YOUR_PHONE,
} from '@shipstudio/companion-protocol';
import { brand } from './brand';
import { pairWith, PairError, type PairFailure, type PairStep } from './pairFlow';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { pairedComputer } from './computer';

/** Where the desk keeps the phone (its Settings section, `lib/settingsPages.ts`). */
export const PHONE_SETTINGS = 'Settings → Phone';
/**
 * Where the desk shows a pairing code, in the desk's own words
 * (`companion-protocol/src/pairWords.ts`): the sidebar row reads "Pair your
 * phone" while no phone is paired, and opens straight on the code. With a
 * phone paired before, the same row (now naming that phone) opens the panel,
 * whose button is "Pair your phone" too.
 */
export const WHERE_TO_PAIR = `“${PAIR_YOUR_PHONE}” ${PAIR_WHERE}`;

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
   * The Mac's identity key, fingerprinted (from the pairing link, proven
   * before the code went and in the pairing answer). Every connection must
   * be proven by it before the token goes. Absent only from a pairing made
   * before identity keys, which is never used: it has to be made again.
   */
  fingerprint?: string;
}

export { PairError, type PairFailure, type PairStep };

/**
 * A pairing link from a scan, a paste or another app, or null. Tailscale
 * routes only on a `*.ts.net` host; a development build also takes the mock
 * Mac on this machine (`pnpm mock`), as does a screenshots build (lib/screenshots.ts).
 */
export function readLink(text: string): ParsedLink {
  return readPairingLink(text, {
    allowHost: __DEV__ || isScreenshotsBuild() ? isDevHost : undefined,
  });
}

/** The mock Mac (`https?://`) and the mock relay (`wss?://…/v1/phone/<fingerprint>`) on this machine. */
export const isDevHost = (url: string) =>
  /^(https?|wss?):\/\/(localhost|127\.0\.0\.1):\d+(\/v1\/phone\/[A-Za-z0-9_-]{22})?\/?$/.test(url);

export function parseLink(text: string): PairingLink | null {
  const read = readLink(text);
  return read.ok ? read.link : null;
}

/** What to say about text that isn't a link this app can pair from. */
export function linkProblem(text: string): string {
  const comp = pairedComputer();
  const read = readLink(text);
  const notCode = `That isn’t a pairing code. On ${comp.your}, click ${WHERE_TO_PAIR}, then scan the code it shows.`;
  if (read.ok) return notCode;
  switch (read.problem) {
    case 'old_mac':
      return `Update the app on ${comp.your} to pair. This code comes from an older version that can’t prove it’s ${comp.your}; once it’s updated, make a new code there.`;
    case 'renamed_mac':
      // The Mac runs a copy from before the app's last rename, which still
      // shows its old name: updating it is the fix, not this phone.
      return `Update the app on ${comp.your} to pair. This code comes from an older copy, from before the app was renamed, so it shows the old name there too. Once it’s updated, make a new code there.`;
    case 'old_phone':
      return `Update ${brand.name} on this phone to pair: ${comp.yours} app is newer and reaches the phone a way this version doesn’t know. Get the latest from TestFlight or the App Store, then scan the code again.`;
    case 'other_app':
      return `That code is for a different app’s phone app. In ${brand.name} on ${comp.your}, click ${WHERE_TO_PAIR}, then scan the code it shows.`;
    default:
      return notCode;
  }
}

/**
 * A name from a link, fit to show: no control characters, no invisible
 * format characters (bidi overrides, zero-width spaces) that could make it
 * read as something it isn't, one line, at most 60 characters.
 */
export function cleanName(raw: string): string {
  const comp = pairedComputer();
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
  return clean || comp.your;
}

/** What pairing from `link` would do to the Mac this phone has now. */
export type PairPlan =
  /** No Mac yet. */
  | { kind: 'new' }
  /** The same Mac (same id, same pinned key): pairing again replaces this phone's old pairing. */
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
    // "Already paired with" is only said when the key matches the one this
    // phone pinned: a link can copy a Mac's name and id, not its key.
    if (!current.fingerprint) return { kind: 'replace', current: current.name };
    return current.fingerprint === link.fingerprint
      ? { kind: 'again' }
      : { kind: 'impostor', current: current.name };
  }
  return { kind: 'replace', current: current.name };
}

/** The host a link would pair with, as the confirm screen shows it: its only route's. */
export function linkHost(link: PairingLink): string {
  const route = link.routes[0];
  try {
    return new URL(route.url).host;
  } catch {
    return route.url;
  }
}

const KEY = 'shipstudio.mac';
// Excluded from backups and other devices: the token is this phone's alone.
const STORE_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const filled = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * A saved pairing read back, or null when it isn't one: every field the
 * connection sends or checks must be there and of its type. A route that
 * isn't one is left out; with none left there's nothing to reach.
 */
export function asCredentials(v: unknown): Credentials | null {
  const comp = pairedComputer();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (!filled(c.serverId) || !filled(c.deviceId) || !filled(c.token)) return null;
  if (!Array.isArray(c.routes)) return null;
  const routes = c.routes.filter(
    (r): r is Route =>
      typeof r === 'object' && r !== null && filled(r.kind) && filled((r as Route).url)
  );
  if (!routes.length) return null;
  if (c.fingerprint != null && typeof c.fingerprint !== 'string') return null;
  return {
    ...(c as unknown as Credentials),
    name: filled(c.name) ? c.name : comp.yourCap,
    routes,
    secretKey: typeof c.secretKey === 'string' ? c.secretKey : '',
    pairedAt: typeof c.pairedAt === 'number' && Number.isFinite(c.pairedAt) ? c.pairedAt : 0,
  };
}

/**
 * The keychain's pairing: `damaged` when something is saved but can't be
 * read as one (a torn write, a build that saved another shape). It is
 * never used, and is removed so the next launch doesn't trip on it again.
 */
export type SavedPairing =
  | { kind: 'none' }
  | { kind: 'paired'; credentials: Credentials }
  | { kind: 'damaged' };

export function readCredentials(raw: string | null): SavedPairing {
  if (!raw) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged' };
  }
  const credentials = asCredentials(parsed);
  return credentials ? { kind: 'paired', credentials } : { kind: 'damaged' };
}

/** The saved pairing; a damaged one is removed from the keychain here. */
export async function loadPairing(): Promise<SavedPairing> {
  const saved = readCredentials(await SecureStore.getItemAsync(KEY, STORE_OPTS));
  if (saved.kind === 'damaged') await forgetCredentials().catch(() => {});
  return saved;
}

export async function loadCredentials(): Promise<Credentials | null> {
  const saved = await loadPairing();
  return saved.kind === 'paired' ? saved.credentials : null;
}

export const saveCredentials = (c: Credentials) =>
  SecureStore.setItemAsync(KEY, JSON.stringify(c), STORE_OPTS);

export const forgetCredentials = () => SecureStore.deleteItemAsync(KEY, STORE_OPTS);

/**
 * The relay (docs/relay.md) and Tailscale, in the Mac's order (relay first
 * when it offers one). A LAN route needs the pinned-transport native module
 * (P2), and plain fetch can't pin a self-signed certificate.
 */
export const usableRoutes = (routes: Route[]) =>
  routes.filter((r) => r.kind === 'tailscale' || r.kind === 'relay');

export const appInfo = () => ({
  version: Application.nativeApplicationVersion ?? '0.0.0',
  build: Application.nativeBuildVersion ?? '0',
});

/**
 * Ask the Mac to pair: it proves itself first, then the code goes, and the
 * answer is checked before its token is kept. `onStep` says when each step
 * starts: "Reaching your Mac…" first, and "Allow on your Mac" only once the
 * Mac has proved itself and the code has gone (up to 120 s at the desk).
 */
export async function pair(
  link: PairingLink,
  signal?: AbortSignal,
  onStep?: (step: PairStep) => void
): Promise<Credentials> {
  const secret = Crypto.getRandomBytes(32);
  const paired = await pairWith(link, {
    // Bound: called as `deps.fetch`, a bare browser fetch throws "Illegal invocation".
    fetch: (input, init) => fetch(input, init),
    random: (n) => Crypto.getRandomBytes(n),
    device: {
      name: Device.deviceName ?? Device.modelName ?? 'Phone',
      platform: Platform.OS === 'android' ? 'android' : 'ios',
      ...(Device.modelName ? { model: Device.modelName } : {}),
      appVersion: appInfo().version,
      build: Constants.expoConfig?.extra?.official ? 'official' : 'self',
    },
    publicKey: toBase64Url(x25519.getPublicKey(secret)),
    signal,
    diagnose,
    onStep,
  });
  return {
    fingerprint: paired.fingerprint,
    serverId: paired.serverId,
    name: cleanName(link.name),
    routes: [paired.route],
    deviceId: paired.deviceId,
    token: paired.token,
    secretKey: toBase64Url(secret),
    pairedAt: Date.now(),
  };
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

export const TAILSCALE_STORE =
  Platform.OS === 'android'
    ? 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'
    : 'https://apps.apple.com/app/tailscale/id1470499037';

/**
 * Whether the Tailscale app is on this phone; `null` when the OS won't say.
 * Android 11+ answers `false` for any app not declared in `<queries>`, so
 * there its "no" means nothing: unknown, not "not installed".
 */
export async function tailscaleInstalled(): Promise<boolean | null> {
  if (Platform.OS === 'android') return null;
  try {
    return await Linking.canOpenURL('tailscale://');
  } catch {
    return null;
  }
}

/** Where the Mac app is downloaded from (brand.json `links.macDownload`), or null. */
export { MAC_DOWNLOAD_URL } from '@shipstudio/companion-protocol';

/** The Tailscale app if it's installed, otherwise its store page. */
export async function openTailscale() {
  try {
    if (await Linking.canOpenURL('tailscale://')) return await Linking.openURL('tailscale://');
  } catch {
    // fall through to the store
  }
  await Linking.openURL(TAILSCALE_STORE);
}
