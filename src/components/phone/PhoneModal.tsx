/**
 * PhoneModal — phone access for the mobile companion: turn it on, pair a
 * phone with a QR code and a click to Allow, and see or remove paired
 * phones.
 *
 * Owns the data: status (re-read on `companion://changed`, so a phone
 * arriving at the desk shows at once, and polled every few seconds while
 * open) and the code it just issued.
 *
 * @module components/phone/PhoneModal
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Checkbox } from '../primitives/Checkbox';
import { TextButton } from '../primitives/TextButton';
import { useOpenModal } from '../../contexts/ModalContext';
import { CheckIcon, CloseIcon, ExternalLinkIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { TAILSCALE_DOWNLOAD_URL } from '../../lib/remoteAccess';
import { relayOn } from '../../lib/brand';
import { accountOf, SIGN_IN, type Account } from '../../lib/account';
import { useSignIn } from '../../hooks/useAccount';
import {
  cancelPairing,
  COMPANION_CHANGED_EVENT,
  decidePairing,
  getPhoneStatus,
  phoneCapabilities,
  phoneStep,
  PUSH_COPY,
  relayReady,
  removePhone,
  retryPhoneTailscale,
  setPhoneAccess,
  setPhonePush,
  shortUrl,
  startPairing,
  takePairOnOpen,
  type Device,
  type PairingCode,
  type PhoneStatus,
  type PhoneStep,
} from '../../lib/companion';
import { PairCode, PairConfirm, PairOffer } from './PhonePairing';
import { PhoneDevices } from './PhoneDevices';
import { PhoneInstall } from './PhoneInstall';
import { PhoneInstallEntry } from './PhoneInstallEntry';
import {
  PanelStepShell,
  PhoneFlow,
  afterGetApp,
  prevPhoneStep,
  readPanelStep,
  savePanelStep,
  type PhoneFlowStep,
} from './PhoneFlow';
import {
  COMPANION_INSTALL_ENABLED,
  readInstallRecord,
  takeInstallOnOpen,
  type InstallPlatform,
} from '../../lib/companionInstall';
import { THIS_COMPUTER } from '../../lib/computer';

const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

interface PhoneModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Where the panel is drawn: a title, a class, and the body. */
type Frame = (title: string, className: string, body: ReactNode) => ReactNode;

/** The panel as its own dialog (the sidebar's Phone row, ⌘K). */
export function PhoneModal({ isOpen, onClose }: PhoneModalProps) {
  return (
    <PhonePanel
      isOpen={isOpen}
      onClose={onClose}
      frame={(title, className, body) => (
        <ModalFrame isOpen={isOpen} onClose={onClose} title={title} className={className}>
          {body}
        </ModalFrame>
      )}
    />
  );
}

/** The same panel inline on Settings → Phone: no dialog on top of a dialog. */
export function PhoneSettingsPanel() {
  return (
    <PhonePanel
      isOpen
      inline
      onClose={() => {}}
      frame={(title, className, body) => (
        <section
          className={`settings-inline-panel ${className}`}
          aria-label={title}
          data-settings-inline="phone"
        >
          {body}
        </section>
      )}
    />
  );
}

function PhonePanel({
  isOpen,
  onClose,
  frame,
  inline = false,
}: PhoneModalProps & { frame: Frame; inline?: boolean }) {
  const { showToast } = useOptionalToast();
  const openModal = useOpenModal();
  const status = useAsyncState<PhoneStatus>(getPhoneStatus);
  const { execute: load, setData: setStatus } = status;
  const [code, setCode] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // "Install on my phone": the route choice, or a reinstall for one platform.
  const [install, setInstall] = useState<{ reinstall?: InstallPlatform } | null>(null);
  // No phone paired yet: the same one-screen-per-step flow as onboarding,
  // on the screen it stopped at. Null once a phone is paired or it's skipped.
  const [flow, setFlow] = useState<PhoneFlowStep | null>(null);
  const flowDecided = useRef(false);
  const goFlow = useCallback((step: PhoneFlowStep | null) => {
    savePanelStep(step);
    setFlow(step);
  }, []);
  const { copy } = useCopyToClipboard({
    onCopy: () => showToast('Pairing link copied. It works once, for five minutes.', 'success'),
  });

  const run = useCallback(
    async (key: string, fn: () => Promise<PhoneStatus | void>) => {
      setBusy(key);
      try {
        const next = await fn();
        if (next) setStatus(next);
        else await load();
        return true;
      } catch (err) {
        showToast(errMsg(err), 'error');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load, setStatus, showToast]
  );

  const pair = useCallback(
    () =>
      run('pair', async () => {
        const issued = await startPairing();
        const next = await getPhoneStatus();
        setCode(issued);
        setNow(Date.now());
        return next;
      }),
    [run]
  );

  // The first phone: the panel opens straight on its code once it can be
  // shown (from the sidebar, ⌘K, Settings or the Chief's card alike), once
  // per opening, so Cancel stays cancelled.
  const autoIssued = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      setCode(null);
      setInstall(null);
      setFlow(null);
      flowDecided.current = false;
      autoIssued.current = false;
      return;
    }
    if (takeInstallOnOpen() && COMPANION_INSTALL_ENABLED) setInstall({});
    let unlisten: (() => void) | undefined;
    let closed = false;
    void listen(COMPANION_CHANGED_EVENT, () => void load()).then((fn) => {
      if (closed) fn();
      else unlisten = fn;
    });
    void load().then((s) => {
      // "Pair your phone" (sidebar, ⌘K): straight to the code when it can be shown.
      if (takePairOnOpen() && s && phoneStep(s).kind === 'ready' && !autoIssued.current) {
        autoIssued.current = true;
        void pair();
      }
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [isOpen, load, pair]);

  const s = status.data;
  const pairing = s?.pairing;
  const showingCode = code !== null && pairing?.active === true && code.expiresAt > now;

  // Status every few seconds (each read asks Tailscale); the phone arriving
  // at the desk is pushed by `companion://changed` rather than polled for.
  usePolling(
    async () => {
      setNow(Date.now());
      return load();
    },
    { intervalMs: 5000, enabled: isOpen, name: 'phone-access' }
  );
  // The code's countdown: a clock, no backend.
  usePolling(() => Promise.resolve(setNow(Date.now())), {
    intervalMs: 1000,
    enabled: showingCode,
    name: 'phone-code-clock',
  });

  // No phone paired yet and the last setup step just went green: the code,
  // without another click.
  // First look with no phone paired: into the flow (it makes its own code).
  useEffect(() => {
    if (!isOpen || !s || flowDecided.current) return;
    flowDecided.current = true;
    if (s.devices.length === 0) {
      autoIssued.current = true;
      setFlow(readPanelStep() ?? (readInstallRecord() ? afterGetApp() : 'phoneGetApp'));
    }
  }, [isOpen, s]);

  const firstReady = !!s && s.devices.length === 0 && phoneStep(s).kind === 'ready';
  useEffect(() => {
    if (!isOpen || !firstReady || code || pairing?.request || busy !== null) return;
    if (autoIssued.current) return;
    autoIssued.current = true;
    void pair();
  }, [isOpen, firstReady, code, pairing?.request, busy, pair]);

  // The code was used, cancelled or ran out: let it go.
  useEffect(() => {
    if (code && pairing && !pairing.active) setCode(null);
  }, [code, pairing]);

  const decide = (allow: boolean, replace: string[]) => {
    const request = pairing?.request;
    if (!request) return;
    const name = request.device.name;
    void run('decide', async () => {
      await decidePairing(request.id, allow, replace);
      if (allow) showToast(`${name} is paired.`, 'success');
    });
  };

  const remove = (device: Device) =>
    void run('remove', async () => {
      const next = await removePhone(device.id);
      showToast(`Removed ${device.name}.`, 'success');
      return next;
    });

  if (install) {
    return frame(
      'Get the phone app',
      'phone-modal phone-modal--install',
      <PhoneInstall
        reinstall={install.reinstall}
        tailscale={s?.tailscale ?? null}
        onBack={() => setInstall(null)}
        onPair={() => {
          setInstall(null);
          const ready = !!s && phoneStep(s).kind === 'ready';
          // The first phone: on into the flow, on the code when it can be shown.
          if (flow || (s && s.devices.length === 0)) goFlow(ready ? 'phoneScan' : afterGetApp());
          else if (ready) void pair();
        }}
      />
    );
  }

  if (flow && s) {
    return frame(
      'Phone',
      'phone-modal phone-modal--flow',
      <div className="settings-modal-body phone-access">
        <PhoneFlow
          step={flow}
          go={goFlow}
          onSkip={() => goFlow(null)}
          onDone={() => {
            goFlow(null);
            if (!inline) onClose();
          }}
          doneLabel="Done"
          onInstall={COMPANION_INSTALL_ENABLED ? () => setInstall({}) : undefined}
          render={(step, view) => (
            <PanelStepShell
              step={step}
              view={view}
              onBack={
                step === 'phoneGetApp' || step === 'phonePaired'
                  ? undefined
                  : () => goFlow(prevPhoneStep(step))
              }
            />
          )}
        />
      </div>
    );
  }

  // "Phone", the Settings section's name, wherever it opens: the phone app
  // sends people to Settings → Phone, so the sidebar's window says the same.
  return frame(
    'Phone',
    'phone-modal',
    <div className="settings-modal-body phone-access">
      {!s ? (
        <div className="phone-loading">
          {status.error ? (
            <p className="phone-error">Couldn’t read phone access status.</p>
          ) : (
            <Spinner />
          )}
        </div>
      ) : (
        <>
          {/* The app comes first: there's nothing to connect until it's on a
                phone. Off, with no phone paired and no build from {THIS_COMPUTER}, the
                panel is the way to get it; turning access on comes after. */}
          <AccessHeader
            step={phoneStep(s)}
            account={accountOf(s)}
            busy={busy}
            onEnable={(on) => void run(on ? 'enable' : 'disable', () => setPhoneAccess(on))}
            onRetry={() => void run('retry', retryPhoneTailscale)}
          />

          {phoneStep(s).kind === 'ready' && (
            <section className="phone-section">
              {pairing?.request ? (
                <PairConfirm request={pairing.request} busy={busy} onDecide={decide} />
              ) : showingCode && code ? (
                <PairCode
                  code={code}
                  now={now}
                  busy={busy !== null}
                  tailscale={s.tailscale}
                  viaRelay={relayReady(s.relay)}
                  reachedAt={pairing?.reachedAt}
                  onCopy={() => void copy(code.link)}
                  onCancel={() => void run('cancel', cancelPairing)}
                />
              ) : (
                <PairOffer
                  busy={busy !== null}
                  first={s.devices.length === 0}
                  onPair={() => void pair()}
                />
              )}
            </section>
          )}

          {COMPANION_INSTALL_ENABLED && (
            <PhoneInstallEntry
              now={now}
              onInstall={() => setInstall({})}
              onReinstall={(platform) => setInstall({ reinstall: platform })}
            />
          )}

          {(s.enabled || s.devices.length > 0) && (
            <section className="phone-section">
              <h3 className="phone-section__title">Paired phones</h3>
              <PhoneDevices
                devices={s.devices}
                activity={s.activity}
                now={now}
                busy={busy}
                onRemove={remove}
              />
              {!s.enabled && s.devices.length > 0 && (
                <p className="phone-footnote">
                  Phone access is off. These phones stay paired and reconnect when you turn it back
                  on.
                </p>
              )}
            </section>
          )}

          {/* A build with no push service has nothing to offer here, so the
                section isn't shown at all rather than as a dead checkbox. */}
          {s.devices.length > 0 && s.push.available && (
            <PhonePush
              push={s.push}
              busy={busy}
              onChange={(on) => void run('push', () => setPhonePush(on))}
            />
          )}

          {s.devices.length > 0 && <PhoneAbilities methods={s.methods} />}

          {/* Remote access is the other way in: secondary, and said so.
                On the Settings page it sits just below, so no link. */}
          {!inline && (
            <p className="phone-footnote">
              Want to drive this from another assistant (ChatGPT, Claude, Grok…)?{' '}
              <TextButton
                onClick={() => {
                  onClose();
                  openModal('remoteAccess');
                }}
              >
                Here’s how
              </TextButton>
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface HeaderProps {
  step: PhoneStep;
  /** The account the relay names for this Mac (a build with the relay only). */
  account: Account | null;
  busy: string | null;
  onEnable: (on: boolean) => void;
  onRetry: () => void;
}

/** What phone access needs next, or that it's on. */
function AccessHeader({ step, account, busy, onEnable, onRetry }: HeaderProps) {
  const spin = (key: string) => (busy === key ? <Spinner size="sm" /> : undefined);
  const signIn = useSignIn(account);
  // On the green bar "Turn off" sits beside "Phone access is on". Beside a
  // setup step ("Install Tailscale") a bare "Turn off" read as turning off
  // the thing it asks you to install, so it names what it turns off.
  const turnOff = (
    <Button
      size="compact"
      variant="ghost"
      disabled={busy !== null}
      leftIcon={spin('disable')}
      onClick={() => onEnable(false)}
    >
      {step.kind === 'ready' ? 'Turn off' : 'Turn off phone access'}
    </Button>
  );

  if (step.kind === 'off') {
    return (
      <div className="phone-intro">
        <p className="phone-lede">
          Talk to your agents from your phone. It connects straight to {THIS_COMPUTER}, so{' '}
          {THIS_COMPUTER} has to stay on.
        </p>
        <Button
          variant="primary"
          disabled={busy !== null}
          leftIcon={spin('enable')}
          onClick={() => onEnable(true)}
        >
          Turn on phone access
        </Button>
      </div>
    );
  }

  if (step.kind === 'ready') {
    return (
      <div className="phone-onbar">
        <span className="phone-dot" aria-hidden />
        <span
          className="phone-onbar__text"
          title={
            step.url
              ? `Phones reach ${THIS_COMPUTER} at ${shortUrl(step.url)}`
              : `Phones reach ${THIS_COMPUTER} through the relay`
          }
        >
          <span className="phone-onbar__title">Phone access is on</span>
        </span>
        {turnOff}
      </div>
    );
  }

  // With our relay, Tailscale missing on this Mac isn't a problem: a free
  // sign-in is the other way, so that leads, and Tailscale is the option.
  const tailscaleMissing = step.kind === 'installTailscale' || step.kind === 'signInTailscale';
  if (relayOn() && tailscaleMissing) {
    if (account) {
      return (
        <div className="phone-problem" data-kind="connecting">
          <div className="phone-problem__head">
            <Spinner size="sm" />
            <span className="phone-problem__title">Connecting through your account…</span>
            {turnOff}
          </div>
        </div>
      );
    }
    return (
      <div className="phone-problem" data-kind="signIn">
        <div className="phone-problem__head">
          <span className="phone-problem__title">
            Sign in so your phone can reach {THIS_COMPUTER}
          </span>
          {turnOff}
        </div>
        <p className="phone-problem__detail">
          {step.kind === 'installTailscale'
            ? 'It’s free and works from anywhere. Or use your own Tailscale: install it here and on your phone, signed in to the same account.'
            : `It’s free and works from anywhere. Or use your own Tailscale: sign in to it on ${THIS_COMPUTER}.`}
        </p>
        {signIn.error && <p className="phone-error">{signIn.error}</p>}
        <div className="phone-problem__actions">
          <Button
            variant="primary"
            disabled={signIn.starting}
            leftIcon={signIn.starting ? <Spinner size="sm" /> : undefined}
            onClick={() => void signIn.start()}
            data-phone-sign-in
          >
            {signIn.waiting ? 'Try again' : SIGN_IN}
          </Button>
          {step.kind === 'installTailscale' && (
            <Button
              variant="secondary"
              rightIcon={<ExternalLinkIcon size={12} />}
              onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}
            >
              Get Tailscale
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
      </div>
    );
  }

  const problem: Record<
    Exclude<PhoneStep['kind'], 'off' | 'ready'>,
    { title: string; detail: string }
  > = {
    installTailscale: {
      title: 'Install Tailscale',
      detail: `Your phone reaches ${THIS_COMPUTER} through it. Install it here and on your phone, signed in to the same account.`,
    },
    signInTailscale: {
      title: 'Sign in to Tailscale',
      detail: `Tailscale is installed on ${THIS_COMPUTER} but not signed in.`,
    },
    approveHttps: {
      title: 'Switch on HTTPS in Tailscale',
      detail: `A one-time switch in Tailscale, so your phone can trust ${THIS_COMPUTER}.`,
    },
    failed: { title: 'Tailscale didn’t start phone access', detail: '' },
    starting: { title: 'Starting phone access…', detail: '' },
  };
  const { title, detail } = problem[step.kind];

  return (
    <div className="phone-problem" data-kind={step.kind}>
      <div className="phone-problem__head">
        {step.kind === 'starting' && <Spinner size="sm" />}
        <span className="phone-problem__title">{title}</span>
        {turnOff}
      </div>
      {detail && <p className="phone-problem__detail">{detail}</p>}
      {step.kind === 'failed' && <p className="phone-error">{step.detail}</p>}
      <div className="phone-problem__actions">
        {step.kind === 'installTailscale' && (
          <Button
            variant="primary"
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}
          >
            Get Tailscale
          </Button>
        )}
        {step.kind === 'approveHttps' && (
          <Button
            variant="primary"
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(step.url)}
          >
            Open Tailscale
          </Button>
        )}
        {step.kind !== 'starting' && (
          <Button
            variant="secondary"
            disabled={busy !== null}
            leftIcon={spin('retry')}
            onClick={onRetry}
          >
            {/* Nothing has failed while a step waits on you: you check, not retry. */}
            {step.kind === 'approveHttps'
              ? 'I’ve switched it on'
              : step.kind === 'failed'
                ? 'Try again'
                : 'Check again'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The push relay toggle, with exactly what it sends. */
function PhonePush({
  push,
  busy,
  onChange,
}: {
  push: PhoneStatus['push'];
  busy: string | null;
  onChange: (on: boolean) => void;
}) {
  return (
    <section className="phone-section">
      <h3 className="phone-section__title">Notifications</h3>
      <label className="phone-toggle">
        <Checkbox
          checked={push.enabled}
          disabled={busy !== null}
          label={PUSH_COPY.label}
          onChange={onChange}
        />
        <span className="phone-toggle__text">
          {PUSH_COPY.label}
          <span className="phone-toggle__hint">{PUSH_COPY.detail}</span>
          <span className="phone-toggle__hint">{PUSH_COPY.officialOnly}</span>
        </span>
      </label>
    </section>
  );
}

/** What a paired phone can and can't do on this Mac, from what it serves. */
function PhoneAbilities({ methods }: { methods: string[] }) {
  const { can, cannot } = phoneCapabilities(methods);
  return (
    <section className="phone-section">
      <h3 className="phone-section__title">What a paired phone can do</h3>
      <div className="phone-abilities">
        <ul className="phone-abilities__list" aria-label="Can">
          {can.map((line) => (
            <li key={line} className="phone-abilities__item" data-can>
              <CheckIcon size={12} />
              {line}
            </li>
          ))}
        </ul>
        <ul className="phone-abilities__list" aria-label="Can't">
          {cannot.map((line) => (
            <li key={line} className="phone-abilities__item">
              <CloseIcon size={12} />
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
