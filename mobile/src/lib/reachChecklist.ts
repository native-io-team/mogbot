/**
 * "Can't reach your Mac" as three things to check, each with what the phone
 * can see of it right now and the one fix: the Mac awake with the app open,
 * Tailscale on with the same account on both (or, for a phone that reaches
 * the Mac only through the relay, this phone online: it has no Tailscale to
 * check), and this phone paired. Used by
 * a pairing that got no answer (`pair.tsx`) and by a paired phone whose Mac
 * went quiet (`connection.tsx`).
 *
 * Only what the phone observed is said to be fine or wrong. An asleep Mac
 * and a closed app look exactly alike from here (silence), so that line is
 * never green or red, only "can't tell". The address that was tried is a
 * detail for the folded part, never the first line: it means nothing to the
 * person reading it, and it isn't what they fix.
 */

import { formatAgo } from './agents';

export type CheckTone = 'ok' | 'problem' | 'unknown';

/** The one thing a row's button does. */
export type CheckAction = 'open_tailscale' | 'get_tailscale' | 'pair_again';

export interface ReachCheck {
  id: 'mac' | 'tailscale' | 'online' | 'paired';
  title: string;
  tone: CheckTone;
  /** What the phone sees of it now, in a few words. */
  status: string;
  /** The one fix, or null when there's nothing to do here. */
  fix: string | null;
  action: CheckAction | null;
}

export interface ReachInputs {
  /** The Mac's own name ("Julian’s MacBook Pro"). */
  mac: string;
  /** This phone has a network at all (`store.phoneOnline`). */
  phoneOnline: boolean | null;
  /** The Tailscale app is on this phone; null when the OS won't say (Android). */
  tailscaleInstalled: boolean | null;
  /**
   * Tailscale is one of the ways to this Mac (default). False for a phone
   * paired through the relay only: no Tailscale row, just whether it's online.
   */
  viaTailscale?: boolean;
  /**
   * What pairing found: the Mac's name didn't resolve, which happens only
   * when Tailscale is off on this phone (`tailscale_off`), or it resolved
   * and nothing answered (`mac_unreachable`). Absent for a paired phone.
   */
  diagnosis?: 'tailscale_off' | 'mac_unreachable';
  /**
   * `not_yet` while pairing; `yes` for a paired phone (with when);
   * `let_go` when the Mac removed this phone or asks it to pair again.
   */
  paired: { kind: 'not_yet' } | { kind: 'yes'; since: number } | { kind: 'let_go' };
  /** When the Mac last answered, for a paired phone. */
  lastSeenAt?: number;
  /** From the Mac's last status: on battery with keep-awake off, so likely asleep. */
  likelyAsleep?: boolean;
  now?: number;
}

export function reachChecklist(input: ReachInputs): ReachCheck[] {
  const now = input.now ?? Date.now();
  const way = input.viaTailscale === false ? onlineCheck(input) : tailscaleCheck(input);
  return [macCheck(input, now), way, pairedCheck(input)];
}

/** The relay's way to the Mac: all this phone needs is a network. */
function onlineCheck({ phoneOnline }: ReachInputs): ReachCheck {
  const title = 'This phone is online';
  if (phoneOnline === false) {
    return {
      id: 'online',
      title,
      tone: 'problem',
      status: 'No network on this phone.',
      fix: 'Connect to Wi-Fi or mobile data.',
      action: null,
    };
  }
  return {
    id: 'online',
    title,
    tone: phoneOnline ? 'ok' : 'unknown',
    status: phoneOnline ? 'Yes.' : 'Can’t tell from here.',
    fix: null,
    action: null,
  };
}

function macCheck({ mac, lastSeenAt, likelyAsleep }: ReachInputs, now: number): ReachCheck {
  const seen = lastSeenAt ? `Last heard from ${formatAgo(lastSeenAt, now)}. ` : '';
  return {
    id: 'mac',
    title: `${mac} is awake, with the app open`,
    tone: 'unknown',
    status: likelyAsleep
      ? `${seen}It was on battery and allowed to sleep, so it probably is.`
      : `${seen}Can’t tell from here: asleep and closed look the same.`,
    fix: 'Wake the Mac and open the app on it. “Keep this Mac awake” in its Settings → Agents stops it sleeping.',
    action: null,
  };
}

function tailscaleCheck({ phoneOnline, tailscaleInstalled, diagnosis }: ReachInputs): ReachCheck {
  const title = 'Tailscale is on, same account on both';
  if (phoneOnline === false) {
    return {
      id: 'tailscale',
      title,
      tone: 'problem',
      status: 'This phone isn’t online.',
      fix: 'Connect to Wi-Fi or mobile data first.',
      action: null,
    };
  }
  if (tailscaleInstalled === false) {
    return {
      id: 'tailscale',
      title,
      tone: 'problem',
      status: 'Tailscale isn’t on this phone.',
      fix: 'Get Tailscale, sign in with the same account as your Mac and switch it on.',
      action: 'get_tailscale',
    };
  }
  if (diagnosis === 'tailscale_off') {
    return {
      id: 'tailscale',
      title,
      tone: 'problem',
      status: 'Off on this phone, or signed in to another account.',
      fix: 'Open Tailscale, switch it on, and check it’s the same account as your Mac.',
      action: 'open_tailscale',
    };
  }
  return {
    id: 'tailscale',
    title,
    tone: 'unknown',
    status: 'Can’t see from here whether it’s switched on.',
    fix: 'Open Tailscale and check it’s on, with the same account as your Mac. It needs to be on there too.',
    action: 'open_tailscale',
  };
}

function pairedCheck({ mac, paired }: ReachInputs): ReachCheck {
  const title = 'This phone is paired';
  switch (paired.kind) {
    case 'yes':
      return {
        id: 'paired',
        title,
        tone: 'ok',
        status: `Yes, with ${mac}.`,
        fix: null,
        action: null,
      };
    case 'let_go':
      return {
        id: 'paired',
        title,
        tone: 'problem',
        status: `${mac} doesn’t know this phone any more.`,
        fix: 'Pair again: scan a new code from the Mac.',
        action: 'pair_again',
      };
    case 'not_yet':
      return {
        id: 'paired',
        title,
        tone: 'unknown',
        status: 'Not yet: it happens once the Mac answers.',
        fix: null,
        action: null,
      };
  }
}

/** The folded detail: where it looked, for someone who wants it. */
export const reachDetail = (host: string, lastSeenAt?: number, now = Date.now()) =>
  `Tried ${host} over Tailscale; nothing answered.${
    lastSeenAt ? ` Last answer ${formatAgo(lastSeenAt, now)}.` : ''
  }`;
