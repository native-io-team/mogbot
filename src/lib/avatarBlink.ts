/**
 * The desk's blink timer (docs/internal/avatars.md, "Blinking"). One
 * setTimeout per avatar, no React state: it sets `data-blinking` on the
 * avatar's element for the length of a blink and the CSS squashes the eyes
 * (`agents-avatar-blink`). The schedule is the spec's (`nextBlink`); while
 * the avatar is off-screen, the window is hidden or Reduce Motion is on, a
 * wake-up skips its blink and just sets the next one, so nothing is drawn.
 */

import { BLINK, nextBlink } from '../../packages/companion-protocol/src/avatar';

/** One blink's length. */
export const BLINK_MS = BLINK.closeMs + BLINK.openMs;

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

/** Blinks `el` at random until the returned function is called. */
export function startBlinking(el: Element, options: BlinkOptions = {}): () => void {
  const rand = options.rand ?? Math.random;
  const paused = options.paused ?? (() => avatarPaused(el));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const blink = (then: () => void) => {
    el.setAttribute('data-blinking', '');
    timer = setTimeout(() => {
      el.removeAttribute('data-blinking');
      then();
    }, BLINK_MS);
  };
  const wait = () => {
    if (stopped) return;
    const step = nextBlink(rand);
    timer = setTimeout(() => {
      if (stopped) return;
      if (paused()) return wait();
      if (!step.double) return blink(wait);
      // Two in a row: the second a beat after the first, if it is still allowed.
      blink(() => {
        timer = setTimeout(() => {
          if (stopped) return;
          if (paused()) return wait();
          blink(wait);
        }, BLINK.doubleGapMs - BLINK_MS);
      });
    }, step.gapMs);
  };
  wait();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    el.removeAttribute('data-blinking');
  };
}
