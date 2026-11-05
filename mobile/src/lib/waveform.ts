/**
 * The dictation waveform's numbers (`components/Waveform.tsx`). Pure and,
 * where the UI thread runs them, worklet-safe, so a test holds them.
 *
 * The recognizer reports the microphone's loudness as a "volume" from -2 to
 * 10 (expo-speech-recognition: on iOS the tap's power, -60..0 dB, scaled onto
 * that range; on Android the recognizer's own rmsdB). `levelFromVolume`
 * turns that into 0..1 for the bars: room noise below the floor is silence,
 * a raised voice is full height, and the curve between favours quiet speech
 * so a soft voice still moves the bars.
 *
 * On the UI thread a frame clock eases the level (quick to rise, slower to
 * fall, the way a VU needle moves) and pushes it into the history every
 * `WAVE_SAMPLE_MS`. The strip slides left continuously between pushes, so it
 * scrolls at 60fps however unevenly the volume events arrive on the JS thread.
 */

export const VOLUME_MIN = -2;
export const VOLUME_MAX = 10;
/** Quieter than this is the room, not a voice. */
export const LEVEL_FLOOR_DB = -50;
/** Louder than this is full height. */
export const LEVEL_CEIL_DB = -12;
/** Below 1, quiet speech is lifted: perceived loudness isn't linear in dB. */
export const LEVEL_CURVE = 0.8;
/** How often the recognizer reports the level. */
export const LEVEL_INTERVAL_MS = 50;
/** A new bar enters at the right this often: 12 bars hold about 0.85 s. */
export const WAVE_SAMPLE_MS = 70;
/** Rising takes about this long to catch up with the voice, falling this. */
export const ATTACK_MS = 35;
export const RELEASE_MS = 140;
/** Reduce Motion's meter moves slowly, both ways. */
export const CALM_MS = 260;

/** The recognizer's volume (-2..10) as a bar level, 0..1. */
export function levelFromVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  const db = ((volume - VOLUME_MIN) / (VOLUME_MAX - VOLUME_MIN)) * 60 - 60;
  const x = (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.pow(x, LEVEL_CURVE);
}

/** One frame of easing from `current` toward `target`, independent of frame rate. */
export function easeLevel(
  current: number,
  target: number,
  dtMs: number,
  // No defaults: a worklet doesn't capture a module constant named in its parameters.
  rise: number,
  fall: number
): number {
  'worklet';
  const tau = target > current ? rise : fall;
  const dt = Math.min(Math.max(dtMs, 0), 100);
  const k = 1 - Math.exp(-dt / tau);
  const next = current + (target - current) * k;
  // Settle exactly: a level that never quite reaches 0 keeps a bar a hair tall.
  return Math.abs(next - target) < 0.001 ? target : next;
}

/** A bar's height for a level: a dot at silence, `max` at full voice. */
export function barHeight(level: number, min: number, max: number): number {
  'worklet';
  const l = level <= 0 ? 0 : level >= 1 ? 1 : level;
  return min + (max - min) * l;
}

/** A bar's opacity at `x` points from the strip's left edge: it fades in over `fade`. */
export function barOpacity(x: number, fade: number): number {
  'worklet';
  if (fade <= 0 || x >= fade) return 1;
  if (x <= 0) return 0;
  return x / fade;
}

/** History after one push: the oldest bar leaves at the left, `level` enters at the right. */
export function pushLevel(history: number[], level: number): number[] {
  'worklet';
  const next = history.slice(1);
  next.push(level);
  return next;
}

/** "0:07", "1:02", "12:30": the time spent listening. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
