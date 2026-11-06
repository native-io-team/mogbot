/**
 * Pull to refresh that always lets go.
 *
 * Every list with a `RefreshControl` uses this rather than its own
 * `useState(false)` pair:
 *
 * - **One refresh at a time.** A second pull while one is in flight joins
 *   it instead of starting another (and flipping `refreshing` under it).
 * - **It always ends.** `refreshing` goes back to false when the work
 *   settles, failed or not, and a refresh that never answers is let go
 *   after [`REFRESH_TIMEOUT_MS`]: the spinner never outlives the request.
 * - **Nothing after unmount.** Leaving the screen mid-refresh sets no state.
 *
 * There is no minimum spin any more. The jank it was guessing at was the
 * opaque large-title bar (see `largeTitle` in lib/navigation, where the cause
 * and how it was recorded are written down); with the list running under a
 * translucent bar UIKit animates the spinner away whenever it ends, as Mail
 * does.
 *
 * Keep the `RefreshControl` mounted for the screen's life (pass `onRefresh`
 * even while offline: it just lets go).
 *
 * - **It says how it went.** `outcome` is `done` for [`REFRESH_DONE_MS`]
 *   after a refresh that worked, then `idle` again; `failed` after one that
 *   threw or never answered, until it's dismissed or tried again.
 *   `components/RefreshStatus` turns that into the line under the spinner.
 *   So `run` must reject when it didn't reach the Mac (offline included).
 *
 * @module lib/refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** No refresh holds the spinner longer than this. */
export const REFRESH_TIMEOUT_MS = 15_000;

/** How long "Up to date" stays before it folds away. */
export const REFRESH_DONE_MS = 1_500;

export type RefreshOutcome = 'idle' | 'done' | 'failed';

/**
 * `run` is the refresh; it may reject (the screen reports its own error).
 * Returns the two props a `RefreshControl` needs.
 */
export function useRefresh(run: () => Promise<unknown> | void) {
  const [refreshing, setRefreshing] = useState(false);
  const [outcome, setOutcome] = useState<RefreshOutcome>('idle');
  const inFlight = useRef<Promise<void> | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(settle.current);
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    clearTimeout(settle.current);
    setOutcome('idle');
    setRefreshing(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() => latest.current())
      .then(
        () => 'done' as const,
        () => 'failed' as const
      );
    const timeout = new Promise<'failed'>((resolve) => {
      timer = setTimeout(() => resolve('failed'), REFRESH_TIMEOUT_MS);
    });
    const done = Promise.race([work, timeout]).then((result) => {
      clearTimeout(timer);
      inFlight.current = null;
      if (!mounted.current) return;
      setRefreshing(false);
      setOutcome(result);
      if (result === 'done') {
        settle.current = setTimeout(() => {
          if (mounted.current) setOutcome('idle');
        }, REFRESH_DONE_MS);
      }
    });
    inFlight.current = done;
    return done;
  }, []);

  const dismiss = useCallback(() => {
    clearTimeout(settle.current);
    setOutcome('idle');
  }, []);

  return { refreshing, onRefresh, outcome, dismiss };
}
