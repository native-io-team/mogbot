/**
 * One at a time. State can't guard an answer against a fast double-tap: two
 * taps in one frame both see the render before `busy` was set, and the
 * second answer is refused (an error haptic and a toast after the success
 * one). A synchronous flag can.
 */

import { useState } from 'react';

export type Guard = <T>(run: () => Promise<T>) => Promise<T | undefined>;

/** Runs `run` unless one is still going; a call while it is resolves to undefined and does nothing. */
export function inFlight(): Guard {
  let busy = false;
  return async (run) => {
    if (busy) return undefined;
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  };
}

/** `inFlight`, kept for the component's life. */
export function useInFlight(): Guard {
  return useState(inFlight)[0];
}
