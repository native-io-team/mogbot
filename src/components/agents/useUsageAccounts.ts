/**
 * The usage accounts, kept current: read on mount, again whenever the
 * backend says they changed (`agents-accounts-changed`: added, renamed,
 * reordered, swapped, removed, from here or the phone), and when the window
 * regains focus, since a sign-in can change in a terminal outside the app.
 *
 * `attempt` runs one change, reads again, and toasts a failure in the
 * app's words; it answers whether it went through.
 *
 * @module components/agents/useUsageAccounts
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  listUsageAccounts,
  onUsageAccountsChanged,
  removalLine,
  removeUsageAccount,
  type UsageAccount,
} from '../../lib/agentAccounts';
import type { AgentEngine } from '../../lib/agents';

export function useUsageAccounts() {
  const { showToast } = useOptionalToast();
  const [data, setList] = useState<UsageAccount[] | null>(null);
  // Reads overlap (mount, focus, every change event, after each change) and
  // can answer out of order: only the newest may land. A read that started
  // before a change answered with the new list would otherwise put the old
  // order back ("Use this one now" flicking back until the next read).
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const setData = useCallback((list: UsageAccount[]) => {
    seq.current += 1;
    setList(list);
  }, []);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    listUsageAccounts()
      .then((list) => {
        if (live.current && mine === seq.current) setList(list);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();
    let unlisten: (() => void) | undefined;
    let gone = false;
    void onUsageAccountsChanged(reload)
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => undefined);
    window.addEventListener('focus', reload);
    return () => {
      gone = true;
      unlisten?.();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);

  const attempt = useCallback(
    async (what: () => Promise<unknown>): Promise<boolean> => {
      try {
        const answer = await what();
        // A change that answers the new list shows it at once.
        if (Array.isArray(answer)) setData(answer as UsageAccount[]);
        reload();
        return true;
      } catch (e) {
        showToast(formatCommandError(asCommandError(e)), 'error');
        return false;
      }
    },
    [reload, setData, showToast]
  );

  // Removing waits for a turn running on the account: it says so.
  const remove = useCallback(
    (engine: AgentEngine, id: string) =>
      attempt(async () => {
        const line = removalLine(await removeUsageAccount(engine, id));
        if (line) showToast(line, 'info');
      }),
    [attempt, showToast]
  );

  return { accounts: data ?? null, reload, attempt, remove };
}
