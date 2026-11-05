/**
 * The Mac's usage accounts (`agents.accounts`), read while Settings is in
 * front. Read-only here: accounts are added and signed in on the Mac,
 * where their sign-in runs. Worded by @shipstudio/companion-protocol's
 * accounts.ts (`accountLines`), exactly as the desk words it.
 *
 * Only on a Mac that serves `agents.accounts`; and only once an engine has
 * more than one account, since one account has nothing to switch to.
 */

import { accountLines, type AccountLine, type UsageAccount } from '@shipstudio/companion-protocol';
import { useCallback, useState } from 'react';
import { call, canCall } from './session';
import { useApp } from './store';
import { usePolling } from './usePolling';

export function useAccountLines(): AccountLine[] {
  const welcome = useApp((s) => s.welcome);
  const serves = canCall('agents.accounts', welcome);
  const [accounts, setAccounts] = useState<UsageAccount[] | null>(null);
  const read = useCallback(async () => {
    if (!serves) return;
    try {
      setAccounts(await call('agents.accounts', {}));
    } catch {
      // Unanswered: keep what was last read.
    }
  }, [serves]);
  usePolling(read, 60_000);
  return serves && accounts ? accountLines(accounts) : [];
}
