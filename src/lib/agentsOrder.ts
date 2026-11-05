/**
 * The sidebar's order: by attention. Pinned agents stay on top; then, within
 * each, the agents waiting on you, then the ones working, then the rest by
 * recent activity.
 *
 * And a stability rule, because an order by attention changes all the time: a
 * row must not move under the pointer, or while you scroll or read the list.
 * While the list is in use only new agents are added (at the end) and gone
 * ones dropped; everything else keeps its place until the list is left alone
 * (see `useAttentionOrder`). A pin is the exception: you asked for that move.
 *
 * @module lib/agentsOrder
 */

import { needsAttention, type Agent } from './agents';

/** 0 waiting on you, 1 working, 2 everything else. */
export function attentionRank(agent: Agent): number {
  if (needsAttention(agent)) return 0;
  if (agent.status.state === 'working') return 1;
  return 2;
}

/** Pinned first, then by attention, then most recent activity; ties by id, so the order is total. */
export function sortByAttention(agents: readonly Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const rank = attentionRank(a) - attentionRank(b);
    if (rank !== 0) return rank;
    if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Which agents are pinned, as one comparable string. */
export function pinKey(agents: readonly Agent[]): string {
  return agents
    .filter((a) => a.pinned)
    .map((a) => a.id)
    .sort()
    .join(' ');
}

/**
 * The order to show. `settled` means nobody is using the list, so it may be
 * re-sorted; otherwise the previous order holds, minus agents that are gone,
 * plus new ones after it in attention order.
 */
export function stableOrder(
  prev: readonly string[],
  agents: readonly Agent[],
  settled: boolean
): string[] {
  const sorted = sortByAttention(agents).map((a) => a.id);
  if (settled || prev.length === 0) return sorted;
  const present = new Set(sorted);
  const kept = prev.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...sorted.filter((id) => !known.has(id))];
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
