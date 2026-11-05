/**
 * The plan's usage as the Mac last heard it from each engine (`agents.quota`),
 * read while a screen showing it is in front. Worded by
 * @shipstudio/companion-protocol's quota.ts, exactly as the desk words it.
 *
 * Only on a Mac that serves `agents.quota`; nothing reported, nothing shown.
 */

import { quotaLines, type Quota, type QuotaLine } from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useState } from 'react';
import { call, canCall } from './session';
import { useApp } from './store';
import { usePolling } from './usePolling';

/** The lines to show now; empty until (and unless) an engine has reported. */
export function useQuotaLines(): QuotaLine[] {
  const welcome = useApp((s) => s.welcome);
  const serves = canCall('agents.quota', welcome);
  const [quotas, setQuotas] = useState<Quota[] | null>(null);
  // A window whose reset passes goes away without waiting for the next read.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const read = useCallback(async () => {
    if (!serves) return;
    try {
      setQuotas(await call('agents.quota', {}));
      setNow(Date.now());
    } catch {
      // Unanswered: keep what was last read rather than flicker it away.
    }
  }, [serves]);
  usePolling(read, 60_000);
  return serves && quotas ? quotaLines(quotas, now) : [];
}
