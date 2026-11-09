/**
 * Step 4: your phone, optional. One screen each, every one checked by the
 * app and skippable:
 *
 * - Use your agents from your phone? (Set up / Skip)
 * - Tailscale on this Mac — ticks when it's installed, signed in and on.
 * - Tailscale on your phone, same account — a QR code to the App Store,
 *   then ticks when a phone signed in as this Mac's account shows up.
 * - The phone app — TestFlight when there is one; until then, built on
 *   this Mac (the guided build), or "I already have it".
 * - Scan this code → Allow → paired. Phone access turns itself on; a
 *   Tailscale problem (HTTPS certificates off) says so, with the page that
 *   fixes it and a Check again that answers.
 *
 * @module components/setup/flow/PhoneSteps
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../../primitives/Button';
import { TextButton } from '../../primitives/TextButton';
import { ExternalLinkIcon } from '@/components/icons';
import { usePolling } from '../../../hooks/usePolling';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import {
  ADVANCE_MS,
  CheckLine,
  FlowShell,
  StoreQr,
  useAdvanceOnPass,
  useFlowCheck,
} from './FlowParts';
import { PairCode, PairConfirm } from '../../phone/PhonePairing';
import { PhoneInstall } from '../../phone/PhoneInstall';
import { BRAND } from '../../../lib/brand';
import {
  cancelPairing,
  COMPANION_CHANGED_EVENT,
  decidePairing,
  getPhoneStatus,
  getTailnetPhones,
  phoneTailscaleSignIn,
  retryPhoneTailscale,
  setPhoneAccess,
  startPairing,
  TAILSCALE_ANDROID_URL,
  TAILSCALE_IOS_URL,
  type PairingCode,
  type PhoneStatus,
} from '../../../lib/companion';
import {
  COMPANION_INSTALL_ENABLED,
  TESTFLIGHT_URL,
  type InstallPlatform,
} from '../../../lib/companionInstall';
import { pairStage, tailscaleMacCheck, tailscalePhoneCheck } from '../../../lib/onboardingFlow';
import { asCommandError, formatCommandError } from '../../../lib/errors';

interface StepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

const skipButton = (onSkip: () => void) => (
  <Button variant="ghost" onClick={onSkip} data-flow-skip>
    Skip phone setup
  </Button>
);

export function PhoneIntroStep({ onNext, onBack, onSkip }: StepProps) {
  const { data: status } = useFlowCheck(getPhoneStatus, {
    name: 'flow-phone-intro',
    intervalMs: 10_000,
  });
  const paired = status?.devices[0];
  return (
    <FlowShell
      step="phone"
      title="Use your agents from your phone?"
      lede="Chat, answer and approve from anywhere. Your phone talks only to this Mac, through Tailscale, a free app that links your own devices privately. About ten minutes."
      onBack={onBack}
      primary={
        paired ? (
          <Button variant="primary" size="large" onClick={onSkip} data-flow-primary>
            Continue
          </Button>
        ) : (
          <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
            Set up my phone
          </Button>
        )
      }
      secondary={
        !paired && (
          <Button variant="ghost" onClick={onSkip} data-flow-skip>
            Skip phone setup
          </Button>
        )
      }
    >
      {paired && (
        <CheckLine result={{ state: 'pass', line: `${paired.name} is already paired.` }} />
      )}
    </FlowShell>
  );
}

export function TailscaleMacStep({ onNext, onBack, onSkip }: StepProps) {
  const check = useFlowCheck(getPhoneStatus, { name: 'flow-tailscale-mac' });
  const checked = tailscaleMacCheck(check.data?.tailscale ?? null);
  // The download is this screen's big button already; the check doesn't repeat it.
  const result = checked.state === 'fail' ? { ...checked, action: undefined } : checked;
  const doneOnArrival = useAdvanceOnPass(result, onNext, check.data !== null);
  return (
    <FlowShell
      step="tailscaleMac"
      title="Get Tailscale on this Mac"
      lede="It’s how your phone reaches this Mac, privately. Install it, open it, and sign in."
      onBack={onBack}
      primary={
        result.state === 'pass' ? (
          doneOnArrival && (
            <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
              Continue
            </Button>
          )
        ) : (
          <Button
            variant="primary"
            size="large"
            rightIcon={<ExternalLinkIcon size={14} />}
            onClick={() => void openUrl('https://tailscale.com/download/mac')}
            data-flow-primary
          >
            Get Tailscale
          </Button>
        )
      }
      secondary={skipButton(onSkip)}
    >
      <CheckLine
        result={result}
        checking={check.checking}
        checkedAt={check.checkedAt}
        onCheckAgain={() => void check.checkAgain()}
      />
    </FlowShell>
  );
}

async function loadPhoneTailnet() {
  const [status, phones] = await Promise.all([getPhoneStatus(), getTailnetPhones()]);
  return { tailscale: status.tailscale, phones };
}

export function TailscalePhoneStep({ onNext, onBack, onSkip }: StepProps) {
  const check = useFlowCheck(loadPhoneTailnet, { name: 'flow-tailscale-phone' });
  const tailscale = check.data?.tailscale ?? null;
  const result = tailscalePhoneCheck(tailscale, check.data?.phones ?? null);
  const doneOnArrival = useAdvanceOnPass(result, onNext, check.data !== null);
  return (
    <FlowShell
      step="tailscalePhone"
      title="Get Tailscale on your phone"
      lede={`Scan this with your iPhone’s camera, install Tailscale, then ${phoneTailscaleSignIn(tailscale)} and turn it on.`}
      onBack={onBack}
      wide
      primary={
        doneOnArrival && (
          <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
            Continue
          </Button>
        )
      }
      secondary={skipButton(onSkip)}
    >
      <div className="flow-split">
        <StoreQr url={TAILSCALE_IOS_URL} label="Tailscale on the App Store" />
        <div className="flow-split__side">
          <CheckLine
            result={result}
            checking={check.checking}
            checkedAt={check.checkedAt}
            onCheckAgain={() => void check.checkAgain()}
          />
          <TextButton
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(TAILSCALE_ANDROID_URL)}
          >
            Android? Get it on Google Play
          </TextButton>
        </div>
      </div>
    </FlowShell>
  );
}

export function PhoneAppStep({ onNext, onBack, onSkip }: StepProps) {
  const [building, setBuilding] = useState<InstallPlatform | null>(null);
  const [testflight, setTestflight] = useState(false);
  const { data: status } = useFlowCheck(getPhoneStatus, {
    name: 'flow-phone-app',
    intervalMs: 10_000,
  });

  if (building) {
    return (
      <FlowShell
        step="phoneApp"
        title={`Build the ${BRAND.name} app on this Mac`}
        lede="Plug your phone in with a cable. Your agent builds the app and installs it; each step ticks when the app has checked it."
        onBack={() => setBuilding(null)}
        wide
        secondary={skipButton(onSkip)}
      >
        <div className="flow-embed phone-modal">
          <PhoneInstall
            build={building}
            tailscale={status?.tailscale ?? null}
            onBack={() => setBuilding(null)}
            onPair={onNext}
          />
        </div>
      </FlowShell>
    );
  }

  if (testflight && TESTFLIGHT_URL) {
    return (
      <FlowShell
        step="phoneApp"
        title={`Get the ${BRAND.name} app`}
        lede="Scan this with your iPhone’s camera and install it from TestFlight."
        onBack={() => setTestflight(false)}
        wide
        primary={
          <Button variant="primary" size="large" onClick={onNext} data-flow-primary>
            It’s installed
          </Button>
        }
        secondary={skipButton(onSkip)}
      >
        <StoreQr url={TESTFLIGHT_URL} label={`The ${BRAND.name} app on TestFlight`} />
      </FlowShell>
    );
  }

  const canBuild = COMPANION_INSTALL_ENABLED;
  return (
    <FlowShell
      step="phoneApp"
      title={`Get the ${BRAND.name} app on your phone`}
      lede={
        TESTFLIGHT_URL
          ? 'Which phone is it?'
          : canBuild
            ? 'There’s no App Store version yet, so this Mac builds it for you. Which phone is it?'
            : 'There’s no App Store version yet. Ask the agent setting you up to install it (docs/INSTALL.md, step 13), then come back.'
      }
      onBack={onBack}
      primary={
        (TESTFLIGHT_URL || canBuild) && (
          <div className="flow-choice">
            <Button
              variant="strong"
              size="large"
              onClick={() => (TESTFLIGHT_URL ? setTestflight(true) : setBuilding('ios'))}
              data-flow-primary
            >
              iPhone
            </Button>
            {canBuild && (
              <Button variant="secondary" size="large" onClick={() => setBuilding('android')}>
                Android
              </Button>
            )}
          </div>
        )
      }
      secondary={
        <Button variant="ghost" onClick={onNext} data-flow-have-app>
          I already have the app
        </Button>
      }
    />
  );
}

export function PhonePairStep({ onNext, onBack, onSkip }: StepProps) {
  const check = useFlowCheck(getPhoneStatus, {
    name: 'flow-phone-pair',
    retry: retryPhoneTailscale,
  });
  const { data: status, setData, refresh } = check;
  // The phones paired before this screen opened: only a new one is "paired".
  const [known, setKnown] = useState<string[] | null>(null);
  if (known === null && status) setKnown(status.devices.map((d) => d.id));
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { copy } = useCopyToClipboard();
  const stage = pairStage(status, known ?? []);

  // A push from the backend (a phone asking) beats the next poll.
  useEffect(() => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    void listen(COMPANION_CHANGED_EVENT, () => void refresh()).then((fn) => {
      if (closed) fn();
      else unlisten = fn;
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [refresh]);

  // Phone access turns itself on: that's what this screen is for.
  const enabling = useRef(false);
  useEffect(() => {
    if (!status || status.enabled || enabling.current) return;
    enabling.current = true;
    setPhoneAccess(true)
      .then((next: PhoneStatus) => setData(next))
      .catch((e: unknown) => setProblem(formatCommandError(asCommandError(e))));
  }, [status, setData]);

  // Ready for a code and none showing (or it ran out): issue one.
  const issue = useCallback(async () => {
    setBusy('code');
    try {
      setCode(await startPairing());
      setNow(Date.now());
      setProblem(null);
    } catch (e) {
      setProblem(formatCommandError(asCommandError(e)));
    } finally {
      setBusy(null);
    }
  }, []);
  const expired = code !== null && code.expiresAt <= now;
  useEffect(() => {
    if (stage.kind === 'code' && (code === null || expired) && busy === null && !problem) {
      void issue();
    }
  }, [stage.kind, code, expired, busy, problem, issue]);
  usePolling(() => Promise.resolve(setNow(Date.now())), {
    intervalMs: 1000,
    enabled: code !== null,
    name: 'flow-pair-clock',
  });

  // Only a phone paired here counts, so it always moves on by itself.
  const passed = stage.kind === 'paired';
  const next = useRef(onNext);
  useLayoutEffect(() => {
    next.current = onNext;
  });
  useEffect(() => {
    if (!passed) return;
    const timer = setTimeout(() => next.current(), ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [passed]);

  const decide = (allow: boolean, replace: string[]) => {
    const request = status?.pairing.request;
    if (!request) return;
    setBusy('decide');
    decidePairing(request.id, allow, replace)
      .then(() => refresh())
      .catch((e: unknown) => setProblem(formatCommandError(asCommandError(e))))
      .finally(() => setBusy(null));
  };

  return (
    <FlowShell
      step="phonePair"
      title={
        stage.kind === 'confirm'
          ? 'Allow your phone'
          : stage.kind === 'code'
            ? 'Scan this code'
            : stage.kind === 'paired'
              ? 'Your phone is paired'
              : 'Turning on phone access'
      }
      lede={
        stage.kind === 'confirm'
          ? 'Check it’s your phone and the code ending matches, then allow it.'
          : stage.kind === 'code'
            ? `Open the ${BRAND.name} app on your phone, tap Scan the code, and point the camera here.`
            : stage.kind === 'paired'
              ? 'It reaches this Mac over your own Tailscale.'
              : 'This Mac gets a private address your phone can reach. The code shows when it’s ready.'
      }
      onBack={onBack}
      wide
      secondary={!passed && skipButton(onSkip)}
    >
      {stage.kind === 'paired' && (
        <CheckLine result={{ state: 'pass', line: `Paired with ${stage.name}.` }} />
      )}
      {stage.kind === 'starting' && <CheckLine result={{ state: 'checking', line: 'Starting…' }} />}
      {stage.kind === 'fix' && (
        <CheckLine
          result={stage.check}
          checking={check.checking}
          checkedAt={check.checkedAt}
          onCheckAgain={() => void check.checkAgain()}
        />
      )}
      {stage.kind === 'confirm' && status?.pairing.request && (
        <PairConfirm request={status.pairing.request} busy={busy} onDecide={decide} />
      )}
      {stage.kind === 'code' && code && !expired && status && (
        <PairCode
          code={code}
          now={now}
          busy={busy !== null}
          tailscale={status.tailscale}
          reachedAt={status.pairing.reachedAt}
          tailscaleChecked
          onCopy={() => void copy(code.link)}
          onCancel={() => {
            void cancelPairing().finally(onBack);
          }}
        />
      )}
      {problem && (
        <CheckLine
          result={{
            state: 'fail',
            line: problem,
            fix: 'Check again in a moment. If it keeps happening, tell your Chief.',
          }}
          checking={check.checking}
          checkedAt={check.checkedAt}
          onCheckAgain={() => {
            setProblem(null);
            void check.checkAgain();
          }}
        />
      )}
    </FlowShell>
  );
}
