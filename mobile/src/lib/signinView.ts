/**
 * Signing in on the Mac's Chrome from here (`agents.signin*`, desktop
 * `agents/phone_signin.rs`): the screen's states as one pure reducer, and
 * the tap maths. The requests are `phoneSignin.ts`. The Mac opens the card's site in a tab of
 * its own; this phone shows that tab and drives it.
 *
 * What's typed never enters this state: the screen keeps the field's text
 * in a ref, sends it once (`typeInput`), and wipes it. Secure entry hides
 * it as it's typed, and it's wiped when the app leaves the screen.
 */

import type {
  SigninBegun,
  SigninFrame,
  SigninInput,
  SigninKey,
  SigninOutcome,
} from '@shipstudio/companion-protocol';

/** The login card's line under "Sign in from here". */
export function signinHereLine(title: string): string {
  return `When ${title} isn’t signed in on your Mac’s Chrome: its sign-in opens there and shows here, and you sign in by touch. Nothing you type is kept.`;
}

/**
 * Why this connection can't carry a sign-in, in this screen's words, from
 * the secret rule's answer (`secretRouteProblem`, the same three tests).
 */
export function signinRouteProblem(
  secretProblem: string | null,
  route: { kind: string } | null
): string | null {
  if (!secretProblem) return null;
  if (!route) return 'Your Mac isn’t connected right now. Try again when it is.';
  if (route.kind !== 'tailscale')
    return 'Signing in from here only works over Tailscale, which encrypts it all the way to your Mac.';
  return 'This connection hasn’t proved it’s the Mac you paired with, so nothing you type goes to it.';
}

/** How the screen ended. */
export type EndReason = 'signed_in' | 'stopped' | 'ended' | 'failed';

export type SigninView =
  /** Asking the Mac to open the page. */
  | { phase: 'starting' }
  | {
      phase: 'live';
      begun: SigninBegun;
      /** The last picture; null until the first arrives. */
      frame: SigninFrame | null;
      /** Done said it's still on a sign-in page, or couldn't tell. */
      check: 'idle' | 'checking' | 'signed_out' | 'unknown';
      /** The field hides what's typed. */
      secure: boolean;
      /** The Mac's last refusal or failure, in its words. */
      note: string | null;
    }
  | { phase: 'ended'; reason: EndReason; message: string; domain?: string };

export type SigninEvent =
  | { t: 'begun'; begun: SigninBegun }
  | { t: 'frame'; frame: SigninFrame }
  | { t: 'note'; message: string | null }
  | { t: 'secure'; on: boolean }
  | { t: 'checking' }
  | { t: 'outcome'; outcome: SigninOutcome }
  | { t: 'end'; reason: EndReason; message: string };

export const initialView: SigninView = { phase: 'starting' };

export function reduce(view: SigninView, e: SigninEvent): SigninView {
  if (view.phase === 'ended') return view;
  if (e.t === 'end') {
    return {
      phase: 'ended',
      reason: e.reason,
      message: e.message,
      domain: view.phase === 'live' ? view.begun.domain : undefined,
    };
  }
  if (view.phase === 'starting') {
    return e.t === 'begun'
      ? { phase: 'live', begun: e.begun, frame: null, check: 'idle', secure: false, note: null }
      : view;
  }
  switch (e.t) {
    case 'begun':
      return view;
    case 'frame':
      return { ...view, frame: e.frame };
    case 'note':
      return { ...view, note: e.message };
    case 'secure':
      return { ...view, secure: e.on };
    case 'checking':
      return { ...view, check: 'checking', note: null };
    case 'outcome':
      if (e.outcome === 'signed_in') {
        return {
          phase: 'ended',
          reason: 'signed_in',
          message: `Signed in to ${view.begun.domain}. ${view.begun.title} is back with your agent.`,
          domain: view.begun.domain,
        };
      }
      return { ...view, check: e.outcome };
  }
}

/** The line under the picture, or null. */
export function statusLine(view: SigninView): string | null {
  if (view.phase === 'starting') return 'Opening it in Chrome on your Mac…';
  if (view.phase === 'ended') return view.message;
  if (view.check === 'checking') return 'Checking on your Mac…';
  if (view.check === 'signed_out')
    return 'It’s still asking you to sign in. Finish here, then Done.';
  if (view.check === 'unknown')
    return 'Your Mac couldn’t tell whether you’re signed in. If you are, hand it over anyway.';
  if (view.frame?.state === 'outside')
    return `That’s outside the sign-in${view.frame.host ? ` (${view.frame.host})` : ''}, so it isn’t shown. Go back to carry on.`;
  return view.note;
}

/** Input is possible: the page is showing, and Done isn't being checked. */
export function canAct(view: SigninView): boolean {
  return view.phase === 'live' && view.frame?.state === 'live' && view.check !== 'checking';
}

/**
 * The Mac's words for a sign-in that's over (`Refusal::message` in
 * `agents/phone_signin.rs`): the screen ends instead of retrying.
 */
export const ENDED_WORDS = [
  'That sign-in has ended.',
  'That sign-in was started on another phone.',
  'That sign-in sat idle for five minutes, so it was closed.',
  'Another phone is signing in on this Mac right now.',
] as const;

export function endsIt(message: string): boolean {
  return ENDED_WORDS.some((w) => message.includes(w));
}

/* ---------------------------------------------------------------- maths */

/**
 * Where a tap on the picture lands in the frame's own pixels. `shownWidth`
 * and `shownHeight` are the picture's laid-out size (zoom doesn't change
 * them: a touch inside a zoomed view reports unzoomed coordinates).
 */
export function toFramePoint(
  touch: { x: number; y: number },
  shown: { width: number; height: number },
  frame: { width: number; height: number }
): { x: number; y: number } | null {
  if (shown.width <= 0 || shown.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const x = (touch.x / shown.width) * frame.width;
  const y = (touch.y / shown.height) * frame.height;
  if (!(x >= 0 && y >= 0 && x <= frame.width && y <= frame.height)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** The picture's height at `width`, keeping its shape. */
export function shownHeight(width: number, frame: { width: number; height: number }): number {
  return frame.width > 0 ? Math.round((width * frame.height) / frame.width) : 0;
}

/** What one Type press sends: the text as it is, and whether it was hidden. */
export function typeInput(text: string, secure: boolean): SigninInput {
  return secure ? { kind: 'type', text, secure: true } : { kind: 'type', text };
}

/** The keys the bar offers, in order. */
export const KEYS: { key: SigninKey; label: string }[] = [
  { key: 'tab', label: 'Tab' },
  { key: 'backspace', label: 'Delete' },
  { key: 'enter', label: 'Enter' },
];

/** How long between pictures: about three a second, never piling up. */
export const FRAME_GAP_MS = 300;
