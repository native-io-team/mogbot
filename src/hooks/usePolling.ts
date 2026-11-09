import { useEffect, useLayoutEffect, useRef } from 'react';
import { ExponentialPoller } from '../lib/polling';
import { appActivity, onAppActivity } from '../lib/appActivity';

interface UsePollingOptions {
  /** Polling interval in ms. Defaults to 3000. */
  intervalMs?: number;
  /** Upper bound for exponential backoff. Defaults to 10× intervalMs. */
  maxIntervalMs?: number;
  /** Whether polling is active. Flipping to false stops polling + cleans up. */
  enabled?: boolean;
  /** Optional name for structured logging. */
  name?: string;
  /**
   * Keep polling while the window is hidden. Off by default: a poll that
   * feeds the screen has nothing to do while nobody can see it, so it holds
   * and catches up (on its own cadence) when the window is seen again. Turn
   * this on only for a poll with an effect outside the window (a reminder
   * notification, restarting once agents are done).
   */
  whileHidden?: boolean;
}

/**
 * Poll an async function with exponential backoff. Auto-cleans up on unmount
 * or when `enabled` flips to false. Prefer this over raw setInterval loops —
 * it handles backoff on error, teardown, and logging in one place.
 *
 * Holds while the window is hidden (see `whileHidden`), so nothing polls for
 * a screen nobody can see.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  {
    intervalMs = 3000,
    maxIntervalMs,
    enabled = true,
    name,
    whileHidden = false,
  }: UsePollingOptions = {}
): void {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    const poller = new ExponentialPoller<T>(
      () => fnRef.current(),
      () => {
        /* result handled by fn side-effects; caller can close over state */
      },
      {
        initialInterval: intervalMs,
        maxInterval: maxIntervalMs ?? intervalMs * 10,
        name: name ?? 'usePolling',
      }
    );
    poller.start();
    if (whileHidden) return () => poller.stop();
    const follow = ({ hidden }: { hidden: boolean }) => (hidden ? poller.pause() : poller.resume());
    follow(appActivity());
    const unlisten = onAppActivity(follow);
    return () => {
      unlisten();
      poller.stop();
    };
  }, [enabled, intervalMs, maxIntervalMs, name, whileHidden]);
}
