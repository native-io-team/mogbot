import { useEffect, useState } from 'react';
import { appActivity, onAppActivity } from '../lib/appActivity';

/**
 * One clock per interval, app-wide, ticking on the interval's wall-clock
 * boundary: six working rows in the sidebar (each "· 5m") wake the app once
 * every five seconds between them, in one render, not six times at six
 * phases. Like `usePolling`, it holds while the window is hidden and catches
 * up when it is seen again.
 */
interface Clock {
  subscribers: Set<(now: number) => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const clocks = new Map<number, Clock>();
let unlistenActivity: (() => void) | null = null;

function arm(intervalMs: number, clock: Clock) {
  if (clock.timer !== null || clock.subscribers.size === 0 || appActivity().hidden) return;
  clock.timer = setTimeout(
    () => {
      clock.timer = null;
      tick(clock);
      arm(intervalMs, clock);
    },
    intervalMs - (Date.now() % intervalMs)
  );
}

function tick(clock: Clock) {
  const now = Date.now();
  for (const subscriber of [...clock.subscribers]) subscriber(now);
}

function followActivity() {
  if (unlistenActivity) return;
  unlistenActivity = onAppActivity(({ hidden }) => {
    for (const [intervalMs, clock] of clocks) {
      if (hidden) {
        if (clock.timer !== null) clearTimeout(clock.timer);
        clock.timer = null;
      } else if (clock.timer === null && clock.subscribers.size > 0) {
        // Seen again: what it says is brought up to date now, then on the beat.
        tick(clock);
        arm(intervalMs, clock);
      }
    }
  });
}

function subscribe(intervalMs: number, subscriber: (now: number) => void): () => void {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { subscribers: new Set(), timer: null };
    clocks.set(intervalMs, clock);
  }
  clock.subscribers.add(subscriber);
  followActivity();
  arm(intervalMs, clock);
  const mine = clock;
  return () => {
    mine.subscribers.delete(subscriber);
    if (mine.subscribers.size > 0) return;
    if (mine.timer !== null) clearTimeout(mine.timer);
    clocks.delete(intervalMs);
    if (clocks.size === 0) {
      unlistenActivity?.();
      unlistenActivity = null;
    }
  };
}

/** Older than this when a clock starts, the time held is read again at once. */
const STALE_MS = 250;

/** The time held, refreshed if it is stale (a hook re-enabled after a while). */
function catchUp(setNow: (update: (held: number) => number) => void) {
  setNow((held) => (Date.now() - held >= STALE_MS ? Date.now() : held));
}

/**
 * The time now, refreshed every `intervalMs` while `enabled`: for a live
 * timer ("Running the tests · 5:32") that should tick without anything else
 * changing. Stops when disabled or unmounted.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Turned on after a while off: start from now, not from when it stopped.
    const unsubscribe = subscribe(intervalMs, setNow);
    catchUp(setNow);
    return unsubscribe;
  }, [enabled, intervalMs]);
  return now;
}

/** Tests only: how many clocks have a timer waiting. */
export function __armedClocks(): number {
  let n = 0;
  for (const clock of clocks.values()) if (clock.timer !== null) n++;
  return n;
}
