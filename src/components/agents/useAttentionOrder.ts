/**
 * The sidebar's agents in attention order (`lib/agentsOrder`), held still
 * while the list is in use: the pointer is over it, or it was scrolled,
 * clicked or keyed through less than two seconds ago. The list re-sorts once
 * it has been left alone that long, and when the window comes back to the
 * front. Pinning or unpinning re-sorts at once.
 *
 * @module components/agents/useAttentionOrder
 */

import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Agent } from '../../lib/agents';
import { pinKey, sameOrder, stableOrder } from '../../lib/agentsOrder';

/** How long the list must be left alone before it re-sorts. */
export const SETTLE_MS = 2000;

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
  const busy = useListBusy(listRef);
  const pins = pinKey(agents);
  const [held, setHeld] = useState<{ order: string[]; pins: string }>({ order: [], pins });
  const next = stableOrder(held.order, agents, !busy || pins !== held.pins);
  // Derived state, updated during render (React's pattern for it): the order
  // shown is the order remembered for the next change.
  if (!sameOrder(next, held.order) || pins !== held.pins) setHeld({ order: next, pins });
  return useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    return next.flatMap((id) => byId.get(id) ?? []);
    // `next` is a fresh array each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, next.join(' ')]);
}
