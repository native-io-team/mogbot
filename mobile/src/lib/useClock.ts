/**
 * The time, ticking only while something on screen counts it (a working
 * row's elapsed time, the live step's timer). Every second; `active` false
 * stops the interval and keeps the last reading.
 */

import { useEffect, useState } from 'react';

export function useClock(active: boolean, everyMs = 1_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}
