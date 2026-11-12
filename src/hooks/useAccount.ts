/**
 * Signing in, for a screen that offers it: this Mac's account as the relay
 * last said (`companion_status`), and Sign in's own state (opening the
 * page, then waiting for the browser). See `lib/account.ts`.
 *
 * @module hooks/useAccount
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAsyncState } from './useAsyncState';
import { usePolling } from './usePolling';
import { beginSignIn, type Account } from '../lib/account';
import { COMPANION_CHANGED_EVENT, getPhoneStatus, type PhoneStatus } from '../lib/companion';

/**
 * `companion_status`, read on arrival, on every companion change, and every
 * few seconds while `enabled` (the account arrives from the browser, which
 * sends no event of its own here).
 */
export function useAccountStatus({ enabled = true, intervalMs = 3000 } = {}) {
  const status = useAsyncState<PhoneStatus>(getPhoneStatus, { immediate: true });
  const { execute } = status;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let closed = false;
    void listen(COMPANION_CHANGED_EVENT, () => void execute())
      .then((fn) => {
        if (closed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // No event bridge: the polling below still picks the account up.
      });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [execute]);
  usePolling(() => execute(), { intervalMs, enabled, name: 'account-status' });
  return { status: status.data, reload: execute };
}

/**
 * Sign in's state on one screen: `starting` while the page is being opened
 * (phone access turned on and the relay reached first), `waiting` from
 * then until the account arrives, and the error when it couldn't start.
 */
export function useSignIn(account: Account | null) {
  const run = useAsyncState(() => beginSignIn());
  return {
    start: run.execute,
    starting: run.isLoading,
    // Once the page has opened, Try again keeps this screen (its check says
    // what the new attempt is doing) rather than flicking back to Sign in.
    waiting: run.data === true && account === null,
    error: run.error?.message ?? null,
  };
}
