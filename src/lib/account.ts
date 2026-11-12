/**
 * Signing in, on a build with our hosted relay (docs/relay.md, "Accounts").
 *
 * Signing in links this Mac's key to an account at the relay, which lets a
 * paired phone reach this Mac from anywhere without Tailscale (and, later,
 * our other hosted services). Without it everything on the user's own
 * machines works as before, and the phone uses their own Tailscale. A build
 * with no relay (`relayOn()` false: a fork, a self-host) never shows any of
 * this.
 *
 * The account isn't kept here: the relay says which account this Mac is
 * linked to, and it arrives in `companion_status` as `relay.account`. The
 * sign-in itself happens in the browser, so the app only starts it and
 * waits for that status to change.
 *
 * @module lib/account
 */

import { relayOn } from './brand';
import type { CheckResult } from './onboardingFlow';
import {
  getPhoneStatus,
  setPhoneAccess,
  signInAccount,
  type PhoneStatus,
  type RelayStatus,
} from './companion';

export type Account = NonNullable<RelayStatus['account']>;

/** One line on what signing in gets you, wherever Sign in is offered. */
export const ACCOUNT_UNLOCKS =
  'Signing in lets your phone reach this Mac from anywhere, with no Tailscale to set up.';

/** And what you keep without it. */
export const WITHOUT_ACCOUNT =
  'Without it, everything on this Mac works the same, and your phone can use your own Tailscale.';

export const SIGN_IN = 'Sign in';
export const USE_WITHOUT_SIGNING_IN = 'Use without signing in';
export const FINISH_IN_BROWSER = 'Finish signing in in your browser';

/** "Signed in as sam@example.com", or without the address when the relay gave none. */
export function signedInLine(account: Account): string {
  return account.email ? `Signed in as ${account.email}.` : 'Signed in.';
}

export const accountOf = (s: Pick<PhoneStatus, 'relay'> | null | undefined): Account | null =>
  s?.relay?.account ?? null;

/**
 * Where a sign-in stands, as the check line under Sign in says it: Done once
 * the relay names the account, a spinner while the page is being opened,
 * "Waiting for you" while the browser has it, the reason when it couldn't
 * start. Nothing before anyone has pressed Sign in.
 */
export function signInCheck(p: {
  account: Account | null;
  starting: boolean;
  waiting: boolean;
  error: string | null;
}): CheckResult | null {
  if (p.account) return { state: 'pass', line: signedInLine(p.account) };
  if (p.starting) return { state: 'checking', line: 'Opening the sign-in page…' };
  if (p.error) return { state: 'fail', line: p.error };
  if (p.waiting) {
    return {
      state: 'waiting',
      line: 'The sign-in page is open in your browser.',
      fix: 'Sign in with Google or your email there.',
    };
  }
  return null;
}

// ============ Onboarding's answer ============

/**
 * What the first-run "Sign in?" screen was answered with, so it's never
 * asked again (per viewer, like the other onboarding keys: losing it asks
 * once more, nothing worse).
 */
export const ACCOUNT_CHOICE_KEY = 'shipstudio.onboarding.account';
export type AccountChoice = 'signedIn' | 'without';

export function readAccountChoice(): AccountChoice | null {
  try {
    const v = window.localStorage.getItem(ACCOUNT_CHOICE_KEY);
    return v === 'signedIn' || v === 'without' ? v : null;
  } catch {
    return null;
  }
}

export function saveAccountChoice(choice: AccountChoice): void {
  try {
    window.localStorage.setItem(ACCOUNT_CHOICE_KEY, choice);
  } catch {
    // Storage blocked: the screen asks again next time, nothing else changes.
  }
}

// ============ The phone's way in ============

/**
 * "Use Tailscale instead" on the phone's setup, in a build with the relay:
 * the open-source way stays one click away, and is remembered so the phone
 * screens keep showing Tailscale's steps.
 */
export const PHONE_ROUTE_KEY = 'shipstudio.phone.route';

export function readPhoneRoute(): 'relay' | 'tailscale' {
  try {
    return window.localStorage.getItem(PHONE_ROUTE_KEY) === 'tailscale' ? 'tailscale' : 'relay';
  } catch {
    return 'relay';
  }
}

export function savePhoneRoute(route: 'relay' | 'tailscale'): void {
  try {
    if (route === 'tailscale') window.localStorage.setItem(PHONE_ROUTE_KEY, route);
    else window.localStorage.removeItem(PHONE_ROUTE_KEY);
  } catch {
    // Storage blocked: the screens offer signing in again.
  }
}

/** The phone's setup goes through signing in (no Tailscale screens). */
export const phoneViaRelay = () => relayOn() && readPhoneRoute() !== 'tailscale';

// ============ Starting a sign-in ============

/** How long to wait for this Mac's relay connection before saying so. */
export const RELAY_CONNECT_WAIT_MS = 15_000;

export interface SignInDeps {
  getPhoneStatus: () => Promise<PhoneStatus>;
  setPhoneAccess: (on: boolean) => Promise<PhoneStatus>;
  signInAccount: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_DEPS: SignInDeps = {
  getPhoneStatus,
  setPhoneAccess,
  signInAccount,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Open the sign-in page. Signing in goes through this Mac's own connection
 * to the relay, which is up only while phone access is on, so phone access
 * is turned on first (the screens that offer this say so), then this waits
 * for the connection before asking for the page.
 */
export async function beginSignIn(deps: SignInDeps = DEFAULT_DEPS): Promise<true> {
  let s = await deps.getPhoneStatus();
  if (!s.enabled) s = await deps.setPhoneAccess(true);
  const until = deps.now() + RELAY_CONNECT_WAIT_MS;
  while (s.relay.state !== 'connected') {
    if (deps.now() >= until) {
      throw new Error(
        'Couldn’t reach the sign-in service. Check this Mac is online, then try again.'
      );
    }
    await deps.sleep(500);
    s = await deps.getPhoneStatus();
  }
  await deps.signInAccount();
  return true;
}

// ============ ⌘K's way in ============

/**
 * "Sign in" / "Sign out" from ⌘K open Settings → Account and ask it to
 * start the sign-in, or to show the sign-out confirm. The page takes the
 * request once, when it opens (as `requestPairOnOpen` does for the phone).
 */
let onOpen: 'signIn' | 'signOut' | null = null;

export function requestAccountOnOpen(what: 'signIn' | 'signOut') {
  onOpen = what;
}

/** What ⌘K asked for, read on open without clearing it (a render may run twice). */
export function peekAccountOnOpen(): 'signIn' | 'signOut' | null {
  return onOpen;
}

export function takeAccountOnOpen(): 'signIn' | 'signOut' | null {
  const wanted = onOpen;
  onOpen = null;
  return wanted;
}
