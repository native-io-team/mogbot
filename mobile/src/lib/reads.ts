/**
 * How the phone asks the Mac things, so a busy phone never piles onto it
 * (docs/mobile.md, "Requests the phone makes"). Every request goes through
 * here (`session.call`):
 *
 * - **One of each read at a time.** A read that's already on its way
 *   (`READ_ONLY_METHODS`, same params) answers the second asker too: two
 *   screens, or a tap back and forth, are one request.
 * - **Never a burst.** At most `READ_SLOTS` reads are at the Mac at once;
 *   the rest wait their turn. Changes never wait.
 * - **Remembered.** The last answer to each read is kept for this Mac:
 *   a screen opening draws it from its first frame (`last`), and one that
 *   wants it no older than a few seconds is answered from it (`fresh`). Any
 *   change (other than where the phone is looking) makes every kept answer
 *   old, so the next fresh read asks again.
 *
 * Pure apart from the clock, so it's tested without a socket.
 */

import { READ_ONLY_METHODS, type MethodName } from '@shipstudio/companion-protocol';

/** At most this many reads at the Mac at once. */
export const READ_SLOTS = 6;

/** Changes that move no reading: where the phone is looking, and a dictation written out again. */
const NEUTRAL = new Set<string>(['agents.focus', 'rooms.focus', 'dictation.transcribe']);
const READS = new Set<string>(READ_ONLY_METHODS);

export const isRead = (method: MethodName) => READS.has(method);

export interface Reads {
  /** `request` for a change; shared, queued and remembered for a read. */
  call<T>(method: MethodName, params: unknown, request: () => Promise<T>): Promise<T>;
  /** The last answer, when it is under `maxAgeMs` old and nothing changed since; else `call`. */
  fresh<T>(
    method: MethodName,
    params: unknown,
    maxAgeMs: number,
    request: () => Promise<T>
  ): Promise<T>;
  /** The last answer to this read, however old; undefined when it hasn't been read. */
  last<T>(method: MethodName, params: unknown): T | undefined;
  /** Another Mac: nothing read for the last one is kept, nor kept when it lands. */
  forget(): void;
}

export function createReads(now: () => number = Date.now, slots = READ_SLOTS): Reads {
  const inflight = new Map<string, Promise<unknown>>();
  const kept = new Map<string, { at: number; value: unknown }>();
  const queue: (() => void)[] = [];
  let running = 0;
  let epoch = 0;
  const keyOf = (method: MethodName, params: unknown) => `${method} ${JSON.stringify(params)}`;

  function slot<T>(run: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      running++;
      const done = () => {
        running--;
        queue.shift()?.();
      };
      let out: Promise<T>;
      try {
        out = run();
      } catch (e) {
        out = Promise.reject(e);
      }
      return out.finally(done);
    };
    if (running < slots) return start();
    return new Promise<void>((go) => queue.push(go)).then(start);
  }

  function call<T>(method: MethodName, params: unknown, request: () => Promise<T>): Promise<T> {
    if (!READS.has(method)) {
      // A change may move any reading: the next fresh read asks again.
      if (!NEUTRAL.has(method)) for (const r of kept.values()) r.at = 0;
      return request();
    }
    const key = keyOf(method, params);
    const already = inflight.get(key);
    if (already) return already as Promise<T>;
    const asked = epoch;
    const run: Promise<T> = slot(request)
      .then((value) => {
        if (asked === epoch) kept.set(key, { at: now(), value });
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === run) inflight.delete(key);
      });
    inflight.set(key, run);
    return run;
  }

  return {
    call,
    fresh(method, params, maxAgeMs, request) {
      const held = kept.get(keyOf(method, params));
      if (held && held.at > 0 && now() - held.at < maxAgeMs) {
        return Promise.resolve(held.value as never);
      }
      return call(method, params, request);
    },
    last: (method, params) => kept.get(keyOf(method, params))?.value as never,
    forget() {
      epoch++;
      kept.clear();
      inflight.clear();
    },
  };
}
