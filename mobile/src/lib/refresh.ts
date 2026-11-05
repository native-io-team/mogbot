/**
 * Pull to refresh that always lets go.
 *
 * Every list with a `RefreshControl` uses this rather than its own
 * `useState(false)` pair. The owner saw the agents list "janky and stays
 * scrolled up" after a pull on a real iPhone; these are the causes it rules
 * out (not yet confirmed on a device which one it was):
 *
 * - **One refresh at a time.** A second pull while one is in flight joins
 *   it instead of starting another (and flipping `refreshing` under it).
 * - **It always ends.** `refreshing` goes back to false when the work
 *   settles, failed or not, and a refresh that never answers is let go
 *   after [`REFRESH_TIMEOUT_MS`]: the spinner never outlives the request.
 * - **Never shorter than the pull's own animation.** UIKit's
 *   `endRefreshing` before `beginRefreshing` has finished animating (a
 *   refresh that answers from a warm link in a few ms) leaves the list
 *   offset by the spinner's height, held there under the large title. So
 *   the spinner is held for
 *   [`MIN_REFRESH_MS`] from the pull, and no longer.
 * - **Nothing after unmount.** Leaving the screen mid-refresh sets no state.
 *
 * Keep the `RefreshControl` mounted for the screen's life (pass `onRefresh`
 * even while offline: it just lets go). Unmounting one while it's refreshing
 * is the other way to leave the inset behind.
 *
 * @module lib/refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** UIRefreshControl's begin animation, with a little margin. */
export const MIN_REFRESH_MS = 450;
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
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() => latest.current())
      .catch(() => {});
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFRESH_TIMEOUT_MS);
    });
    const done = Promise.race([work, timeout])
      .then(() => {
        clearTimeout(timer);
        const left = MIN_REFRESH_MS - (Date.now() - started);
        return left > 0 ? new Promise<void>((r) => setTimeout(r, left)) : undefined;
      })
      .then(() => {
        inFlight.current = null;
        if (mounted.current) setRefreshing(false);
      });
    inFlight.current = done;
    return done;
  }, []);

  return { refreshing, onRefresh };
}
