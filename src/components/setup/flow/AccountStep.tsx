/**
 * "Sign in?": the screen after the welcome, only in a build with our hosted
 * relay (`relayOn()`), asked once (`lib/account.ts`).
 *
 * One Sign in button, not "Continue with Google" beside "Continue with
 * email": the relay's sign-in page is one page that offers both, and this
 * Mac can't tell it which one was pressed, so two buttons here would ask the
 * same question twice and open the same page either way. The lede names both
 * ways instead.
 *
 * Sign in opens that page in the browser (turning phone access on first,
 * which signing in goes through); the screen then waits, and goes on by
 * itself once the relay names the account. "Use without signing in" is the
 * open-source way: everything on this Mac, the phone over the user's own
 * Tailscale.
 *
 * @module components/setup/flow/AccountStep
 */

import { Button } from '../../primitives/Button';
import { CheckLine, FlowShell } from './FlowParts';
import { Primary, useAdvanceWhenPassed } from '../../phone/PhoneFlow';
import { useAccountStatus, useSignIn } from '../../../hooks/useAccount';
import {
  ACCOUNT_UNLOCKS,
  FINISH_IN_BROWSER,
  SIGN_IN,
  USE_WITHOUT_SIGNING_IN,
  WITHOUT_ACCOUNT,
  accountOf,
  saveAccountChoice,
  signInCheck,
  type AccountChoice,
} from '../../../lib/account';
import { THIS_COMPUTER } from '../../../lib/computer';

export function AccountStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { status } = useAccountStatus();
  const account = accountOf(status);
  const signIn = useSignIn(account);
  const check = signInCheck({ account, ...signIn });

  const answer = (choice: AccountChoice) => {
    saveAccountChoice(choice);
    onNext();
  };
  useAdvanceWhenPassed(account !== null, () => answer('signedIn'), 'account');

  const without = (
    <Button variant="ghost" onClick={() => answer('without')} data-flow-skip data-account-without>
      {USE_WITHOUT_SIGNING_IN}
    </Button>
  );

  if (account) {
    return (
      <FlowShell
        step="account"
        onBack={onBack}
        title="You’re signed in"
        lede={`Your phone can reach ${THIS_COMPUTER} from anywhere once it’s paired.`}
        primary={<Primary onClick={() => answer('signedIn')}>Continue</Primary>}
      >
        {check && <CheckLine result={check} />}
      </FlowShell>
    );
  }

  if (signIn.waiting) {
    return (
      <FlowShell
        step="account"
        onBack={onBack}
        title={FINISH_IN_BROWSER}
        lede="This screen goes on by itself once you’re signed in."
        primary={
          <Primary onClick={() => void signIn.start()} busy={signIn.starting}>
            Try again
          </Primary>
        }
        secondary={without}
      >
        {check && <CheckLine result={check} />}
      </FlowShell>
    );
  }

  return (
    <FlowShell
      step="account"
      onBack={onBack}
      title="Sign in?"
      lede={`${ACCOUNT_UNLOCKS} ${WITHOUT_ACCOUNT}`}
      primary={
        <Primary onClick={() => void signIn.start()} busy={signIn.starting}>
          {SIGN_IN}
        </Primary>
      }
      secondary={without}
    >
      {check && check.state !== 'checking' ? (
        <CheckLine result={check} />
      ) : (
        <p className="flow-note">
          With Google or your email, in your browser.
          {status &&
            !status.enabled &&
            ` Signing in also turns on phone access on ${THIS_COMPUTER}.`}
        </p>
      )}
    </FlowShell>
  );
}
