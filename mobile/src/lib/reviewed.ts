/**
 * Which files of a change card you've marked as reviewed, on this phone:
 * kept per card (agent + message), on disk, so leaving the review or
 * restarting the app keeps your place. The newest cards only; a card past
 * that is one nobody is still reviewing.
 */

import { useSyncExternalStore } from 'react';
import { readJson, writeJson, debounced } from './persist';

const FILE = 'reviewed.json';
/** Cards remembered; the oldest go first. */
const KEEP = 100;

type Store = Record<string, string[]>;
let state: Store = {};
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const keyOf = (agentId: string, messageId: string) => `${agentId}/${messageId}`;

const save = debounced(async () => {
  await writeJson(FILE, state);
}, 300);

/** Read once, the first time a review opens. */
export async function loadReviewed(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const saved = await readJson<Store>(FILE).catch(() => null);
  if (saved && typeof saved === 'object') {
    // Anything ticked before the file came back wins over the file.
    state = { ...saved, ...state };
    emit();
  }
}

/** Tick or untick one file of a card. */
export function setReviewed(agentId: string, messageId: string, path: string, on: boolean) {
  const key = keyOf(agentId, messageId);
  const now = new Set(state[key] ?? []);
  if (on) now.add(path);
  else now.delete(path);
  const next: Store = { ...state };
  delete next[key];
  if (now.size) next[key] = [...now];
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[old];
  state = next;
  emit();
  save.schedule();
}

const NONE: string[] = [];

/** The files of a card marked reviewed. */
export function useReviewed(agentId: string, messageId: string): ReadonlySet<string> {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state[keyOf(agentId, messageId)] ?? NONE
  );
  return useMemoSet(list);
}

const sets = new WeakMap<string[], ReadonlySet<string>>();
function useMemoSet(list: string[]): ReadonlySet<string> {
  let set = sets.get(list);
  if (!set) {
    set = new Set(list);
    sets.set(list, set);
  }
  return set;
}

/** Tests only. */
export function resetReviewedForTests() {
  state = {};
  loaded = false;
}
