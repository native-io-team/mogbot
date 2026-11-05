/**
 * The Mac's capacity inventory (`agents.usagePlan`), read while Settings is
 * in front: the usage mode, a reset near with capacity left, estimates from
 * past runs and the spare-capacity list. Read-only here: the mode and the
 * list are changed on the Mac, or by asking the Chief of Staff. Worded by
 * @shipstudio/companion-protocol's usage.ts, exactly as the desk words it.
 *
 * Only on a Mac that serves `agents.usagePlan`: an older Mac shows nothing.
 */

import { usageRows, type UsageInventory, type UsageRow } from '@shipstudio/companion-protocol';
import { useCallback, useState } from 'react';
import { call, canCall } from './session';
import { useApp } from './store';
import { usePolling } from './usePolling';

export function useUsageRows(): UsageRow[] {
  const welcome = useApp((s) => s.welcome);
  const serves = canCall('agents.usagePlan', welcome);
  const [inventory, setInventory] = useState<UsageInventory | null>(null);
  const read = useCallback(async () => {
    if (!serves) return;
    try {
      setInventory(await call('agents.usagePlan', {}));
    } catch {
      // Unanswered: keep what was last read.
    }
  }, [serves]);
  usePolling(read, 60_000);
  return serves ? usageRows(inventory) : [];
}
