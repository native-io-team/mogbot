/**
 * The eyes' squash on the phone (`avatarBlink.ts` plays the schedule): the
 * spec's `BLINK.closedScale`, as a worklet the UI thread reads. Pure, so a
 * test runs it as the UI runtime does.
 */

import { BLINK } from '@shipstudio/companion-protocol';

const closedScale: number = BLINK.closedScale;

/**
 * How tall the eyes are at `closed` (0 open, 1 shut): the scale for the
 * layer they are drawn on. Pure and worklet-safe.
 */
export function eyeScaleY(closed: number): number {
  'worklet';
  const c = Math.min(1, Math.max(0, closed));
  return 1 - c * (1 - closedScale);
}
