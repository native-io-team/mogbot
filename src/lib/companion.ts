/**
 * The mobile companion, as the Phone panel sees it: turn phone access on,
 * show a one-time pairing code, Allow or Deny the phone that used it, and
 * see or remove paired phones. The server is `src-tauri/src/companion/`;
 * the wire protocol the phone speaks is `packages/companion-protocol`.
 *
 * @module lib/companion
 */

import type { CheckResult } from './onboardingFlow';
import { invoke } from '@tauri-apps/api/core';
import type { Device, DevicePlatform } from '../../packages/companion-protocol/src/model';

export type { Device };

/** Re-read `companion_status` when this fires (a pair request, a connect). */
export const COMPANION_CHANGED_EVENT = 'companion://changed';

/** `tailscale::TailscaleState`. */
export type TailscaleState =
  | { state: 'notInstalled' }
  | { state: 'needsLogin' }
  /** `login`: the account this Mac is signed in as, when Tailscale names one. */
  | { state: 'connected'; dnsName: string; login?: string }
  | { state: 'unknown'; detail: string };

/** The tailnet route, as read back from Tailscale (`desktop::ServeState`). */
export type ServeState =
  | { state: 'off' }
  | { state: 'on'; url: string }
  | { state: 'needsApproval'; url: string }
  | { state: 'failed'; detail: string };

/** A phone that used the code, waiting for Allow or Deny. */
export interface PairRequestDevice {
  name: string;
  platform: DevicePlatform;
  model?: string;
  appVersion: string;
  build: 'official' | 'self';
}

/** `pairing::RequestView`: one phone's request, answered by its `id`. */
export interface PairRequestView {
  id: string;
  /** Name and model as the phone gave them, cleaned of invisible and control characters. */
  device: PairRequestDevice;
  requestedAt: number;
  /** The last four characters of the code it used, as the phone shows them too. */
  codeHint: string;
  /** The tailnet user `tailscale serve` named, when it named one. */
  login?: string;
  /** Paired phones with the same name and model: offered for replacing, never replaced unasked. */
  replaces: Device[];
}

export interface PairingView {
  active: boolean;
  expiresAt?: number;
  /**
   * While the code is out: when something on the tailnet first asked this
   * Mac to prove itself, which a phone does just before sending the code.
   * Unauthenticated, so it's "a device", never "your phone".
   */
  reachedAt?: number;
  request?: PairRequestView;
}

/** A phone's latest action, from the shared audit log. */
export interface PhoneActivity {
  /** The method it called (`agents.send`), as the audit log names it. */
  tool: string;
  detail: string;
  ok: boolean;
  atMs: number;
}

export interface PhoneStatus {
  enabled: boolean;
  running: boolean;
  serve: ServeState;
  tailscale: TailscaleState;
  devices: Device[];
  pairing: PairingView;
  /** By device id; a phone with nothing recorded yet is absent. */
  activity: Record<string, PhoneActivity>;
  /** What a paired phone can call on this Mac (`welcome.methods`). */
  methods: string[];
  /** Phone notifications through the push relay (`companion/push.rs`). */
  push: PushView;
  /** The phone relay (docs/relay.md, `companion/relay/mod.rs` `RelayStatus`). */
  relay: RelayStatus;
}

/**
 * Whether this Mac is signed in at the relay, and the account its key is
 * linked to (as the relay last said; kept through a reconnect, null once off).
 * `off`: no relay in this build, or phone access is off.
 */
export interface RelayStatus {
  state: 'off' | 'connecting' | 'connected';
  account: { id: string; email: string | null } | null;
}

/** Connected with an account: phones reach this Mac through the relay. */
export const relayReady = (r: RelayStatus | undefined) =>
  r?.state === 'connected' && r.account !== null;

/** `push::PushView`. `available` is false in a build with no push service. */
export interface PushView {
  available: boolean;
  enabled: boolean;
}

export interface PairingCode {
  /** What the QR code says, for pasting into the phone instead. */
  link: string;
  /** Row by row, `1` for a dark module. */
  qr: { size: number; modules: string };
  expiresAt: number;
}

/**
 * The relay as the last status read said, for the ⌘K account commands'
 * `when` (offer Sign in or Sign out without a call of their own). Null until
 * a status has been read.
 */
let lastRelay: RelayStatus | null = null;
export const lastKnownRelay = () => lastRelay;
const remember = (s: PhoneStatus) => {
  lastRelay = s?.relay ?? null;
  return s;
};

export const getPhoneStatus = () => invoke<PhoneStatus>('companion_status').then(remember);

export const setPhoneAccess = (enabled: boolean) =>
  invoke<PhoneStatus>('companion_set_enabled', { enabled }).then(remember);

export const setPhonePush = (enabled: boolean) =>
  invoke<PhoneStatus>('companion_set_push', { enabled });

export const retryPhoneTailscale = () => invoke<PhoneStatus>('companion_retry_tailscale');

/** "Sign in": opens the relay's sign-in page; the account arrives as a status change. */
export const signInAccount = () => invoke<void>('companion_account_sign_in');

/** "Sign out": unlinks this Mac from its account at the relay. */
export const signOutAccount = () => invoke<void>('companion_account_sign_out');

/** A phone signed in to this Mac's Tailscale account (`tailscale::TailnetPhone`). */
export interface TailnetPhone {
  name: string;
  os: 'ios' | 'android';
  /** Tailscale is switched on on it right now. */
  online: boolean;
}

/** This account's phones on the tailnet: onboarding's "is it on your phone?" check. */
export const getTailnetPhones = () => invoke<TailnetPhone[]>('companion_tailnet_phones');

/** A QR code for a web page (a store link), drawn by `PhoneQr`. */
export const getLinkQr = (url: string) =>
  invoke<{ size: number; modules: string }>('companion_link_qr', { url });

export const startPairing = () => invoke<PairingCode>('companion_pair_start');

export const cancelPairing = () => invoke<void>('companion_pair_cancel');

/**
 * Allow or Deny the request the panel is showing (by id, so a click can't
 * land on another phone that asked meanwhile). `replace` names paired
 * phones to remove on Allow, from that request's `replaces`.
 */
export const decidePairing = (requestId: string, allow: boolean, replace: string[] = []) =>
  invoke<void>('companion_pair_decide', { requestId, allow, replace });

export const removePhone = (deviceId: string) =>
  invoke<PhoneStatus>('companion_revoke', { deviceId });

/**
 * Cmd+K "Pair a phone" opens the Phone panel and asks it to show a code
 * straight away. The modal takes the request once, when it opens.
 */
let pairOnOpen = false;

export function requestPairOnOpen() {
  pairOnOpen = true;
}

export function takePairOnOpen(): boolean {
  const wanted = pairOnOpen;
  pairOnOpen = false;
  return wanted;
}

// ---- Wording ----------------------------------------------------------------

/** Where phone access stands, in one state the panel renders. */
export type PhoneStep =
  | { kind: 'off' }
  | { kind: 'installTailscale' }
  | { kind: 'signInTailscale' }
  | { kind: 'approveHttps'; url: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'starting' }
  /** `url`: the Tailscale address, when that's serving (absent: the relay only). */
  | { kind: 'ready'; url?: string };

/** Off beats everything; then the relay (a route without Tailscale); then Tailscale itself; then our route. */
export function phoneStep(s: PhoneStatus): PhoneStep {
  if (!s.enabled) return { kind: 'off' };
  if (relayReady(s.relay)) {
    return s.serve.state === 'on' ? { kind: 'ready', url: s.serve.url } : { kind: 'ready' };
  }
  if (s.tailscale.state === 'notInstalled') return { kind: 'installTailscale' };
  if (s.tailscale.state === 'needsLogin') return { kind: 'signInTailscale' };
  switch (s.serve.state) {
    case 'on':
      return { kind: 'ready', url: s.serve.url };
    case 'needsApproval':
      return { kind: 'approveHttps', url: s.serve.url };
    case 'failed':
      return { kind: 'failed', detail: s.serve.detail };
    case 'off':
      return s.tailscale.state === 'unknown'
        ? { kind: 'failed', detail: s.tailscale.detail }
        : { kind: 'starting' };
  }
}

/**
 * "iPhone 16 Pro · app 1.0.0", plus "built on this Mac" for a self-build.
 * The model is left out when the phone is already called that.
 */
export function deviceLine(
  d: Pick<Device, 'name' | 'platform' | 'model' | 'appVersion' | 'build'>
) {
  const what = d.model ?? (d.platform === 'ios' ? 'iPhone' : 'Android phone');
  const parts = what === d.name ? [] : [what];
  parts.push(`app ${d.appVersion}`);
  if (d.build === 'self') parts.push('built on this Mac');
  return parts.join(' · ');
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Connected now, or when it was last seen, and over which route. */
export function presenceLine(d: Device, now: number): string {
  if (d.connected) return 'Connected now';
  if (d.lastSeenAt === undefined) return 'Hasn’t connected yet';
  const route = d.lastRoute === 'tailscale' ? ' over Tailscale' : '';
  return `Last seen ${ago(d.lastSeenAt, now)}${route}`;
}

/** "4:32" until a code expires; null once it has. */
export function expiresIn(expiresAt: number, now: number): string | null {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** Tailscale's own store pages: the phone reaches this Mac only through it. */
export const TAILSCALE_IOS_URL = 'https://apps.apple.com/app/tailscale/id1470499037';
export const TAILSCALE_ANDROID_URL =
  'https://play.google.com/store/apps/details?id=com.tailscale.ipn';

/**
 * How the phone signs in to Tailscale: as the account this Mac reports, or
 * "with the same account as this Mac" when it reports none. Never guessed.
 */
export function phoneTailscaleSignIn(t: TailscaleState | null): string {
  return t?.state === 'connected' && t.login
    ? `sign in as ${t.login}`
    : 'sign in with the same account as this Mac';
}

/** "Install Tailscale on your phone and sign in as julian@…." */
export function phoneTailscaleText(t: TailscaleState | null): string {
  return `Install Tailscale on your phone and ${phoneTailscaleSignIn(t)}.`;
}

/** The address without the scheme, for showing. */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '');
}

/** What each audited method was, in the past tense. */
const DID: Record<string, string> = {
  'agents.send': 'Sent a message',
  'agents.stop': 'Stopped an agent',
  'agents.interrupt': 'Interrupted an agent',
  'agents.markUnread': 'Marked a chat unread',
  'agents.fetchPath': 'Downloaded a file',
  'agents.schedule.create': 'Added a routine',
  'agents.schedule.update': 'Edited a routine',
  'agents.schedule.cancel': 'Cancelled a routine',
  'agents.schedule.runNow': 'Ran a routine now',
  'devices.unpairSelf': 'Forgot this Mac',
};

/** "Sent a message · 3 min ago"; "Allowed a request", "Paused a routine". */
export function activityLine(a: PhoneActivity, now: number): string {
  let what = DID[a.tool];
  if (a.tool === 'agents.answerApproval') {
    what = a.detail.startsWith('deny') ? 'Denied a request' : 'Allowed a request';
  } else if (a.tool === 'agents.schedule.pause') {
    what = a.detail.startsWith('resume') ? 'Resumed a routine' : 'Paused a routine';
  }
  const line = `${what ?? a.tool}${a.ok ? '' : ', refused'}`;
  return `${line} · ${ago(a.atMs, now)}`;
}

/**
 * What a paired phone can and can't do here, from the methods this Mac
 * serves. "Can't" is fixed by design (docs/mobile.md, "Principles"), plus
 * anything the Mac doesn't serve yet.
 */
export function phoneCapabilities(methods: string[]): { can: string[]; cannot: string[] } {
  const has = (...m: string[]) => m.every((x) => methods.includes(x));
  const can: string[] = [];
  if (has('agents.send', 'agents.answerApproval'))
    can.push('Chat with agents and answer what they ask');
  if (has('agents.stop', 'agents.interrupt')) can.push('Stop or interrupt an agent');
  if (has('agents.fetchPath')) can.push('Send photos and files, and download what agents share');
  if (has('agents.files')) can.push('Browse every file in a conversation');
  if (has('agents.search')) can.push('Search every conversation');
  if (has('agents.schedule.create')) can.push('Add, edit, pause and run routines');
  if (has('projects.list', 'sessions.read'))
    can.push('See projects and read their agents’ conversations');
  const cannot = ['Push to git', 'Edit code', 'Type into a plain terminal', 'Manage other phones'];
  if (has('projects.list') && !has('sessions.send'))
    cannot.unshift('Type to the agents in projects');
  return { can, cannot };
}

/**
 * What the push toggle says leaves this Mac. It must stay true to
 * `services/push-relay` (docs/push-relay.md): no message, name or project.
 */
export const PUSH_COPY = {
  label: 'Phone notifications',
  detail:
    'When the app isn’t open on your phone, it still hears that an agent needs you or finished. ' +
    'Only a generic alert is sent, with no message, agent name or project. Apple or Google delivers it.',
  officialOnly:
    'Needs the official app from TestFlight or the App Store. A self-built app can’t receive push.',
} as const;

/** How long the phone's Tailscale step looks quietly before it says how to fix it. */
export const PHONE_TAILNET_PATIENCE_MS = 15_000;

/**
 * The phone's Tailscale step's check, from what this Mac's Tailscale sees:
 * a phone switched on passes; one that's there but off says so by name; none
 * after a short wait says the usual cause (the phone signed in to another
 * account: "Sign in with Apple" makes a separate one) and that the same
 * Wi-Fi isn't needed, since Tailscale connects them over any network.
 */
export function phoneTailnetCheck(
  phones: TailnetPhone[] | null,
  t: TailscaleState | null,
  slow: boolean
): CheckResult {
  const on = phones?.find((p) => p.online);
  if (on) return { state: 'pass', line: `${on.name} is on your Tailscale.` };
  const off = phones?.[0];
  const account = t?.state === 'connected' && t.login ? t.login : null;
  if (off) {
    return {
      state: 'waiting',
      line: `${off.name} is on your Tailscale, but switched off.`,
      fix: 'Open Tailscale on the phone and switch it on, until it says Connected.',
    };
  }
  if (!slow) return { state: 'checking', line: 'Looking for your phone on your Tailscale…' };
  return {
    state: 'waiting',
    line: 'This Mac can’t see your phone on its Tailscale yet.',
    fix: account
      ? `Usually the phone is signed in to another Tailscale account. It should show ${account}. “Not working?” lists what to check.`
      : 'Usually the phone is signed in to another Tailscale account. “Not working?” lists what to check.',
  };
}

/**
 * "Not working?" on the phone's Tailscale step: everything to check, most
 * likely first. The account comes first because it's the usual cause and
 * looks fine on both screens ("Connected" on each, on different accounts).
 */
export function phoneTailnetTroubleSteps(t: TailscaleState | null): string[] {
  const account = t?.state === 'connected' && t.login ? t.login : null;
  return [
    account
      ? `Same account on both. This Mac is signed in to Tailscale as ${account}. On the phone, open Tailscale and tap the account at the top: it must say ${account} too. Sign in with Apple, Google or an email each make a separate account, so sign out and sign back in as ${account} if it doesn’t match.`
      : 'Same account on both. On the phone, open Tailscale and tap the account at the top: it must be the account this Mac is signed in with. Sign in with Apple, Google or an email each make a separate account.',
    'Switched on. On the phone, Tailscale’s switch is on and it says Connected. If it asked to add a VPN configuration, you tapped Allow (Settings → VPN shows Tailscale as connected).',
    'On on this Mac too. Tailscale’s icon in the menu bar says Connected.',
    'Switch it off and on. On the phone, turn Tailscale off and back on, then give this Mac a few seconds to notice.',
    'Look for it in Tailscale. On login.tailscale.com, under Machines, your phone should be listed with this Mac. If it isn’t there, the phone is on another account.',
    'The same Wi-Fi isn’t needed. Tailscale connects them over any network, at home or away.',
  ];
}
