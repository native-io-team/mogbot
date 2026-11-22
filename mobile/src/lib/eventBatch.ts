/**
 * What the Mac says, applied together instead of line by line.
 *
 * Every event used to be its own store update, and each store update is a
 * whole synchronous render of whatever it touches. A phone opened after three
 * hours away is sent everything the team said meanwhile (about 1,180 lines for
 * a 42-agent team), so opening it was 1,180 renders back to back, with every
 * tap waiting behind them: 16 s frozen, measured on a simulator.
 *
 * - **Catching up is one update.** From `hold()` (a welcome) to `release()`
 *   (caught up), events are kept and then applied in one go. A slow link
 *   still shows progress: at most `HOLD_MS` apart.
 * - **Live is a steady beat.** The first event after a quiet moment is applied
 *   at once; the ones right behind it wait for the beat, `BEAT_MS` later. Twenty
 *   agents working is at most a dozen updates a second, not one per event.
 * - **Never behind an answer.** The Mac sends what a request caused before its
 *   answer, so whoever handles an answer calls `flush()` first.
 * - **Never on a timer that won't fire.** Put away (`away`), each live event is
 *   applied as it comes: Android runs no JavaScript timers then
 *   (`JavaTimerManager.onHostPause`).
 * - **Never a way out for an error.** It's applied from timers and from other
 *   requests' answers, so what `apply` throws goes to `onError`.
 *
 * Pure apart from the clock and timers, so it's tested without a socket.
 */

export const BEAT_MS = 90;
export const HOLD_MS = 1500;

export interface EventBatch<E> {
  add(event: E): void;
  /** Applies what's waiting, now. */
  flush(): void;
  /** Catching up: keep events until `release` (or `HOLD_MS`). */
  hold(): void;
  /** Caught up: apply them, and go back to the beat. */
  release(): void;
  /** Drops what's waiting (another Mac). */
  clear(): void;
}

export interface EventBatchOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Lets one through at once when nothing was applied within the beat (off in tests that count). */
  beatMs?: number;
  holdMs?: number;
  /** The app is in the background: nothing waits for the beat. */
  away?: () => boolean;
  /** What `apply` threw. */
  onError?: (error: unknown) => void;
}

export function createEventBatch<E>(
  apply: (events: E[]) => void,
  opts: EventBatchOptions = {}
): EventBatch<E> {
  const now = opts.now ?? Date.now;
  const beat = opts.beatMs ?? BEAT_MS;
  const longest = opts.holdMs ?? HOLD_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let waiting: E[] = [];
  let timer: unknown = null;
  let holding = false;
  let appliedAt = -Infinity;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function flush() {
    stop();
    if (waiting.length === 0) return;
    const events = waiting;
    waiting = [];
    try {
      apply(events);
    } catch (e) {
      opts.onError?.(e);
    }
    // After, not before: the beat is the quiet between updates, however long one took.
    appliedAt = now();
  }

  function arm(ms: number) {
    timer ??= setTimer(() => {
      timer = null;
      flush();
    }, ms);
  }

  return {
    add(event) {
      waiting.push(event);
      if (holding) return arm(longest);
      if (opts.away?.()) return flush();
      const since = now() - appliedAt;
      if (since >= beat || since < 0) return flush();
      arm(beat - since);
    },
    flush,
    hold() {
      flush();
      holding = true;
    },
    release() {
      holding = false;
      flush();
    },
    clear() {
      stop();
      waiting = [];
      holding = false;
    },
  };
}
