/**
 * The desk's blink timer (docs/internal/avatars.md, "Blinking"). No React
 * state: it sets `data-blinking` on the avatar's element for the length of a
 * blink and the CSS squashes the eyes (`agents-avatar-blink`). The schedule
 * is the spec's (`nextBlink`), one per avatar.
 *
 * One clock for every avatar on the desk, not a timer each: it sleeps until
 * the next blink anyone is due, and wakes once for every blink due within
 * `COALESCE_MS` of it. Avatars off-screen (`data-offscreen`) are left out of
 * the reckoning entirely, and while the window is hidden or in the background
 * (`lib/appActivity`) the clock has no timer at all: a sidebar of avatars
 * costs nothing until someone can see it again. A wake-up whose avatar should
 * hold still (Reduce Motion, or a `paused` given) skips its blink and just
 * sets the next one, so nothing is drawn.
 */

import { BLINK, nextBlink } from '../../packages/companion-protocol/src/avatar';
import { appQuiet, onAppActivity } from './appActivity';

/** One blink's length. */
export const BLINK_MS = BLINK.closeMs + BLINK.openMs;

/** Blinks due this close to the one that woke the clock run on the same wake-up. */
export const COALESCE_MS = 40;

export interface BlinkOptions {
  /** [0, 1): `Math.random` by default. */
  rand?: () => number;
  /** True while nothing should move. Asked at each wake-up. */
  paused?: () => boolean;
}

/** Whether the avatar should hold still right now. */
export function avatarPaused(el: Element): boolean {
  if (el.hasAttribute('data-offscreen')) return true;
  if (typeof document !== 'undefined' && document.hidden) return true;
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

type Phase = 'waiting' | 'closed' | 'double';

interface Entry {
  el: Element;
  rand: () => number;
  paused: () => boolean;
  phase: Phase;
  /** When this entry next needs the clock (Date.now() ms). */
  due: number;
  /** The blink in progress is the first of two. */
  double: boolean;
}

const entries = new Set<Entry>();
let timer: ReturnType<typeof setTimeout> | undefined;
let timerAt = Infinity;
let unlistenActivity: (() => void) | undefined;

/** Wake-ups so far (the harness probe and tests read it). */
export const blinkClock = { wakeups: 0 };

const dormant = (e: Entry) => e.phase === 'waiting' && e.el.hasAttribute('data-offscreen');

function wait(e: Entry, now: number): void {
  const step = nextBlink(e.rand);
  e.phase = 'waiting';
  e.double = step.double;
  e.due = now + step.gapMs;
}

function close(e: Entry, now: number): void {
  e.el.setAttribute('data-blinking', '');
  e.phase = 'closed';
  e.due = now + BLINK_MS;
}

function run(e: Entry, now: number): void {
  switch (e.phase) {
    case 'waiting':
      if (e.paused()) return wait(e, now);
      return close(e, now);
    case 'closed':
      e.el.removeAttribute('data-blinking');
      if (e.double) {
        // The second a beat after the first began, if it is still allowed.
        e.double = false;
        e.phase = 'double';
        e.due = now + (BLINK.doubleGapMs - BLINK_MS);
        return;
      }
      return wait(e, now);
    case 'double':
      if (e.paused()) return wait(e, now);
      return close(e, now);
  }
}

function clearTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  timerAt = Infinity;
}

/** Set the one timer for the earliest entry that can move. */
function arm(): void {
  if (entries.size === 0 || appQuiet()) return clearTimer();
  let next = Infinity;
  for (const e of entries) if (!dormant(e) && e.due < next) next = e.due;
  if (next === timerAt && timer !== undefined) return;
  clearTimer();
  if (next === Infinity) return;
  timerAt = next;
  timer = setTimeout(tick, Math.max(0, next - Date.now()));
}

function tick(): void {
  timer = undefined;
  timerAt = Infinity;
  blinkClock.wakeups++;
  const now = Date.now();
  for (const e of entries) {
    if (!dormant(e) && e.due <= now + COALESCE_MS) run(e, now);
  }
  arm();
}

/** The window went quiet or came back: drop the timer, or pick up afresh. */
function onActivity(): void {
  if (appQuiet()) {
    clearTimer();
    // Open every eye; each starts a fresh wait when the window is back.
    for (const e of entries) {
      if (e.phase !== 'waiting') {
        e.el.removeAttribute('data-blinking');
        e.phase = 'waiting';
        e.due = 0;
      }
    }
    return;
  }
  const now = Date.now();
  for (const e of entries) if (e.phase === 'waiting' && e.due < now) wait(e, now);
  arm();
}

/**
 * An avatar came back on screen (or went off): re-plan the clock. A blink
 * whose time passed while it was away gets a fresh wait rather than firing
 * the instant it scrolls in.
 */
export function blinkVisibilityChanged(el: Element): void {
  const now = Date.now();
  for (const e of entries) {
    if (e.el === el && e.phase === 'waiting' && e.due < now) wait(e, now);
  }
  arm();
}

/** Blinks `el` at random until the returned function is called. */
export function startBlinking(el: Element, options: BlinkOptions = {}): () => void {
  const entry: Entry = {
    el,
    rand: options.rand ?? Math.random,
    paused: options.paused ?? (() => avatarPaused(el)),
    phase: 'waiting',
    due: 0,
    double: false,
  };
  wait(entry, Date.now());
  entries.add(entry);
  unlistenActivity ??= onAppActivity(onActivity);
  arm();
  return () => {
    if (!entries.delete(entry)) return;
    el.removeAttribute('data-blinking');
    if (entries.size === 0) {
      unlistenActivity?.();
      unlistenActivity = undefined;
    }
    arm();
  };
}
