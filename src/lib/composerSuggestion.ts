/**
 * What the user might say next to an agent, per agent: Claude Code's guess
 * after a turn the user started (`--prompt-suggestions`), sent on
 * `agents://suggestion`. The composer shows it in place of its placeholder
 * while it's empty; Tab takes it in, Enter then sends it.
 *
 * Held for the window's life only: a guess from before a restart is stale.
 *
 * @module lib/composerSuggestion
 */

import { useCallback, useSyncExternalStore } from 'react';

const suggestions = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

/** `agentId`'s suggestion now, or null. */
export function composerSuggestion(agentId: string): string | null {
  return suggestions.get(agentId) ?? null;
}

/** Offer `text` in `agentId`'s composer; null (or blank) takes it away. */
export function setComposerSuggestion(agentId: string, text: string | null) {
  const next = text?.trim() || null;
  if ((suggestions.get(agentId) ?? null) === next) return;
  if (next) suggestions.set(agentId, next);
  else suggestions.delete(agentId);
  for (const listener of listeners.get(agentId) ?? []) listener();
}

function subscribe(agentId: string, listener: () => void) {
  let set = listeners.get(agentId);
  if (!set) listeners.set(agentId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(agentId);
  };
}

/** `agentId`'s suggestion, re-rendering the caller (only) when it changes. */
export function useComposerSuggestion(agentId: string): string | null {
  const sub = useCallback((listener: () => void) => subscribe(agentId, listener), [agentId]);
  const get = useCallback(() => composerSuggestion(agentId), [agentId]);
  return useSyncExternalStore(sub, get, get);
}

/** The event's payload, if it's one: `{ agentId, text }`, text a string or null. */
export function readableSuggestion(v: unknown): v is { agentId: string; text: string | null } {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.agentId === 'string' && (typeof r.text === 'string' || r.text === null);
}
