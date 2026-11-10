/**
 * Usage at a glance, read while the Agents list is in front: the accounts
 * (`agents.accounts`) and their readings (`agents.usagePlan`), worded by the
 * protocol's `usageGlance`, as the desk sidebar's row words it. Drawn by
 * components/usageStack.tsx `GlanceRow`.
 *
 * `glanceFor` is the one way the phone builds a glance, so the Agents list,
 * Usage, an account's page and Settings count the same accounts, in the same
 * order, with the same "runs only on this one" lines as the desk.
 */

import {
  usageGlance,
  type Agent,
  type UsageAccount,
  type UsageGlance,
  type UsageInventory,
} from '@shipstudio/companion-protocol';
import { useMemo } from 'react';
import { useAccounts } from './accounts';
import { useApp } from './store';

/**
 * The glance with the engines the desk shows (`AccountSwitcher.shownEngines`):
 * those agents run on, or with more than one account (else every engine
 * with a sign-in), and who is set to run only on which account.
 */
export function glanceFor(
  accounts: UsageAccount[],
  inventory: UsageInventory | null | undefined,
  agents: Pick<Agent, 'engine' | 'account' | 'name'>[] | undefined,
  now?: number
): UsageGlance {
  const all = agents ?? [];
  const engines = [...new Set(accounts.map((a) => a.engine))].filter(
    (e) => all.some((a) => a.engine === e) || accounts.filter((a) => a.engine === e).length > 1
  );
  const pins = all
    .filter((a) => !!a.account)
    .map((a) => ({ engine: a.engine, account: a.account as string, name: a.name }));
  return usageGlance(accounts, inventory, {
    now,
    engines: engines.length > 0 ? engines : undefined,
    pins,
  });
}

/** The glance from what the Mac serves now. Null until the Mac has answered, and on a Mac that doesn't serve accounts. */
export function useGlance(): UsageGlance | null {
  const { accounts, inventory } = useAccounts();
  const agents = useApp((s) => s.overview?.agents);
  return useMemo(
    () => (accounts ? glanceFor(accounts, inventory, agents) : null),
    [accounts, inventory, agents]
  );
}
