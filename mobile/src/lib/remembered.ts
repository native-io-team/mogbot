/**
 * What a sheet last read from the Mac, kept for the rest of the app's run, so
 * opening it again draws that at once and the read only refreshes it. The
 * agent sheet's "What it can do" and "What it can reach" used to arrive a
 * beat after the sheet, pushing Routines down under the thumb; Memory,
 * Instructions and Files opened on a spinner every time.
 *
 * Only what the Mac itself answered is kept, never a guess, and it is
 * scoped to the paired Mac (`serverId`): a phone paired to another Mac
 * never sees this one's. In memory only: nothing here is written to disk,
 * and it is gone when the app is.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './store';

/** Enough for every sheet of a large team, small enough never to matter. */
const KEEP = 96;
const kept = new Map<string, unknown>();

/** The last answer kept for `key` (already scoped to its Mac), if any. */
export function recall<T>(k: string): T | null {
  return kept.has(k) ? (kept.get(k) as T) : null;
}

/** Keeps `value` as the last answer for `key` (`null` forgets it). */
export function remember<T>(k: string, value: T | null): void {
  kept.delete(k);
  if (value === null) return;
  kept.set(k, value);
  // The oldest goes first: a Map iterates in insertion order.
  while (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
}

/** Forgets everything (unpairing, and tests). */
export function forgetRemembered(): void {
  kept.clear();
}

/**
 * `useState` that starts from the last answer for `name` on the paired Mac
 * and keeps each new one. Another name (another agent), or another Mac,
 * starts from its own.
 */
export function useRemembered<T>(name: string): [T | null, (value: T | null) => void] {
  const mac = useApp((s) => s.credentials?.serverId ?? '-');
  const key = `${mac}:${name}`;
  const [state, setState] = useState<{ key: string; value: T | null }>(() => ({
    key,
    value: recall<T>(key),
  }));
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    if (state.key !== key) setState({ key, value: recall<T>(key) });
  }, [key, state.key]);
  const set = useCallback((value: T | null) => {
    remember(keyRef.current, value);
    setState({ key: keyRef.current, value });
  }, []);
  return [state.key === key ? state.value : recall<T>(key), set];
}
