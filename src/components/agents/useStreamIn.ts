/**
 * The Chief's scripted lines (its greeting, each step of bringing agents
 * over, "what do you want me to do?") type themselves out the first time
 * they're seen, the way a reply streams: a moment of dots, then the words.
 * Shown all at once they read as a canned message nobody reads.
 *
 * Once per message per Mac (remembered in localStorage), only while it's
 * fresh (an hour), never under reduced motion; history never replays.
 *
 * @module components/agents/useStreamIn
 */

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from './useAgentMotion';

const KEY = 'agents.streamedIn';
const KEPT = 200;
/** A scripted line older than this is history: shown as is. */
export const STREAM_IN_FRESH_MS = 60 * 60 * 1000;
/** The dots before the words. */
export const STREAM_IN_TYPING_MS = 650;
/** Characters a second: a quick reply's pace, readable as it lands. */
export const STREAM_IN_RATE = 110;

function streamed(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as string[]) : [];
  } catch {
    return [];
  }
}

function markStreamed(id: string) {
  try {
    const list = streamed().filter((x) => x !== id);
    list.push(id);
    localStorage.setItem(KEY, JSON.stringify(list.slice(-KEPT)));
  } catch {
    // Storage unavailable: it may type out again next launch, no worse.
  }
}

/** Should this scripted line type itself out now? Pure apart from storage. */
export function shouldStreamIn(id: string, ts: number, now = Date.now()): boolean {
  if (now - ts > STREAM_IN_FRESH_MS) return false;
  if (prefersReducedMotion()) return false;
  return !streamed().includes(id);
}

export type StreamIn =
  | { phase: 'typing' }
  | { phase: 'writing'; shown: string }
  | { phase: 'done' };

/** When the line typing out now finishes (performance.now() time). */
let busyUntil = 0;

/** How long a line of `chars` takes to type out, dots included. */
export const streamInMs = (chars: number) => STREAM_IN_TYPING_MS + (chars / STREAM_IN_RATE) * 1000;

/**
 * Drives one line's stream-in; `enabled` is read once, at mount. Lines take
 * turns (a later one waits, showing nothing, until the one above is done);
 * `afterMs` holds one back further.
 */
export function useStreamIn(
  id: string,
  text: string,
  ts: number,
  enabled: boolean,
  afterMs = 0
): StreamIn | { phase: 'waiting' } {
  const [start] = useState(() => {
    if (!enabled || !shouldStreamIn(id, ts)) return null;
    // Lines take turns: one starting while another types waits for it.
    const now = performance.now();
    const begin = Math.max(now + afterMs, busyUntil);
    busyUntil = begin + streamInMs(text.length);
    return begin;
  });
  const [state, setState] = useState<StreamIn | { phase: 'waiting' }>(() =>
    start === null
      ? { phase: 'done' }
      : start > performance.now() + 1
        ? { phase: 'waiting' }
        : { phase: 'typing' }
  );

  useEffect(() => {
    if (start === null) return;
    markStreamed(id);
    let frame = 0;
    const tick = (now: number) => {
      const t = now - start;
      if (t < 0) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (t < STREAM_IN_TYPING_MS) {
        setState((prev) => (prev.phase === 'typing' ? prev : { phase: 'typing' }));
        frame = requestAnimationFrame(tick);
        return;
      }
      const n = Math.floor(((t - STREAM_IN_TYPING_MS) / 1000) * STREAM_IN_RATE);
      if (n >= text.length) {
        setState({ phase: 'done' });
        return;
      }
      // Whole words only, so a word never appears letter by letter mid-line.
      const cut = text.lastIndexOf(' ', n);
      setState({ phase: 'writing', shown: text.slice(0, cut > 0 ? cut : n) });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Runs once: the line it started with is the line it finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
