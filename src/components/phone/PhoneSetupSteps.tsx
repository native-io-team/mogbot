/**
 * The first pairing, before a code can be shown: every step in order, each
 * with its one button, and "Done" on every step this Mac can see is done.
 * Once the last one is, the panel replaces this with the code itself.
 *
 * The phone app's first screen tells the same story in the same words
 * (`companion-protocol/src/pairWords.ts`): open the app on the Mac,
 * Tailscale on both, "Pair your phone", scan.
 *
 * Only what this Mac can check gets a tick: its own Tailscale and phone
 * access. Whether the phone has the app or Tailscale is the user's word
 * ("I have it"), and said so, never a tick the Mac made up.
 *
 * @module components/phone/PhoneSetupSteps
 */

import type { ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { CheckIcon, ExternalLinkIcon } from '@/components/icons';
import { TAILSCALE_DOWNLOAD_URL } from '../../lib/remoteAccess';
import { BRAND } from '../../lib/brand';
import {
  phoneTailscaleSignIn,
  TAILSCALE_IOS_URL,
  TAILSCALE_ANDROID_URL,
  type PhoneStatus,
  type PhoneStep,
} from '../../lib/companion';
import { TESTFLIGHT_URL } from '../../lib/companionInstall';
import { PHONE_APP_NOT_OUT, PHONE_APP_STORE_URL } from '../../lib/phoneApp';
import { PAIR_BUTTON, SCAN_THE_CODE } from '../../../packages/companion-protocol/src/pairWords';

interface Props {
  status: PhoneStatus;
  step: PhoneStep;
  busy: string | null;
  /** The user said the app is on their phone. */
  haveApp: boolean;
  onHaveApp: () => void;
  /** "Build it on this Mac" (the install screen), when this build offers it. */
  onInstall?: () => void;
  onEnable: () => void;
  onRetry: () => void;
  /** The App Store page, when this build has one (`lib/phoneApp`); it comes first. */
  storeUrl?: string | null;
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  /** `true` ticks it; `'said'` ticks it on the user's word. */
  done?: boolean | 'said';
  children?: ReactNode;
}) {
  return (
    <li className="phone-setup__step" data-done={done ? true : undefined}>
      <span className="phone-setup__num" aria-hidden>
        {done ? <CheckIcon size={12} /> : n}
      </span>
      <div className="phone-setup__body">
        <h3 className="phone-setup__title">
          {title}
          {done && (
            <span className="phone-setup__done">{done === 'said' ? 'You said done' : 'Done'}</span>
          )}
        </h3>
        {children}
      </div>
    </li>
  );
}

export function PhoneSetupSteps({
  status,
  step,
  busy,
  haveApp,
  onHaveApp,
  onInstall,
  onEnable,
  onRetry,
  storeUrl = PHONE_APP_STORE_URL,
}: Props) {
  const tailscale = status.tailscale;
  const macTailscale = tailscale.state === 'connected';
  const spin = (key: string) => (busy === key ? <Spinner size="sm" /> : undefined);
  const access = step.kind === 'ready';

  return (
    <div className="phone-setup" data-testid="phone-setup-steps">
      <p className="phone-lede">
        Talk to your agents from your phone. Four steps, then you scan a code from here.
      </p>
      <ol className="phone-setup__list">
        <Step n={1} title={`Get the ${BRAND.name} app on your phone`} done={haveApp && 'said'}>
          {!haveApp && (
            <>
              {storeUrl ? (
                <p className="phone-setup__text">Get it free from the App Store.</p>
              ) : TESTFLIGHT_URL ? (
                <p className="phone-setup__text">Install it from TestFlight on your iPhone.</p>
              ) : onInstall ? (
                <p className="phone-setup__text">
                  Install it from your TestFlight invite, or build it on this Mac.
                </p>
              ) : (
                <p className="phone-setup__text" data-not-out>
                  {PHONE_APP_NOT_OUT}
                </p>
              )}
              <div className="phone-setup__actions">
                {storeUrl && (
                  <Button
                    variant="primary"
                    rightIcon={<ExternalLinkIcon size={12} />}
                    onClick={() => void openUrl(storeUrl)}
                    data-app-store
                  >
                    Get it on the App Store
                  </Button>
                )}
                {!storeUrl && TESTFLIGHT_URL && (
                  <Button
                    variant="secondary"
                    rightIcon={<ExternalLinkIcon size={12} />}
                    onClick={() => void openUrl(TESTFLIGHT_URL!)}
                  >
                    Open TestFlight
                  </Button>
                )}
                <Button variant="strong" onClick={onHaveApp} data-have-app>
                  I have it
                </Button>
                {!storeUrl && onInstall && (
                  <Button variant="ghost" onClick={onInstall} data-install-open>
                    Get the app…
                  </Button>
                )}
              </div>
            </>
          )}
        </Step>

        <Step n={2} title="Tailscale on this Mac" done={macTailscale}>
          {!macTailscale && (
            <>
              <p className="phone-setup__text">
                {tailscale.state === 'needsLogin'
                  ? 'It’s installed. Sign in from the Tailscale icon in the menu bar.'
                  : 'A free app that links your phone to this Mac privately. Install it and sign in.'}
              </p>
              <div className="phone-setup__actions">
                {tailscale.state === 'notInstalled' && (
                  <Button
                    variant="primary"
                    rightIcon={<ExternalLinkIcon size={12} />}
                    onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}
                  >
                    Get Tailscale for Mac
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  leftIcon={spin('retry')}
                  onClick={onRetry}
                >
                  Check again
                </Button>
              </div>
            </>
          )}
        </Step>

        <Step n={3} title="Tailscale on your phone">
          <p className="phone-setup__text">
            Get Tailscale on your phone, {phoneTailscaleSignIn(tailscale)}, and switch it on.
          </p>
          <div className="phone-setup__actions">
            <Button
              variant="secondary"
              rightIcon={<ExternalLinkIcon size={12} />}
              onClick={() => void openUrl(TAILSCALE_IOS_URL)}
            >
              App Store
            </Button>
            <Button
              variant="ghost"
              rightIcon={<ExternalLinkIcon size={12} />}
              onClick={() => void openUrl(TAILSCALE_ANDROID_URL)}
            >
              Google Play
            </Button>
          </div>
        </Step>

        <Step n={4} title="Turn on phone access" done={access}>
          <AccessStep step={step} busy={busy} spin={spin} onEnable={onEnable} onRetry={onRetry} />
        </Step>

        <Step n={5} title="Scan the code">
          <p className="phone-setup__text">
            The code shows here when the steps above are done. On your phone, open {BRAND.name}, tap{' '}
            {SCAN_THE_CODE}, then {PAIR_BUTTON}.
          </p>
        </Step>
      </ol>
    </div>
  );
}

function AccessStep({
  step,
  busy,
  spin,
  onEnable,
  onRetry,
}: {
  step: PhoneStep;
  busy: string | null;
  spin: (key: string) => ReactNode;
  onEnable: () => void;
  onRetry: () => void;
}) {
  switch (step.kind) {
    case 'ready':
      return null;
    case 'off':
      return (
        <>
          <p className="phone-setup__text">
            Lets your phone reach this Mac, so this Mac has to stay on.
          </p>
          <div className="phone-setup__actions">
            <Button
              variant="primary"
              disabled={busy !== null}
              leftIcon={spin('enable')}
              onClick={onEnable}
            >
              Turn on phone access
            </Button>
          </div>
        </>
      );
    case 'installTailscale':
    case 'signInTailscale':
      return <p className="phone-setup__text">Waiting for Tailscale on this Mac (step 2).</p>;
    case 'starting':
      return (
        <p className="phone-setup__text phone-setup__wait">
          <Spinner size="sm" /> Starting…
        </p>
      );
    case 'approveHttps':
      return (
        <>
          <p className="phone-setup__text">
            One switch in Tailscale (HTTPS), so your phone can trust this Mac.
          </p>
          <div className="phone-setup__actions">
            <Button
              variant="primary"
              rightIcon={<ExternalLinkIcon size={12} />}
              onClick={() => void openUrl(step.url)}
            >
              Open Tailscale
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              leftIcon={spin('retry')}
              onClick={onRetry}
            >
              I’ve switched it on
            </Button>
          </div>
        </>
      );
    case 'failed':
      return (
        <>
          <p className="phone-setup__text">Tailscale didn’t start phone access:</p>
          <p className="phone-error">{step.detail}</p>
          <div className="phone-setup__actions">
            <Button
              variant="secondary"
              disabled={busy !== null}
              leftIcon={spin('retry')}
              onClick={onRetry}
            >
              Try again
            </Button>
          </div>
        </>
      );
  }
}
