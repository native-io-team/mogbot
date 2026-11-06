/**
 * The sidebar's agents in attention order (`lib/agentsOrder`), held still
 * while the list is in use: the pointer is over it, or it was scrolled,
 * clicked or keyed through less than two seconds ago. The list re-sorts once
 * it has been left alone that long, and when the window comes back to the
 * front. Pinning or unpinning re-sorts at once.
 *
 * Left alone, it still re-sorts at most once every `RESORT_MS`: six agents
 * working each bump their recent activity several times a second, and
 * sorting on every one of those kept rows sliding past each other all the
 * time. The "Needs your OK" row above the list moves with the order (it
 * pushes every row under it), so it appears and goes at the same moments.
 *
 * @module components/agents/useAttentionOrder
 */

import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Agent } from '../../lib/agents';
import { pinKey, sameOrder, stableOrder } from '../../lib/agentsOrder';

/** How long the list must be left alone before it re-sorts. */
export const SETTLE_MS = 2000;

/** The least time between two re-sorts the list wasn't asked for. */
export const RESORT_MS = 4000;

// pointermove too: a pointer already resting on the list when it mounts
// never sends pointerenter.
const ACTIVITY = ['wheel', 'scroll', 'pointerdown', 'pointermove', 'keydown', 'focusin'] as const;

/** Whether the list is being used: pointer over it, or touched within `SETTLE_MS`. */
function useListBusy(listRef: RefObject<HTMLElement | null>): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let inside = el.matches(':hover');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!inside) setBusy(false);
    };
    const touched = () => {
      setBusy(true);
      clearTimeout(timer);
      timer = setTimeout(settle, SETTLE_MS);
    };
    const enter = () => {
      inside = true;
      touched();
    };
    const leave = () => {
      inside = false;
      touched();
    };
    // Back from another window: whatever changed meanwhile is news, so sort.
    const focus = () => {
      if (!el.matches(':hover')) {
        inside = false;
        settle();
      }
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    // Capture, so a scroll inside the list (which doesn't bubble) counts too.
    for (const type of ACTIVITY)
      el.addEventListener(type, touched, { capture: true, passive: true });
    window.addEventListener('focus', focus);
    return () => {
      clearTimeout(timer);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      for (const type of ACTIVITY) el.removeEventListener(type, touched, { capture: true });
      window.removeEventListener('focus', focus);
    };
  }, [listRef]);
  return busy;
}

export function useAttentionOrder(
  agents: readonly Agent[],
  listRef: RefObject<HTMLElement | null>
): Agent[] {
  return useSteadyList(agents, listRef, false).agents;
}

/**
 * The order, and whether the "Needs your OK" row is shown (`waiting`, held to
 * the same moments as the order): neither changes while the list is in use,
 * nor more often than every `RESORT_MS`.
 */
export function useSteadyList(
  agents: readonly Agent[],
  listRef: RefObject<HTMLElement | null>,
  waiting: boolean
): { agents: Agent[]; waiting: boolean } {
  const busy = useListBusy(listRef);
  const pins = pinKey(agents);
  const [held, setHeld] = useState<{ order: string[]; pins: string; waiting: boolean }>({
    order: [],
    pins,
    waiting,
  });
  // Just re-sorted: the next one waits until this has had its moment.
  const [cooling, setCooling] = useState(false);
  const settled = !busy && !cooling;
  const next = stableOrder(held.order, agents, settled || pins !== held.pins);
  const shownWaiting = settled ? waiting : held.waiting;
  // Derived state, updated during render (React's pattern for it): the order
  // shown is the order remembered for the next change.
  const moved = !sameOrder(next, held.order) || shownWaiting !== held.waiting;
  if (moved || pins !== held.pins) {
    setHeld({ order: next, pins, waiting: shownWaiting });
    // The first order is just there; a pin was asked for. Anything else starts the wait.
    if (moved && held.order.length > 0 && pins === held.pins && !cooling) setCooling(true);
  }
  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(() => setCooling(false), RESORT_MS);
    return () => clearTimeout(timer);
  }, [cooling]);
  const list = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    return next.flatMap((id) => byId.get(id) ?? []);
    // `next` is a fresh array each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, next.join(' ')]);
  return { agents: list, waiting: shownWaiting };
}
