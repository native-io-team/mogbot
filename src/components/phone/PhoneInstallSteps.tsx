/**
 * The install checklist, and what the panel says once the app is on the
 * phone. Every row is decided by the app's own checks.
 *
 * @module components/phone/PhoneInstallSteps
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { ExternalLinkIcon, SuccessIcon } from '@/components/icons';
import {
  expiryLine,
  FREE_TEAM_DAYS,
  XCODE_APP_STORE_URL,
  type InstallPlatform,
  type InstallStep,
} from '../../lib/companionInstall';
import type { BuildDiagnosis } from '../../lib/companionBuildLog';
import { TailscaleStoreLinks } from './PhoneTailscale';

/** Who acts on a row; `agent` is filled with the agent's name. */
const WHO: Record<InstallStep['state'], string | null> = {
  done: null,
  agent: null,
  you: 'You',
  waiting: null,
};

export function InstallChecklist({
  steps,
  agentName,
}: {
  steps: InstallStep[];
  agentName: string;
}) {
  const who = (state: InstallStep['state']) => (state === 'agent' ? agentName : WHO[state]);
  return (
    <ol className="phone-install-steps" aria-label="Install checklist">
      {steps.map((step) => (
        <li key={step.id} className="phone-install-step" data-state={step.state}>
          <span className="phone-install-step__mark" aria-hidden>
            {step.state === 'done' ? <SuccessIcon size={16} /> : <span />}
          </span>
          <span className="phone-install-step__body">
            <span className="phone-install-step__head">
              <span className="phone-install-step__title">{step.title}</span>
              {who(step.state) && (
                <span className="phone-install-step__who">{who(step.state)}</span>
              )}
            </span>
            <span className="phone-install-step__detail">{step.detail}</span>
            {step.appStore && (
              <Button
                size="compact"
                variant="primary"
                className="phone-install-step__action"
                rightIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openUrl(XCODE_APP_STORE_URL)}
              >
                {step.appStore}
              </Button>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface DoneProps {
  platform: InstallPlatform;
  deviceName: string;
  /** "Install Tailscale on your phone and sign in as …": the step before pairing. */
  tailscaleLine: string;
  expiresAt: number | null;
  now: number;
  opening: boolean;
  onOpen?: () => void;
  onPair: () => void;
}

/** The app is on the phone: when it stops working, then straight to pairing. */
export function InstallDone({
  platform,
  deviceName,
  tailscaleLine,
  expiresAt,
  now,
  opening,
  onOpen,
  onPair,
}: DoneProps) {
  return (
    <div className="phone-install-done">
      <span className="phone-install-done__icon" aria-hidden>
        <SuccessIcon size={22} />
      </span>
      <h3 className="phone-install-done__title">The app is on {deviceName}</h3>
      {platform === 'ios' ? (
        <>
          <p className="phone-install-done__line">
            {expiresAt === null
              ? `With a free Apple ID, it stops opening after ${FREE_TEAM_DAYS} days. `
              : `${expiryLine(expiresAt, now)}. `}
            Reinstall from this panel takes a few minutes and needs no agent, and you’re reminded
            the day before.
          </p>
          <p className="phone-install-done__hint">
            If the phone says “Untrusted Developer”: Settings → General → VPN &amp; Device
            Management → your Apple ID → Trust.
          </p>
        </>
      ) : (
        <p className="phone-install-done__line">Android builds don’t expire.</p>
      )}
      <p className="phone-install-done__line" data-tailscale>
        Before you pair: {tailscaleLine}
      </p>
      <TailscaleStoreLinks platform={platform} />
      <div className="phone-install-done__actions">
        {onOpen && (
          <Button
            variant="secondary"
            disabled={opening}
            leftIcon={opening ? <Spinner size="sm" /> : undefined}
            onClick={onOpen}
          >
            Open on phone
          </Button>
        )}
        <Button variant="primary" data-install-pair onClick={onPair}>
          Pair it now
        </Button>
      </div>
    </div>
  );
}

interface EndedProps {
  kind: 'agent' | 'reinstall';
  exitCode: number;
  agentName: string;
  /** Read from a failed Reinstall's log; null when it's not a failure we know. */
  diagnosis: BuildDiagnosis | null;
  /** There's a phone and a team to Reinstall for right now. */
  canRetry: boolean;
  onRetry: () => void;
  /** Start the agent; after a failed Reinstall it starts from that build's log. */
  onAgent: () => void;
}

/**
 * The line under the terminal once it stops before the app is on the phone:
 * never a silent screen. A failed Reinstall says the one fix when its log
 * names one, else hands the error to the agent.
 */
export function BuildEnded({
  kind,
  exitCode,
  agentName,
  diagnosis,
  canRetry,
  onRetry,
  onAgent,
}: EndedProps) {
  const failed = kind === 'reinstall' && exitCode !== 0;
  const text =
    kind === 'agent'
      ? `${agentName} stopped before the app was installed.`
      : !failed
        ? 'The build finished. Checking the phone…'
        : diagnosis
          ? `The build failed. ${diagnosis.fix}`
          : `The build failed. ${agentName} can read the error and fix it.`;
  return (
    <div className="phone-install__ended" data-build-ended={failed ? 'failed' : kind}>
      <span>{text}</span>
      {(kind === 'agent' || failed) && (
        <span className="phone-install__ended-actions">
          {failed && diagnosis?.who === 'you' && canRetry && (
            <Button variant="secondary" size="compact" onClick={onRetry}>
              Reinstall
            </Button>
          )}
          <Button variant="secondary" size="compact" onClick={onAgent}>
            {kind === 'agent' ? `Restart ${agentName}` : `Hand it to ${agentName}`}
          </Button>
        </span>
      )}
    </div>
  );
}
