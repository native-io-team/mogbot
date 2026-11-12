/**
 * Settings → Account, only in a build with our hosted relay (docs/relay.md,
 * "Accounts"): who this Mac is signed in as, with Sign out (after a
 * confirm), or Sign in with the one line on what it unlocks.
 *
 * Only what the relay said is shown. It answers over this Mac's own relay
 * connection, which is up only while phone access is on, so with phone
 * access off the page says it can't tell rather than "Not signed in".
 *
 * ⌘K's `account.signIn` / `account.signOut` open this page and ask it to
 * start the sign-in or show the confirm (`takeAccountOnOpen`).
 *
 * @module components/dashboard/AccountPage
 */

import { useEffect, useState } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Group, Row } from '../agents/AgentSettingsRows';
import { ProjectActionConfirmModal } from './ProjectActionConfirmModal';
import { ErrorIcon } from '@/components/icons';
import { useAccountStatus, useSignIn } from '../../hooks/useAccount';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  ACCOUNT_UNLOCKS,
  FINISH_IN_BROWSER,
  SIGN_IN,
  WITHOUT_ACCOUNT,
  accountOf,
  peekAccountOnOpen,
  takeAccountOnOpen,
} from '../../lib/account';
import { setPhoneAccess, signOutAccount } from '../../lib/companion';

export function AccountPage() {
  const { showToast } = useOptionalToast();
  const { status, reload } = useAccountStatus();
  const account = accountOf(status);
  const signIn = useSignIn(account);
  const [confirming, setConfirming] = useState(false);
  // ⌘K's "Sign out": the confirm, once the page knows there's an account.
  const [wantsSignOut, setWantsSignOut] = useState(() => peekAccountOnOpen() === 'signOut');

  const signOut = useAsyncState(async () => {
    await signOutAccount();
    await reload();
    return true;
  });
  const turnOn = useAsyncState(async () => {
    await setPhoneAccess(true);
    await reload();
    return true;
  });

  // ⌘K asked for this page to do something: once, on open.
  const { start } = signIn;
  useEffect(() => {
    if (takeAccountOnOpen() === 'signIn') void start();
  }, [start]);
  const showConfirm = (confirming || wantsSignOut) && account !== null;
  const closeConfirm = () => {
    setConfirming(false);
    setWantsSignOut(false);
  };

  const confirmSignOut = async () => {
    const done = await signOut.execute();
    closeConfirm();
    if (done) showToast('Signed out', 'success');
  };

  const error = signIn.error ?? signOut.error?.message ?? turnOn.error?.message ?? null;
  // Never a spinner forever: past `SLOW_MS` connecting, say so with Try again.
  const connecting = !!status && status.relay.state === 'connecting' && !signIn.waiting;
  const slow = useSlow(connecting);

  return (
    <div className="agents-settings" data-account-page>
      <Group id="account" title="Your account">
        {!status ? (
          <Row label="Checking…">
            <Spinner size="sm" />
          </Row>
        ) : account ? (
          <Row
            label={account.email ?? 'Signed in'}
            description="Signed in. Your phone can reach this Mac from anywhere, with no Tailscale."
          >
            <Button
              variant="secondary"
              onClick={() => setConfirming(true)}
              disabled={signOut.isLoading}
              data-account-sign-out
            >
              Sign out…
            </Button>
          </Row>
        ) : status.relay.state === 'off' ? (
          <Row
            label="Phone access is off"
            description="This Mac checks your account through phone access. Turn it on to see whether you’re signed in."
          >
            <Button
              variant="secondary"
              onClick={() => void turnOn.execute()}
              disabled={turnOn.isLoading}
              leftIcon={turnOn.isLoading ? <Spinner size="sm" /> : undefined}
            >
              Turn on phone access
            </Button>
          </Row>
        ) : connecting && slow ? (
          <Row
            label="Can’t reach the sign-in service"
            description="This Mac keeps trying. Check its internet connection. If you use your own Tailscale, your phone still works over it."
          >
            <Button variant="secondary" onClick={() => void reload()} data-account-retry>
              Try again
            </Button>
          </Row>
        ) : connecting ? (
          <Row label="Connecting…" description="Checking your account.">
            <Spinner size="sm" />
          </Row>
        ) : (
          <Row
            label={signIn.waiting ? FINISH_IN_BROWSER : 'Not signed in'}
            description={
              signIn.waiting
                ? 'Sign in with Google or your email on the page that opened. This updates by itself.'
                : `${ACCOUNT_UNLOCKS} ${WITHOUT_ACCOUNT}`
            }
          >
            <Button
              variant={signIn.waiting ? 'secondary' : 'primary'}
              onClick={() => void signIn.start()}
              disabled={signIn.starting}
              leftIcon={signIn.starting ? <Spinner size="sm" /> : undefined}
              data-account-sign-in
            >
              {signIn.waiting ? 'Try again' : SIGN_IN}
            </Button>
          </Row>
        )}
        {error && (
          <p className="settings-row-description" role="alert" data-account-error>
            <ErrorIcon size={12} className="inline-error-icon" /> {error}
          </p>
        )}
      </Group>
      {showConfirm && (
        <ProjectActionConfirmModal
          title="Sign out?"
          body={
            <p>
              Your phone stops reaching this Mac through your account. Over Tailscale, if you set it
              up, it keeps working.
            </p>
          }
          hint="You can sign in again any time."
          loading={signOut.isLoading}
          confirmLabel="Sign out"
          loadingLabel="Signing out…"
          confirmVariant="strong"
          onCancel={closeConfirm}
          onConfirm={() => void confirmSignOut()}
        />
      )}
    </div>
  );
}

/** How long "Connecting…" may spin before the page says it can't reach the relay. */
export const SLOW_MS = 15_000;

/** True once `on` has held for `SLOW_MS`; false again the moment it stops. */
function useSlow(on: boolean): boolean {
  const [slow, setSlow] = useState(false);
  // Stopped connecting: forget it during render (derived state), not in an effect.
  if (!on && slow) setSlow(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [on]);
  return on && slow;
}
