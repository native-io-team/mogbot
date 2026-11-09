/**
 * Which rows arrived while a list was on screen, so only they rise in
 * (`ARRIVE` in theme.ts). The desk's `useArrivals` / `useNewKeys`, for the
 * phone: what was there when the list first loaded holds still, history
 * loaded later (older pages, at the far end) joins it quietly, and a batch
 * too big to be news (a refresh after a long time away) counts as a load.
 * Kept apart from the rows so it can be tested without a renderer.
 */

import { useMemo, useRef } from 'react';

/** More new rows than this in one update is a load, not an arrival. */
export const MAX_ARRIVALS = 3;

export interface ArrivalState {
  seen: Set<string> | null;
  arrived: Set<string>;
}

export const emptyArrivals = (): ArrivalState => ({ seen: null, arrived: new Set() });

/**
 * Fold the list as it is now into what has been seen. `keys` are newest
 * first when `newestFirst` (an inverted chat), so only keys ahead of the
 * newest one already seen are arrivals; in a list whose order means nothing
 * (`newestFirst: false`), any unseen key is.
 */
export function noteArrivals(
  state: ArrivalState,
  keys: readonly string[],
  newestFirst: boolean
): ArrivalState {
  if (!state.seen) return { seen: new Set(keys), arrived: state.arrived };
  const seen = state.seen;
  const fresh: string[] = [];
  const firstSeen = newestFirst ? keys.findIndex((k) => seen.has(k)) : keys.length;
  for (let i = 0; i < (firstSeen < 0 ? 0 : firstSeen); i++) {
    if (!seen.has(keys[i])) fresh.push(keys[i]);
  }
  const next = new Set(seen);
  for (const k of keys) next.add(k);
  if (fresh.length === 0 || fresh.length > MAX_ARRIVALS)
    return { seen: next, arrived: state.arrived };
  const arrived = new Set(state.arrived);
  for (const k of fresh) arrived.add(k);
  return { seen: next, arrived };
}

/**
 * The keys that arrived since `ready` first held. Stable per key: once a row
 * arrived it stays "arrived", so its wrapper never changes under it.
 */
export function useArrivedKeys(
  keys: readonly string[],
  ready: boolean,
  newestFirst = true
): ReadonlySet<string> {
  const state = useRef<ArrivalState>(emptyArrivals());
  return useMemo(() => {
    if (ready) state.current = noteArrivals(state.current, keys, newestFirst);
    return state.current.arrived;
  }, [keys, ready, newestFirst]);
}
