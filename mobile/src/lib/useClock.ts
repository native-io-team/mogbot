/**
 * The time, ticking only while something on screen counts it (a working
 * row's elapsed time, the live step's timer).
 *
 * One clock for the app: every row used to keep its own one-second timer, so
 * a team at work was thirty separate renders a second, and it kept ticking
 * under a pushed chat and on the other tabs. Now they all hear the same tick
 * (one render), a screen nobody sees hears none, and a row that asks with
 * `useClockText` re-renders only when its words come out different.
 */

import { useState, useSyncExternalStore } from 'react';
import { useShowing } from './moving';

const EVERY_MS = 1_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let shared = Date.now();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) {
    shared = Date.now();
    timer = setInterval(() => {
      shared = Date.now();
      for (const heard of [...listeners]) heard();
    }, EVERY_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = null;
  };
}

const never = () => () => {};

/** One reader's own reading: moved on only while it counts, so it stops at its last. */
function reading() {
  let at = Date.now();
  return (counting: boolean) => {
    if (counting) at = Math.max(at, shared);
    return at;
  };
}

/** What `read` makes of the time: re-read every second while `active` and on screen. */
export function useClockText<T extends string | number | null>(
  active: boolean,
  read: (now: number) => T
): T {
  const [own] = useState(reading);
  const ticking = useShowing() && active;
  return useSyncExternalStore(ticking ? subscribe : never, () => read(own(active)));
}

/** The time itself. `active` false keeps its last reading. */
export const useClock = (active: boolean): number => useClockText(active, same);
const same = (now: number) => now;
