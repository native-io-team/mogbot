/**
 * What is typed in a chat's composer, per agent (or room), held outside React
 * so a keystroke re-renders only what reads it: the composer and the bar that
 * looks for a key in it, never the chat around them (a 5,000-line chat
 * re-rendered its whole frame per key while the draft was the chat's state).
 *
 * The text itself lives in `chatRestore` (memory for the window's life, and
 * localStorage for the next launch); this adds who to tell when it changes.
 *
 * @module lib/composerDraft
 */

import { useCallback, useSyncExternalStore } from 'react';
import { keepDraft, unsentDraft } from './chatRestore';

const listeners = new Map<string, Set<() => void>>();

/** What is typed in `key`'s composer now, or ''. */
export function composerDraft(key: string): string {
  return unsentDraft(key);
}

/** Replace `key`'s draft (empty forgets it) and tell whoever shows it. */
export function setComposerDraft(key: string, text: string) {
  if (unsentDraft(key) === text) return;
  keepDraft(key, text);
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** `key`'s draft, re-rendering the caller (only) when it changes. */
export function useComposerDraft(key: string): string {
  const sub = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  const get = useCallback(() => unsentDraft(key), [key]);
  return useSyncExternalStore(sub, get, get);
}
