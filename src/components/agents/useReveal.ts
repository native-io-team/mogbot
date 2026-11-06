/**
 * The pace a streaming reply is shown at: the phone's (`mobile/src/lib/reveal.ts`),
 * on the desk. Text arrives from the Mac every 40 ms, a few words at a time;
 * shown as it lands, the reply grew in visible steps. This spreads each
 * arrival over the frames until the next one, so it flows.
 *
 * @module components/agents/useReveal
 */

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from './useAgentMotion';

/**
 * How far each reply has been revealed, by message id. It outlives the bubble's
 * contents: when the finished message replaces its draft (same id) the reveal
 * carries on from here instead of snapping to the end. Bounded; only replies
 * still being written matter.
 */
const revealed = new Map<string, number>();
const REVEALED_KEPT = 50;

/** Never slower than this (characters per second), even with nothing queued. */
export const REVEAL_MIN_RATE = 45;
/** Whatever is queued is shown over about this long: steady, never far behind. */
export const REVEAL_CATCH_UP_MS = 260;

/** Whether a reply with this id is part-way through its reveal. */
export function isRevealing(id: string): boolean {
  return revealed.has(id);
}

function remember(id: string, count: number) {
  revealed.delete(id);
  revealed.set(id, count);
  if (revealed.size > REVEALED_KEPT) revealed.delete(revealed.keys().next().value as string);
}

/**
 * How many more characters to show after `dt` ms, with `queued` waiting and
 * `carry` (a fraction of a character) left from the last frame.
 */
export function revealStep(
  queued: number,
  dt: number,
  carry: number
): { n: number; carry: number } {
  const total = carry + Math.max((REVEAL_MIN_RATE * dt) / 1000, (queued * dt) / REVEAL_CATCH_UP_MS);
  const n = Math.min(queued, Math.floor(total));
  return { n, carry: total - Math.floor(total) };
}

/**
 * Follows `target` one display frame at a time. Anything that isn't an
 * append (a restart, a final text that differs) keeps what both share and
 * reveals the rest. Under reduced motion the text is shown as it arrives.
 */
export function useReveal(id: string, target: string, streaming: boolean): string {
  const [state, setState] = useState(() => ({
    target,
    count: Math.min(revealed.get(id) ?? (streaming ? 0 : target.length), target.length),
  }));
  const instant = prefersReducedMotion();
  let count = instant ? target.length : Math.min(state.count, target.length);
  if (!instant && state.target !== target) {
    // React's derived-state pattern: adjusted here, before this render commits.
    if (!target.startsWith(state.target.slice(0, count))) {
      count = sharedPrefix(state.target, target, count);
    }
    setState({ target, count });
  }

  useEffect(() => {
    let shown = count;
    if (shown >= target.length) {
      if (streaming) remember(id, shown);
      else revealed.delete(id);
      return;
    }
    let frame = 0;
    let last = 0;
    let carry = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(50, now - last) : 16;
      last = now;
      const step = revealStep(target.length - shown, dt, carry);
      carry = step.carry;
      if (step.n > 0) {
        shown += step.n;
        remember(id, shown);
        setState({ target, count: shown });
      }
      if (shown < target.length) frame = requestAnimationFrame(tick);
      else if (!streaming) revealed.delete(id);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The loop owns `count` from here; following it would restart the loop every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, id, streaming]);

  return target.slice(0, count);
}

function sharedPrefix(a: string, b: string, max: number) {
  let i = 0;
  while (i < max && i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
