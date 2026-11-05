/**
 * The typing dots' wave (`components/TypingDots.tsx`), the desktop's numbers
 * (`--typing-dots-*`, src/styles/components/typing-dots.css): three dots, one
 * clock. Pure and worklet-safe, so the UI thread runs it and a test holds it.
 *
 * One shared progress value goes 0 → 1 every period; each dot reads it
 * shifted by an equal fraction. Nothing per dot is scheduled (no withDelay,
 * no per-dot withRepeat), so the dots can't start late, drift apart or stop
 * one at a time: they are always the same wave at three offsets.
 */

/** One full cycle: the desktop's `--duration-loader-standard`. */
export const TYPING_PERIOD_MS = 1200;
export const TYPING_DOTS = 3;
/** Each dot trails the one before it by this fraction of the period (200 ms). */
export const TYPING_STAGGER = 1 / 6;
/** The rise and fall takes this much of each dot's cycle; it rests for the rest. */
export const TYPING_ACTIVE = 0.5;
/** Opacity at rest and at the crest; a still dot (Reduce Motion) sits between. */
export const TYPING_REST_OPACITY = 0.3;
export const TYPING_STILL_OPACITY = 0.6;

/** Where dot `index` is in its own cycle, 0..1, when the shared clock reads `progress`. */
export function dotPhase(progress: number, index: number): number {
  'worklet';
  const p = progress - index * TYPING_STAGGER;
  return p - Math.floor(p);
}

/**
 * How raised a dot is, 0..1: a raised cosine over the active part of its
 * cycle (smooth at both ends, like ease-in-out), then flat.
 */
export function dotLevel(phase: number): number {
  'worklet';
  if (phase >= TYPING_ACTIVE) return 0;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / TYPING_ACTIVE);
}

/** A dot's opacity for a level. */
export function dotOpacity(level: number): number {
  'worklet';
  return TYPING_REST_OPACITY + (1 - TYPING_REST_OPACITY) * level;
}
