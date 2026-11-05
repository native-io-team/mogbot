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
 * @module lib/refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** No refresh holds the spinner longer than this. */
export const REFRESH_TIMEOUT_MS = 15_000;

/**
 * `run` is the refresh; it may reject (the screen reports its own error).
 * Returns the two props a `RefreshControl` needs.
 */
export function useRefresh(run: () => Promise<unknown> | void) {
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    setRefreshing(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() => latest.current())
      .catch(() => {});
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFRESH_TIMEOUT_MS);
    });
    const done = Promise.race([work, timeout]).then(() => {
      clearTimeout(timer);
      inFlight.current = null;
      if (mounted.current) setRefreshing(false);
    });
    inFlight.current = done;
    return done;
  }, []);

  return { refreshing, onRefresh };
}
