import { useCallback, useState } from 'react';
import { usePolling } from './usePolling';

/**
 * The time now, refreshed every `intervalMs` while `enabled`: for a live
 * timer ("Running the tests · 5:32") that should tick without anything else
 * changing. Stops when disabled or unmounted.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => {
    setNow(Date.now());
    return Promise.resolve();
  }, []);
  usePolling(tick, { intervalMs, maxIntervalMs: intervalMs, enabled, name: 'useNow' });
  return now;
}
