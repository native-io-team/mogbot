/**
 * The plan's usage as the Mac last heard it from each engine (`agents.quota`),
 * read while a screen showing it is in front. Worded by
 * @shipstudio/companion-protocol's quota.ts, exactly as the desk words it.
 *
 * Only on a Mac that serves `agents.quota`; nothing reported, nothing shown.
 */

import { quotaLines, type Quota, type QuotaLine } from '@shipstudio/companion-protocol';
import { useCallback, useState } from 'react';
import { callFresh, canCall, lastRead, READ_FRESH_MS } from './session';
import { useApp } from './store';
import { useNow } from './moving';
import { usePolling } from './usePolling';

/**
 * The readings themselves, re-read every minute while on screen, and `now`
 * (a window whose reset passes goes away without waiting for the next read).
 * Null until read, and always on a Mac that doesn't serve them.
 */
export function useQuotas(): { quotas: Quota[] | null; now: number; read: () => Promise<void> } {
  const welcome = useApp((s) => s.welcome);
  const serves = canCall('agents.quota', welcome);
  const [quotas, setQuotas] = useState<Quota[] | null>(
    () => (serves && lastRead('agents.quota', {})) || null
  );
  // A minute's clock only while the screen shows (a chat under another keeps
  // this mounted); a fresh reading moves it on at once.
  const ticked = useNow(60_000);
  const [readAt, setReadAt] = useState(0);
  const now = Math.max(ticked, readAt);
  const read = useCallback(async () => {
    if (!serves) return;
    try {
      setQuotas(await callFresh('agents.quota', {}, READ_FRESH_MS));
      setReadAt(Date.now());
    } catch {
      // Unanswered: keep what was last read rather than flicker it away.
    }
  }, [serves]);
  usePolling(read, 60_000);
  return { quotas: serves ? quotas : null, now, read };
}

/** The lines to show now; empty until (and unless) an engine has reported. */
export function useQuotaLines(): QuotaLine[] {
  const { quotas, now } = useQuotas();
  return quotas ? quotaLines(quotas, now) : [];
}
