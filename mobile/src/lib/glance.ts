/**
 * Usage at a glance, read while the Agents list is in front: the accounts
 * (`agents.accounts`) and their readings (`agents.usagePlan`), worded by the
 * protocol's `usageGlance`, as the desk sidebar's row words it. Drawn by
 * components/usageStack.tsx `GlanceRow`.
 */

import { usageGlance, type UsageGlance } from '@shipstudio/companion-protocol';
import { useMemo } from 'react';
import { useAccounts } from './accounts';
import { useApp } from './store';

/**
 * The glance from what the Mac serves now, with the engines the desk's
 * sidebar shows: those agents run on, or with more than one account (else
 * every engine with a sign-in). Null until the Mac has answered, and on a
 * Mac that doesn't serve accounts.
 */
export function useGlance(): UsageGlance | null {
  const { accounts, inventory } = useAccounts();
  const agents = useApp((s) => s.overview?.agents);
  return useMemo(() => {
    if (!accounts) return null;
    const visible = (agents ?? []).filter((a) => !a.hidden);
    const engines = [...new Set(accounts.map((a) => a.engine))].filter(
      (e) =>
        visible.some((a) => a.engine === e) || accounts.filter((a) => a.engine === e).length > 1
    );
    const pins = visible
      .filter((a) => !!a.account)
      .map((a) => ({ engine: a.engine, account: a.account as string, name: a.name }));
    return usageGlance(accounts, inventory, {
      engines: engines.length > 0 ? engines : undefined,
      pins,
    });
  }, [accounts, inventory, agents]);
}
