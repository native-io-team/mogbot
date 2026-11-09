/**
 * The Mac's usage accounts (`agents.accounts`), read while Settings or an
 * agent's controls are in front, and swapped from here: "Use this one now" puts one
 * first (`agents.accounts.use`), the arrows reorder (`agents.accounts.reorder`).
 * Both are audited on the Mac and never carry a token: the phone names an
 * account only by its id. Adding one, or signing one in, happens on the Mac,
 * where its sign-in runs (`ADD_ON_MAC`).
 *
 * Worded by @shipstudio/companion-protocol's accountSwitcher.ts
 * (`switcherView`), exactly as the desk's account row words it. Each
 * account's room comes from `agents.usagePlan` when the Mac serves it; no
 * reading, no figure.
 *
 * A swap shows at once (the order is changed here first), then the Mac's
 * own answer replaces it; a refusal puts the order back and says why.
 */

import {
  movedIds,
  switcherView,
  usedFirst,
  type AgentEngine,
  type SwitcherEngine,
  type UsageAccount,
  type UsageInventory,
} from '@shipstudio/companion-protocol';
import { useCallback, useMemo, useRef, useState } from 'react';
import { haptic } from './haptics';
import { call, canCall, describeError } from './session';
import { useApp } from './store';
import { usePolling } from './usePolling';
import { idsOf, reordered } from './accountsView';

export { headerSubtitle, idsOf, reordered, runsOnChoices } from './accountsView';

export interface AccountsState {
  /** The Mac serves `agents.accounts`: there is something to show. */
  serves: boolean;
  accounts: UsageAccount[] | null;
  /** Each account's readings (`agents.usagePlan`), when the Mac serves them. */
  inventory?: UsageInventory | null;
  view: SwitcherEngine[];
  /** The Mac takes "Use this one now" / the arrows from here. */
  canSwap: boolean;
  canReorder: boolean;
  error: string | null;
  busy: boolean;
  swapTo: (engine: AgentEngine, id: string) => Promise<void>;
  move: (engine: AgentEngine, index: number, by: -1 | 1) => Promise<void>;
}

export function useAccounts({ room = true }: { room?: boolean } = {}): AccountsState {
  const welcome = useApp((s) => s.welcome);
  const live = useApp((s) => s.link.kind === 'connected');
  const agents = useApp((s) => s.overview?.agents);
  const serves = canCall('agents.accounts', welcome);
  const servesPlan = room && canCall('agents.usagePlan', welcome);
  const canSwap = live && canCall('agents.accounts.use', welcome);
  const canReorder = live && canCall('agents.accounts.reorder', welcome);
  const [accounts, setAccounts] = useState<UsageAccount[] | null>(null);
  const [inventory, setInventory] = useState<UsageInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A read that lands mid-swap would put the old order back for a moment.
  const swapping = useRef(0);
  // Bumped by every change: a read that went out before one (a poll's, slow)
  // and lands after it has finished carries the old order, so it is dropped.
  const changes = useRef(0);

  const read = useCallback(async () => {
    if (!serves) return;
    try {
      const asked = changes.current;
      const next = await call('agents.accounts', {});
      if (swapping.current === 0 && asked === changes.current) setAccounts(next);
    } catch {
      // Unanswered: keep what was last read.
    }
    if (!servesPlan) return;
    try {
      setInventory(await call('agents.usagePlan', {}));
    } catch {
      // No room figures rather than old ones guessed at.
    }
  }, [serves, servesPlan]);
  usePolling(read, 60_000);

  const pins = useMemo(
    () =>
      (agents ?? [])
        .filter((a) => !!a.account && !a.hidden)
        .map((a) => ({ engine: a.engine, account: a.account!, name: a.name })),
    [agents]
  );
  const view = useMemo(
    () => (accounts ? switcherView(accounts, inventory, { pins }) : []),
    [accounts, inventory, pins]
  );

  const change = useCallback(
    async (engine: AgentEngine, ids: string[], send: () => Promise<UsageAccount[]>) => {
      // One change at a time: a second tap while the first is on its way
      // would build on an order the Mac hasn't settled yet.
      if (!accounts || swapping.current > 0) return;
      const before = accounts;
      haptic.select();
      setError(null);
      setAccounts(reordered(accounts, engine, ids));
      swapping.current += 1;
      changes.current += 1;
      setBusy(true);
      try {
        setAccounts(await send());
        haptic.success();
      } catch (e) {
        haptic.error();
        setAccounts(before);
        setError(describeError(e));
      } finally {
        swapping.current -= 1;
        setBusy(false);
      }
    },
    [accounts]
  );

  const swapTo = useCallback(
    async (engine: AgentEngine, id: string) => {
      if (!accounts || !canSwap) return;
      await change(engine, usedFirst(idsOf(accounts, engine), id), () =>
        call('agents.accounts.use', { engine, id })
      );
    },
    [accounts, canSwap, change]
  );

  const move = useCallback(
    async (engine: AgentEngine, index: number, by: -1 | 1) => {
      if (!accounts || !canReorder) return;
      const ids = movedIds(idsOf(accounts, engine), index, by);
      if (!ids) return;
      await change(engine, ids, () => call('agents.accounts.reorder', { engine, ids }));
    },
    [accounts, canReorder, change]
  );

  return { serves, accounts, inventory, view, canSwap, canReorder, error, busy, swapTo, move };
}
