/**
 * A live status line that doesn't flicker, as a pure rule both apps share.
 * Each platform wraps it in its own `useSteadyLine` hook (the phone's
 * `lib/steady.ts`, the desk's `hooks/useSteadyLine.ts`), so a row on either
 * says "Reading" → "Running the tests" at the same pace.
 */

/** How long a shown line stays before the next one may replace it. */
export const STEADY_HOLD_MS = 1800;
/** A bare "Thinking" between steps must last this long before it shows. */
export const THINKING_GRACE_MS = 2500;

/**
 * Decide what to show, given what is shown, what just arrived, and when the
 * shown line went up. Pure, so the timing rules are testable:
 * - a new line waits until the shown one has had its hold;
 * - "Thinking" (the gap between two steps) waits for its grace, so a step,
 *   a blink of "Thinking" and the next step read as step → step.
 * Returns the line to show now and, if not yet, how long until it may.
 */
export function steadyNext(
  shown: string,
  incoming: string,
  shownAt: number,
  now: number
): { show: string; waitMs: number } {
  if (incoming === shown) return { show: shown, waitMs: 0 };
  const hold = incoming === 'Thinking' && shown !== '' ? THINKING_GRACE_MS : STEADY_HOLD_MS;
  const left = shownAt + hold - now;
  return left <= 0 ? { show: incoming, waitMs: 0 } : { show: shown, waitMs: left };
}
