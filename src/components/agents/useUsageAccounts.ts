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

import { useCallback, useEffect } from 'react';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  listUsageAccounts,
  onUsageAccountsChanged,
  type UsageAccount,
} from '../../lib/agentAccounts';

export function useUsageAccounts() {
  const { showToast } = useOptionalToast();
  const { data, execute, setData } = useAsyncState(listUsageAccounts);
  const reload = useCallback(() => void execute().catch(() => undefined), [execute]);

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

  return { accounts: data ?? null, reload, attempt };
}
