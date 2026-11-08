/**
 * The typing key's press (`components/AgentKey.tsx`), the desk's numbers
 * (`TYPING_KEY` in the shared spec; `agents-key-press` and `agents-key-drop`
 * in agents-work.css): a tap, a lighter tap, each with a small rebound, then
 * a rest. One shared clock goes 0 → 1 every period and these read the depth
 * and the drop off it, so nothing is scheduled per tap. Pure and
 * worklet-safe: the UI thread runs them, and a test runs them as the UI
 * runtime does.
 */

import { TYPING_KEY } from '@shipstudio/companion-protocol';

export const TYPING_KEY_PERIOD_MS = TYPING_KEY.ms;

// The keyframes as plain numbers, so the worklets close over values only.
const TIMES: number[] = TYPING_KEY.press.map((k) => k[0]);
const DEPTHS: number[] = TYPING_KEY.press.map((k) => k[1]);
const PRESSED_DROP: number = TYPING_KEY.pressedDrop;

/**
 * How far the top is pressed, as a fraction of the key's travel (above 0 is
 * down, below 0 the rebound), when the clock reads `progress`. Each segment
 * eases in and out, as the desk's keyframes do.
 */
export function keyDepth(progress: number): number {
  'worklet';
  const p = progress - Math.floor(progress);
  for (let i = 1; i < TIMES.length; i++) {
    if (p <= TIMES[i]) {
      const span = TIMES[i] - TIMES[i - 1];
      const u = span > 0 ? (p - TIMES[i - 1]) / span : 1;
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return DEPTHS[i - 1] + (DEPTHS[i] - DEPTHS[i - 1]) * eased;
    }
  }
  return DEPTHS[DEPTHS.length - 1];
}

/**
 * The drop's opacity (a share of the paint's `shadow`) at a press `depth`:
 * whole at rest and on the rebound, `TYPING_KEY.pressedDrop` fully down, so
 * the shadow tightens under the key as it goes down.
 */
export function keyDrop(depth: number): number {
  'worklet';
  const d = Math.min(1, Math.max(0, depth));
  return 1 - (1 - PRESSED_DROP) * d;
}
