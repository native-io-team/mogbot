/**
 * Signing in on the Mac from here (`agents.signin*`, desktop
 * `agents/phone_signin.rs`): the screen's states as one pure reducer, and
 * the tap maths. The requests are `phoneSignin.ts`. The Mac opens the
 * card's site in a window of the agents' own Chrome (or, for an older card,
 * a tab of the user's Chrome); this phone shows it live and drives it.
 *
 * What's typed never enters this state: the screen keeps the field's text
 * in a ref, sends it once (`typeInput`), and wipes it. Secure entry hides
 * it as it's typed (on by itself when the page's focused field is a
 * password), and it's wiped when the app leaves the screen.
 */

import type {
  SigninBegun,
  SigninFrame,
  SigninInput,
  SigninKey,
  SigninOutcome,
  SigninVia,
} from '@shipstudio/companion-protocol';

/** The login card's line under "Sign in from here". */
export function signinHereLine(title: string): string {
  return `When ${title} isn’t signed in on your Mac’s Chrome: its sign-in opens there and shows here, and you sign in by touch. Nothing you type is kept.`;
}

/** Where the picture comes from, under the screen's title. */
export function viaLabel(via: SigninVia | undefined): string {
  switch (via) {
    case 'agents_browser':
      return 'The agents’ browser on your Mac';
    case 'mac_window':
      return 'A Chrome window on your Mac';
    case 'chrome':
      return 'Chrome on your Mac';
    default:
      // Still opening: the Mac hasn't said which browser yet.
      return 'Your Mac';
  }
}

/**
 * How long "Opening it on your Mac…" may last. The Mac gives up at 20s
 * with its own reason (`BEGIN_TIMEOUT`); this is for a Mac that never
 * answers at all, inside the socket's own 30s.
 */
export const BEGIN_TIMEOUT_MS = 25_000;
export const BEGIN_TIMEOUT_MESSAGE = 'Your Mac didn’t open the sign-in in time.';

/** `p`, or a rejection with `message` after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** What a failed start offers: try again, and the agents' browser by name. */
export function retryWays(view: SigninView): { label: string; way?: SigninVia }[] {
  if (view.phase !== 'ended' || !view.retry) return [];
  const ways: { label: string; way?: SigninVia }[] = [{ label: 'Try again' }];
  // The Mac said the agents' browser isn't there: don't offer it.
  if (!/agents.? browser isn.?t on/.test(view.message)) {
    ways.push({ label: 'Try the agents’ browser', way: 'agents_browser' });
  }
  return ways;
}

/** The Mac's way for this sign-in: an older Mac names none (its Chrome). */
export const viaOf = (begun: SigninBegun): SigninVia => begun.via ?? 'chrome';

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
      /** The field hides what's typed (the page asked, or the person did). */
      secure: boolean;
      /** The person turned hiding on themselves. */
      hide: boolean;
      /** How it's shown and driven now (a fallback changes it). */
      via: SigninVia;
      /** Asking the Mac for another way in. */
      switching: boolean;
      /** The Mac's last refusal or failure, in its words. */
      note: string | null;
    }
  | {
      phase: 'ended';
      reason: EndReason;
      message: string;
      domain?: string;
      /** It never opened: the screen offers to start it again. */
      retry?: boolean;
    };

export type SigninEvent =
  | { t: 'begun'; begun: SigninBegun }
  | { t: 'frame'; frame: SigninFrame }
  | { t: 'note'; message: string | null }
  | { t: 'secure'; on: boolean }
  | { t: 'switching' }
  | { t: 'switched'; begun: SigninBegun }
  | { t: 'checking' }
  | { t: 'outcome'; outcome: SigninOutcome }
  | { t: 'end'; reason: EndReason; message: string }
  /** Start again after a failed start. */
  | { t: 'retry' };

export const initialView: SigninView = { phase: 'starting' };

export function reduce(view: SigninView, e: SigninEvent): SigninView {
  if (view.phase === 'ended') return e.t === 'retry' && view.retry ? initialView : view;
  if (e.t === 'retry') return view;
  if (e.t === 'end') {
    const atStart = view.phase === 'starting' && e.reason === 'failed';
    return {
      phase: 'ended',
      reason: e.reason,
      message: e.message,
      domain: view.phase === 'live' ? view.begun.domain : undefined,
      ...(atStart ? { retry: true } : {}),
    };
  }
  if (view.phase === 'starting') {
    return e.t === 'begun'
      ? {
          phase: 'live',
          begun: e.begun,
          frame: null,
          check: 'idle',
          secure: false,
          hide: false,
          via: viaOf(e.begun),
          switching: false,
          note: null,
        }
      : view;
  }
  switch (e.t) {
    case 'begun':
      return view;
    case 'frame':
      // A password field focused on the page hides what's typed here too.
      return { ...view, frame: e.frame, secure: view.hide || !!e.frame.secure };
    case 'note':
      return { ...view, note: e.message, switching: false };
    case 'secure':
      return { ...view, hide: e.on, secure: e.on || !!view.frame?.secure };
    case 'switching':
      return { ...view, switching: true, note: null };
    case 'switched':
      return { ...view, via: viaOf(e.begun), frame: null, switching: false, note: null };
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
  if (view.phase === 'starting') return 'Opening it on your Mac…';
  if (view.phase === 'ended') return view.message;
  if (view.check === 'checking') return 'Checking on your Mac…';
  if (view.switching) return 'Opening it in a plain Chrome window on your Mac…';
  if (view.frame?.state === 'blocked')
    return `${view.frame.blocked ?? 'This site won’t sign in to this window.'} Sign in another way below.`;
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
  return (
    view.phase === 'live' &&
    view.frame?.state === 'live' &&
    view.check !== 'checking' &&
    !view.switching
  );
}

/** The site refused the window and the Mac may offer another way. */
export function canFallBack(view: SigninView): boolean {
  return (
    view.phase === 'live' &&
    view.via === 'agents_browser' &&
    view.frame?.state === 'blocked' &&
    !view.switching
  );
}

/** How long between pictures: what the Mac said, else about three a second. */
export function frameGap(view: SigninView): number {
  if (view.phase !== 'live') return FRAME_GAP_MS;
  if (view.via === 'mac_window') return 150;
  return view.begun.frameGapMs ?? FRAME_GAP_MS;
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
