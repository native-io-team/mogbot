/**
 * Your phone, one screen at a time: get the app → Tailscale on this Mac →
 * Tailscale on your phone, same account → turn on phone access → the code,
 * big and alone → Allow the phone that used it → Paired.
 *
 * One question and one big button per screen, said in the words the phone
 * says from its side (`companion-protocol/src/pairWords.ts`). Every tick is
 * this Mac's own check (its Tailscale, a phone on its tailnet, phone access,
 * the phone's request); where only the person can know (the app is on the
 * phone), the button says so ("I already have the app"), and nothing is ticked.
 *
 * The same screens run in onboarding (inside `FlowShell`) and in the Phone
 * panel (inside its own small frame): the caller passes `render`, which
 * draws one screen's parts in its own shell.
 *
 * @module components/phone/PhoneFlow
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import {
  ArrowLeftIcon,
  BellIcon,
  CheckIcon,
  CommentIcon,
  ExternalLinkIcon,
  LaptopIcon,
  MobileIcon,
  ShieldCheckIcon,
  WarningIcon,
} from '@/components/icons';
import { CheckLine, ADVANCE_MS } from '../setup/flow/FlowParts';
import { PhoneQr } from './PhoneQr';
import { usePolling } from '../../hooks/usePolling';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { BRAND } from '../../lib/brand';
import {
  accountOf,
  phoneViaRelay,
  savePhoneRoute,
  SIGN_IN,
  signedInLine,
  signInCheck,
} from '../../lib/account';
import { useSignIn } from '../../hooks/useAccount';
import { TAILSCALE_DOWNLOAD_URL } from '../../lib/remoteAccess';
import {
  GET_ON_TESTFLIGHT,
  PHONE_APP_ON_ANDROID,
  PHONE_APP_STORE_URL,
  PHONE_APP_TESTFLIGHT_URL,
} from '../../lib/phoneApp';
import { formatClock } from '../../../packages/companion-protocol/src/clock';
import {
  COMPANION_CHANGED_EVENT,
  decidePairing,
  deviceLine,
  expiresIn,
  getLinkQr,
  getPhoneStatus,
  getTailnetPhones,
  phoneStep,
  phoneTailscaleSignIn,
  phoneTailnetCheck,
  phoneTailnetTroubleSteps,
  PHONE_TAILNET_PATIENCE_MS,
  retryPhoneTailscale,
  setPhoneAccess,
  startPairing,
  TAILSCALE_ANDROID_URL,
  TAILSCALE_IOS_URL,
  type PairingCode,
  type PhoneStatus,
  type TailnetPhone,
  type TailscaleState,
} from '../../lib/companion';
import type { CheckResult } from '../../lib/onboardingFlow';
import {
  ALLOW_BUTTON,
  GET_PHONE_APP_TITLE,
  I_DID_IT,
  PHONE_ACCESS_TITLE,
  SCAN_LINE,
  SKIP_FOR_NOW,
  TAILSCALE_ACCOUNT_LINE,
  TAILSCALE_LINE,
  TAILSCALE_MAC_TITLE,
  TAILSCALE_YOUR_PHONE_TITLE,
} from '../../../packages/companion-protocol/src/pairWords';

export const PHONE_FLOW_STEPS = [
  'phoneGetApp',
  'phoneMacTailscale',
  'phonePhoneTailscale',
  'phoneAccess',
  'phoneScan',
  'phoneAllow',
  'phonePaired',
] as const;
export type PhoneFlowStep = (typeof PHONE_FLOW_STEPS)[number];

/** Back: the screen before; Allow and Paired go back to the code. */
export function prevPhoneStep(step: PhoneFlowStep, relay = phoneViaRelay()): PhoneFlowStep | null {
  if (step === 'phoneAllow' || step === 'phonePaired') return 'phoneScan';
  if (relay && step === 'phoneAccess') return 'phoneGetApp';
  return PHONE_FLOW_STEPS[PHONE_FLOW_STEPS.indexOf(step) - 1] ?? null;
}

/**
 * After the phone app: Tailscale on this Mac, or, when phones come through
 * the relay (docs/relay.md), straight to turning phone access on (signing
 * in, there). "Use Tailscale instead" there puts Tailscale's screens back
 * (`savePhoneRoute`).
 */
export function afterGetApp(relay = phoneViaRelay()): PhoneFlowStep {
  return relay ? 'phoneAccess' : 'phoneMacTailscale';
}

/** One screen's parts, for the caller's shell to draw. */
export interface StepView {
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  mark?: ReactNode;
}

/**
 * Moves on by itself once a check passes *on this screen*: arriving on a
 * step that's already done shows Done and waits for the button, so nobody
 * is carried past a screen they never saw.
 */
export function useAdvanceWhenPassed(pass: boolean, next: () => void, screen: string) {
  // What the check said when this screen arrived, per screen (derived
  // state: reset during render when the screen changes).
  const [arrival, setArrival] = useState({ screen, pass });
  if (arrival.screen !== screen) setArrival({ screen, pass });
  const passedOnArrival = arrival.screen === screen ? arrival.pass : pass;
  const nextRef = useRef(next);
  useEffect(() => {
    nextRef.current = next;
  });
  useEffect(() => {
    if (!pass || passedOnArrival) return;
    const t = setTimeout(() => nextRef.current(), ADVANCE_MS);
    return () => clearTimeout(t);
  }, [pass, passedOnArrival]);
}

/** The big button, marked as the screen's one answer (FLOW_FOCUS_TARGET). */
export function Primary({
  children,
  onClick,
  disabled,
  busy,
  strong = false,
  external = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** An answer (Allow): neutral, never the accent. */
  strong?: boolean;
  external?: boolean;
}) {
  return (
    <Button
      variant={strong ? 'strong' : 'primary'}
      size="large"
      onClick={onClick}
      disabled={disabled || busy}
      leftIcon={busy ? <Spinner size="sm" /> : undefined}
      rightIcon={external ? <ExternalLinkIcon size={12} /> : undefined}
      data-flow-primary
    >
      {children}
    </Button>
  );
}

export function Skip({ onSkip, label = SKIP_FOR_NOW }: { onSkip: () => void; label?: string }) {
  return (
    <Button variant="ghost" onClick={onSkip} data-flow-skip>
      {label}
    </Button>
  );
}

/**
 * Tailscale on this Mac, from either status (phone access's or remote
 * access's: both read the same `tailscale status`). Shared by the phone and
 * by bringing agents over Remote Access.
 */
export function tailscaleMacCheck(t: TailscaleState | undefined): CheckResult {
  if (!t) return { state: 'checking', line: 'Checking Tailscale on this Mac…' };
  switch (t.state) {
    case 'connected':
      return {
        state: 'pass',
        line: t.login ? `Tailscale is on, signed in as ${t.login}.` : 'Tailscale is on.',
      };
    // Not installed or not signed in yet is the user's move, not a failure:
    // "Waiting for you", neutral, never an amber "Not done yet" on arrival.
    case 'needsLogin':
      return {
        state: 'waiting',
        line: 'Tailscale is installed but not signed in.',
        fix: 'Click the Tailscale icon in the menu bar, sign in, and switch it on. This ticks by itself.',
      };
    case 'notInstalled':
      return {
        state: 'waiting',
        line: 'Tailscale isn’t on this Mac yet.',
        fix: 'Download it, open it, sign in (or make a free account) and switch it on. It asks to add a VPN configuration: click Allow. This ticks by itself.',
      };
    case 'unknown':
      return { state: 'fail', line: 'Couldn’t read Tailscale on this Mac.', fix: t.detail };
  }
}

/** The Tailscale-on-this-Mac screen's parts. */
export function tailscaleMacView({
  tailscale,
  checking,
  onCheck,
  onNext,
  skip,
}: {
  tailscale: TailscaleState | undefined;
  checking: boolean;
  onCheck: () => void;
  onNext: () => void;
  skip: ReactNode;
}): StepView {
  const check = tailscaleMacCheck(tailscale);
  const notInstalled = tailscale?.state === 'notInstalled';
  return {
    title: TAILSCALE_MAC_TITLE,
    lede: `${TAILSCALE_LINE} ${TAILSCALE_ACCOUNT_LINE}`,
    children: (
      <CheckLine
        result={check}
        checking={checking}
        onCheckAgain={check.state === 'fail' || check.state === 'waiting' ? onCheck : undefined}
      />
    ),
    primary:
      check.state === 'pass' ? (
        <Primary onClick={onNext}>Continue</Primary>
      ) : notInstalled ? (
        <Primary external onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}>
          Get Tailscale for Mac
        </Primary>
      ) : undefined,
    secondary: skip,
  };
}

interface PhoneFlowProps {
  step: PhoneFlowStep;
  go: (step: PhoneFlowStep) => void;
  /** Leave the flow: "Skip for now" on any screen. */
  onSkip: () => void;
  /** After Paired. */
  onDone: () => void;
  doneLabel: string;
  /** "Build it on this Mac", when this build can. */
  onInstall?: () => void;
  render: (step: PhoneFlowStep, view: StepView) => ReactNode;
}

const errText = (e: unknown) => formatCommandError(asCommandError(e));

export function PhoneFlow({
  step,
  go,
  onSkip,
  onDone,
  doneLabel,
  onInstall,
  render,
}: PhoneFlowProps) {
  const { showToast } = useOptionalToast();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [phones, setPhones] = useState<TailnetPhone[] | null>(null);
  const [paired, setPaired] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await getPhoneStatus();
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    let closed = false;
    void listen(COMPANION_CHANGED_EVENT, () => void load()).then((fn) => {
      if (closed) fn();
      else unlisten = fn;
    });
    return () => {
      closed = true;
      unlisten?.();
    };
  }, [load]);

  usePolling(
    async () => {
      setNow(Date.now());
      return load();
    },
    { intervalMs: 3000, name: 'phone-flow' }
  );
  usePolling(() => Promise.resolve(setNow(Date.now())), {
    intervalMs: 1000,
    enabled: step === 'phoneScan' && code !== null,
    name: 'phone-flow-clock',
  });
  // A phone on this Mac's tailnet, switched on: the phone's Tailscale step's own check.
  usePolling(
    async () => {
      const list = await getTailnetPhones().catch(() => null);
      setPhones(list);
      return list;
    },
    { intervalMs: 4000, enabled: step === 'phonePhoneTailscale', name: 'phone-flow-tailnet' }
  );

  const run = useCallback(
    async (key: string, fn: () => Promise<PhoneStatus | void>) => {
      setBusy(key);
      try {
        const next = await fn();
        if (next) setStatus(next);
        else await load();
      } catch (err) {
        showToast(errText(err), 'error');
      } finally {
        setBusy(null);
      }
    },
    [load, showToast]
  );

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await retryPhoneTailscale());
    } catch {
      await load();
    } finally {
      setChecking(false);
    }
  }, [load]);

  const ready = status ? phoneStep(status).kind === 'ready' : false;
  const request = status?.pairing.request;
  const signIn = useSignIn(accountOf(status));

  // The code: made on arrival once phone access is ready, and again after it
  // ran out, was used, or a request was denied.
  const issuing = useRef(false);
  const issue = useCallback(async () => {
    if (issuing.current) return;
    issuing.current = true;
    try {
      setCode(await startPairing());
      setNow(Date.now());
      await load();
    } catch (err) {
      showToast(errText(err), 'error');
    } finally {
      issuing.current = false;
    }
  }, [load, showToast]);
  const codeLive = !!code && code.expiresAt > now && status?.pairing.active !== false;
  useEffect(() => {
    if (step === 'phoneScan' && ready && !request && !code) void issue();
  }, [step, ready, request, code, issue]);
  useEffect(() => {
    if (code && status && !status.pairing.active && !status.pairing.request) setCode(null);
  }, [code, status]);

  // The phone asked: the Allow screen, on whichever screen this is.
  useEffect(() => {
    if (request && (step === 'phoneScan' || step === 'phoneAccess')) go('phoneAllow');
    if (!request && step === 'phoneAllow' && status && !busy && !paired) go('phoneScan');
  }, [request, step, status, busy, paired, go]);
  // Resumed on the code with phone access off since: back to turning it on.
  useEffect(() => {
    if (step === 'phoneScan' && status && !ready) go('phoneAccess');
  }, [step, status, ready, go]);

  const skip = <Skip onSkip={onSkip} />;

  const decide = (allow: boolean, replace: string[]) => {
    if (!request) return;
    const name = request.device.name;
    void run(allow ? 'allow' : 'deny', async () => {
      await decidePairing(request.id, allow, replace);
      setCode(null);
      if (allow) {
        setPaired(name);
        go('phonePaired');
      } else {
        go('phoneScan');
      }
    });
  };

  const view = useStepView({
    step,
    status,
    busy,
    checking,
    code,
    codeLive,
    now,
    phones,
    paired,
    skip,
    go,
    onDone,
    doneLabel,
    onInstall,
    recheck,
    issue,
    decide,
    enable: () => void run('enable', () => setPhoneAccess(true)),
    signIn,
  });
  return <>{render(step, view)}</>;
}

function useStepView(p: {
  step: PhoneFlowStep;
  status: PhoneStatus | null;
  busy: string | null;
  checking: boolean;
  code: PairingCode | null;
  codeLive: boolean;
  now: number;
  phones: TailnetPhone[] | null;
  paired: string | null;
  skip: ReactNode;
  go: (s: PhoneFlowStep) => void;
  onDone: () => void;
  doneLabel: string;
  onInstall?: () => void;
  recheck: () => Promise<void>;
  issue: () => Promise<void>;
  decide: (allow: boolean, replace: string[]) => void;
  enable: () => void;
  signIn: ReturnType<typeof useSignIn>;
}): StepView {
  const { step, status, skip, go } = p;
  const access = status ? phoneStep(status) : null;
  const onPhone = p.phones?.find((ph) => ph.online) ?? null;
  // A saved step from before the relay: its Tailscale screens are passed over now.
  const viaRelay = phoneViaRelay();
  const passedOver = viaRelay && (step === 'phoneMacTailscale' || step === 'phonePhoneTailscale');
  useEffect(() => {
    if (passedOver) go('phoneAccess');
  }, [passedOver, go]);
  // Each check's own "moved on by itself", per screen.
  useAdvanceWhenPassed(
    step === 'phoneMacTailscale' && status?.tailscale.state === 'connected',
    () => go('phonePhoneTailscale'),
    step
  );
  useAdvanceWhenPassed(step === 'phonePhoneTailscale' && !!onPhone, () => go('phoneAccess'), step);
  // Looking for the phone: quiet at first, then how to fix it.
  const [slowOn, setSlowOn] = useState<string | null>(null);
  useEffect(() => {
    if (step !== 'phonePhoneTailscale') return;
    const t = setTimeout(() => setSlowOn(step), PHONE_TAILNET_PATIENCE_MS);
    return () => {
      clearTimeout(t);
      setSlowOn(null);
    };
  }, [step]);
  const slowTailnet = slowOn === step;
  useAdvanceWhenPassed(
    step === 'phoneAccess' && access?.kind === 'ready',
    () => go('phoneScan'),
    step
  );

  switch (step) {
    case 'phoneGetApp': {
      const store = PHONE_APP_STORE_URL;
      const testFlight = store ? null : PHONE_APP_TESTFLIGHT_URL;
      if (testFlight) {
        // The beta: the link is the way, so it is the big button, and its
        // code is beside it, since the phone's camera opens it straight from
        // this screen. Only the person knows when it's installed.
        return {
          title: GET_PHONE_APP_TITLE,
          // People took this code for the pairing code: it says plainly what it is
          // (the download) and what it isn't, and those who have the app skip it.
          lede: 'Don’t have it yet? Point your iPhone’s camera at this code to download the free beta from TestFlight.',
          children: (
            <LinkQr
              url={testFlight}
              label="Download link for the phone app on TestFlight"
              caption={DOWNLOAD_NOT_PAIRING}
            />
          ),
          primary: (
            <Primary external onClick={() => void openUrl(testFlight)}>
              {GET_ON_TESTFLIGHT}
            </Primary>
          ),
          secondary: (
            <>
              <Button
                variant="secondary"
                size="large"
                onClick={() => go(afterGetApp())}
                data-flow-have-it
              >
                {HAVE_PHONE_APP}
              </Button>
              {skip}
            </>
          ),
        };
      }
      return {
        title: GET_PHONE_APP_TITLE,
        lede: store
          ? 'It’s free on the App Store. Install it on your iPhone.'
          : 'On your iPhone, open the TestFlight invite you were sent and install it.',
        children: (store || p.onInstall) && (
          <div className="flow-links">
            {store && (
              <Button
                variant="secondary"
                rightIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openUrl(store)}
                data-app-store
              >
                Open the App Store
              </Button>
            )}
            {!store && p.onInstall && (
              <Button variant="secondary" onClick={p.onInstall} data-install-open>
                Build it on this Mac…
              </Button>
            )}
          </div>
        ),
        primary: <Primary onClick={() => go(afterGetApp())}>{HAVE_PHONE_APP}</Primary>,
        secondary: skip,
      };
    }
    case 'phoneMacTailscale':
      return tailscaleMacView({
        tailscale: status?.tailscale,
        checking: p.checking,
        onCheck: () => void p.recheck(),
        onNext: () => go('phonePhoneTailscale'),
        skip,
      });
    case 'phonePhoneTailscale': {
      const check = phoneTailnetCheck(p.phones ?? null, status?.tailscale ?? null, slowTailnet);
      return {
        title: TAILSCALE_YOUR_PHONE_TITLE,
        lede: `Install Tailscale on your phone, ${phoneTailscaleSignIn(status?.tailscale ?? null)}, and switch it on. It asks to add a VPN configuration: tap Allow. This Mac sees your phone a few seconds after it says Connected.`,
        children: (
          <>
            <CheckLine result={check} />
            {!onPhone && (
              <TailnetTrouble steps={phoneTailnetTroubleSteps(status?.tailscale ?? null)} />
            )}
            <div className="flow-links">
              <Button
                variant="secondary"
                rightIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openUrl(TAILSCALE_IOS_URL)}
              >
                App Store
              </Button>
              {PHONE_APP_ON_ANDROID && (
                <Button
                  variant="ghost"
                  rightIcon={<ExternalLinkIcon size={12} />}
                  onClick={() => void openUrl(TAILSCALE_ANDROID_URL)}
                >
                  Google Play
                </Button>
              )}
            </div>
          </>
        ),
        primary: (
          <Primary onClick={() => go('phoneAccess')}>{onPhone ? 'Continue' : I_DID_IT}</Primary>
        ),
        secondary: skip,
      };
    }
    case 'phoneAccess': {
      if (viaRelay && status && !accountOf(status)) return relaySignInView(p);
      if (viaRelay && status && access?.kind !== 'ready') return relayAccessView(p);
      const check: CheckResult | null = !access
        ? { state: 'checking', line: 'Checking phone access…' }
        : access.kind === 'ready'
          ? { state: 'pass', line: 'Phone access is on.' }
          : access.kind === 'starting'
            ? { state: 'checking', line: 'Starting…' }
            : access.kind === 'approveHttps'
              ? {
                  state: 'waiting',
                  line: 'Tailscale asks you to approve HTTPS certificates once, on its own page.',
                  fix: 'It lets your phone trust this Mac. Approve it there, then come back.',
                  action: { label: 'Open the Tailscale page', url: access.url },
                }
              : access.kind === 'failed'
                ? {
                    state: 'fail',
                    line: 'Tailscale didn’t start phone access.',
                    fix: access.detail,
                  }
                : access.kind === 'installTailscale' || access.kind === 'signInTailscale'
                  ? {
                      state: 'fail',
                      line: 'Tailscale on this Mac isn’t ready.',
                      fix: 'Go back one step and finish it.',
                    }
                  : null;
      return {
        title: PHONE_ACCESS_TITLE,
        lede: 'Lets your phone reach this Mac over Tailscale, so this Mac has to stay on while you use it.',
        children: check && (
          <CheckLine
            result={check}
            checking={p.checking}
            onCheckAgain={
              check.state === 'fail' || check.state === 'waiting'
                ? () => void p.recheck()
                : undefined
            }
          />
        ),
        primary:
          access?.kind === 'off' ? (
            <Primary busy={p.busy === 'enable'} onClick={p.enable}>
              Turn on phone access
            </Primary>
          ) : access?.kind === 'ready' ? (
            <Primary onClick={() => go('phoneScan')}>Continue</Primary>
          ) : undefined,
        secondary: skip,
      };
    }
    case 'phoneScan': {
      const left = p.code ? expiresIn(p.code.expiresAt, p.now) : null;
      const reachedAt = status?.pairing.reachedAt;
      return {
        title: SCAN_LINE,
        children: (
          <div className="flow-qr" data-testid="flow-qr">
            {p.code && p.codeLive ? (
              <div className="flow-qr__frame">
                <PhoneQr
                  size={p.code.qr.size}
                  modules={p.code.qr.modules}
                  pixels={280}
                  label={`Pairing code for the ${BRAND.name} phone app`}
                />
              </div>
            ) : p.code ? null : (
              <Spinner size="lg" />
            )}
            {p.code && !p.codeLive ? (
              <p className="flow-facts">This code ran out.</p>
            ) : reachedAt !== undefined ? (
              <span className="flow-qr__meta" role="status" data-testid="phone-code-reached">
                <Spinner size="sm" /> A device reached this Mac at {formatClock(reachedAt)}. Waiting
                for it to send the code…
              </span>
            ) : (
              left && <span className="flow-qr__meta">Works once, for {left}</span>
            )}
          </div>
        ),
        primary:
          p.code && !p.codeLive ? (
            <Primary onClick={() => void p.issue()}>Show a new code</Primary>
          ) : undefined,
        secondary: skip,
      };
    }
    case 'phoneAllow': {
      const request = status?.pairing.request;
      if (!request) return { title: 'Waiting for your phone…', secondary: skip };
      const { device, replaces } = request;
      const busy = p.busy !== null;
      return {
        title: `${ALLOW_BUTTON} ${device.name}?`,
        lede: `Only if it’s the phone in your hand, showing a code that ends in ${request.codeHint}. It will be able to read and send messages to every agent.`,
        children: (
          <>
            <p className="flow-facts" data-testid="phone-confirm-meta">
              {[deviceLine(device), `asked at ${formatClock(request.requestedAt)}`, request.login]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {replaces.length > 0 && (
              <p className="flow-facts" data-testid="phone-confirm-replaces">
                <WarningIcon size={12} />{' '}
                {replaces.length === 1
                  ? `A phone called ${replaces[0].name} is already paired. If this is that phone again, Allow replaces it.`
                  : `${replaces.length} phones called ${device.name} are already paired. If this is one of them again, Allow replaces them.`}
              </p>
            )}
          </>
        ),
        primary: (
          <Primary
            strong
            busy={p.busy === 'allow'}
            disabled={busy}
            onClick={() =>
              p.decide(
                true,
                replaces.map((d) => d.id)
              )
            }
          >
            {ALLOW_BUTTON}
          </Primary>
        ),
        secondary: (
          <Button variant="ghost" disabled={busy} onClick={() => p.decide(false, [])} data-deny>
            Deny
          </Button>
        ),
      };
    }
    case 'phonePaired':
      // The end of setting up: a moment, not a settings line. This Mac and the
      // phone, joined, then what the phone can do now.
      return {
        mark: (
          <div className="flow-paired" data-testid="flow-paired">
            <span className="flow-paired__device">
              <LaptopIcon size={26} />
            </span>
            <span className="flow-paired__link" aria-hidden>
              <span className="flow-paired__check">
                <CheckIcon size={14} />
              </span>
            </span>
            <span className="flow-paired__device">
              <MobileIcon size={26} />
            </span>
          </div>
        ),
        title: ALL_SET_TITLE,
        lede: p.paired
          ? `${p.paired} is paired with this Mac. Your agents go where you go.`
          : 'Your phone is paired with this Mac. Your agents go where you go.',
        children: (
          <ul className="flow-paired__can" aria-label="What your phone can do now">
            {PHONE_CAN.map(({ icon, text }) => (
              <li key={text}>
                <span className="flow-paired__can-icon">{icon}</span>
                {text}
              </li>
            ))}
          </ul>
        ),
        primary: <Primary onClick={p.onDone}>{p.doneLabel}</Primary>,
      };
  }
}

/**
 * Phone access in a build with the relay, not signed in: signing in is how
 * the phone reaches this Mac (anywhere, no Tailscale), and "Use Tailscale
 * instead" is the open-source way, its own screens put back.
 */
function relaySignInView(p: Parameters<typeof useStepView>[0]): StepView {
  const { signIn, go, skip } = p;
  const check = signInCheck({ account: null, ...signIn });
  return {
    title: 'Sign in so your phone can reach this Mac',
    lede: 'From anywhere, with no Tailscale to set up. This Mac has to stay on while you use it.',
    children:
      check && check.state !== 'checking' ? (
        <CheckLine result={check} />
      ) : (
        <p className="flow-note">
          With Google or your email, in your browser.
          {p.status && !p.status.enabled && ' Signing in also turns on phone access on this Mac.'}
        </p>
      ),
    primary: (
      <Primary busy={signIn.starting} onClick={() => void signIn.start()}>
        {signIn.waiting ? 'Try again' : SIGN_IN}
      </Primary>
    ),
    secondary: (
      <>
        <Button
          variant="secondary"
          size="large"
          onClick={() => {
            savePhoneRoute('tailscale');
            go('phoneMacTailscale');
          }}
          data-phone-use-tailscale
        >
          Use Tailscale instead
        </Button>
        {skip}
      </>
    ),
  };
}

/** Signed in, phone access off or the relay still connecting. */
function relayAccessView(p: Parameters<typeof useStepView>[0]): StepView {
  const account = accountOf(p.status);
  const off = !p.status?.enabled;
  return {
    title: PHONE_ACCESS_TITLE,
    lede: `${account ? signedInLine(account) + ' ' : ''}Your phone reaches this Mac through your account, so this Mac has to stay on while you use it.`,
    children: !off && <CheckLine result={{ state: 'checking', line: 'Connecting…' }} />,
    primary: off ? (
      <Primary busy={p.busy === 'enable'} onClick={p.enable}>
        Turn on phone access
      </Primary>
    ) : undefined,
    secondary: p.skip,
  };
}

/** The last screen's title: the person is done, not just the pairing. */
export const ALL_SET_TITLE = 'You’re all set';

/** What the phone can do now, on the last screen. */
const PHONE_CAN = [
  { icon: <CommentIcon size={14} />, text: 'Message any agent, wherever you are' },
  { icon: <ShieldCheckIcon size={14} />, text: 'Answer approvals, even from the Lock Screen' },
  { icon: <BellIcon size={14} />, text: 'Get a ping when one needs you' },
];

/** Where the Phone panel's flow stopped, so reopening it opens the same screen. */
export const PANEL_FLOW_KEY = 'shipstudio.phone.flow';

export function readPanelStep(): PhoneFlowStep | null {
  try {
    const raw = window.localStorage.getItem(PANEL_FLOW_KEY);
    if (raw === 'phoneAllow' || raw === 'phonePaired') return 'phoneScan';
    return (PHONE_FLOW_STEPS as readonly string[]).includes(raw ?? '')
      ? (raw as PhoneFlowStep)
      : null;
  } catch {
    return null;
  }
}

export function savePanelStep(step: PhoneFlowStep | null) {
  try {
    if (step) window.localStorage.setItem(PANEL_FLOW_KEY, step);
    else window.localStorage.removeItem(PANEL_FLOW_KEY);
  } catch {
    // Storage blocked: the panel opens on the first screen next time.
  }
}

/**
 * The same screens inside the Phone panel: Back, a bar for these seven
 * screens, one question, one big button. Smaller than onboarding's full
 * window, never a list of cards.
 */
/**
 * A web page's address as a code the phone's camera opens (the Mac draws the
 * modules). A spinner while it's made; on a failure, nothing: the button
 * under it opens the same page.
 */
/** "Not working?": what to check when this Mac can't see the phone on Tailscale. */
function TailnetTrouble({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <TextButton
        tabIndex={0}
        className="flow-trouble-toggle"
        onClick={() => setOpen(true)}
        data-testid="tailnet-not-working"
      >
        Not working?
      </TextButton>
    );
  }
  return (
    <ol className="flow-trouble" data-testid="tailnet-trouble">
      {steps.map((line) => {
        const cut = line.indexOf('. ');
        return (
          <li key={line}>
            <strong>{line.slice(0, cut + 1)}</strong> {line.slice(cut + 2)}
          </li>
        );
      })}
    </ol>
  );
}

/** Under the TestFlight code: it downloads the app, it doesn't pair. */
export const DOWNLOAD_NOT_PAIRING =
  'This only downloads the app. It isn’t the pairing code: you’ll scan that in a few steps.';
/** The way past the download, for someone who has the app already. */
export const HAVE_PHONE_APP = 'I already have the app';

function LinkQr({ url, label, caption }: { url: string; label: string; caption?: string }) {
  const { data, error } = useAsyncState(() => getLinkQr(url), { immediate: true });
  if (error) return null;
  return (
    <div className="flow-qr" data-testid="flow-link-qr">
      {data ? (
        <div className="flow-qr__frame">
          <PhoneQr size={data.size} modules={data.modules} pixels={200} label={label} />
        </div>
      ) : (
        <Spinner size="lg" />
      )}
      {caption && (
        <p className="flow-qr__meta" data-testid="flow-link-qr-caption">
          {caption}
        </p>
      )}
    </div>
  );
}

export function PanelStepShell({
  step,
  view,
  onBack,
}: {
  step: PhoneFlowStep;
  view: StepView;
  onBack?: () => void;
}) {
  const at = PHONE_FLOW_STEPS.indexOf(step);
  const screen = useRef<HTMLDivElement>(null);
  // As onboarding: with nothing focused, the big button takes it, so Enter goes on.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    screen.current?.querySelector<HTMLElement>('[data-flow-primary]:not(:disabled)')?.focus();
  });
  return (
    <div className="phone-flow" data-phone-flow-step={step} ref={screen}>
      <div className="phone-flow__top">
        <div className="phone-flow__back">
          {onBack && (
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<ArrowLeftIcon size={14} />}
              onClick={onBack}
              data-flow-back
            >
              Back
            </Button>
          )}
        </div>
        <div
          className="phone-flow__bar"
          role="progressbar"
          aria-label="Phone setup progress"
          aria-valuemin={1}
          aria-valuemax={PHONE_FLOW_STEPS.length}
          aria-valuenow={at + 1}
        >
          <span
            className="phone-flow__fill"
            style={{ width: `${Math.round(((at + 1) / PHONE_FLOW_STEPS.length) * 100)}%` }}
          />
        </div>
        <div className="phone-flow__back" aria-hidden />
      </div>
      {/* As onboarding's frame: the question at the top, the answers at the
          foot, so neither moves from one screen to the next. */}
      <div key={step} className="phone-flow__body">
        <div className="phone-flow__head">
          {view.mark}
          <h2 className="phone-flow__title">{view.title}</h2>
          {view.lede && <p className="phone-flow__lede">{view.lede}</p>}
        </div>
        {view.children && <div className="phone-flow__content">{view.children}</div>}
        <div className="phone-flow__actions">
          <div className="phone-flow__primary">{view.primary}</div>
          {view.secondary && <div className="phone-flow__secondary">{view.secondary}</div>}
        </div>
      </div>
    </div>
  );
}
