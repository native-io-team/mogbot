/**
 * Bringing your agents from another assistant, one screen at a time:
 * "Bring your agents from another assistant?" → Tailscale on this Mac →
 * the private link (Remote Access on, Funnel/HTTPS) → add the link to your
 * assistant (ticks when it has really connected) → start the import and
 * send it the message. The interview itself carries on in the Chief of
 * Staff's chat, which is where onboarding ends: its first card there is
 * the import's "OK to start?".
 *
 * Every tick is this Mac's own check (`get_remote_access_status`, the
 * import's own state); nothing is ticked on a click.
 *
 * @module components/setup/flow/AgentsFlow
 */

import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CheckLine, FlowShell } from './FlowParts';
import { MessageCard } from '../../agents/ImportParts';
import { Primary, Skip, tailscaleMacView, useAdvanceWhenPassed } from '../../phone/PhoneFlow';
import { usePolling } from '../../../hooks/usePolling';
import { useOptionalToast } from '../../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../../lib/errors';
import { BRAND } from '../../../lib/brand';
import {
  AGENT_EVENTS,
  armImportTalk,
  getImportPrompt,
  getImportTalk,
  talkIsLive,
  type ImportGate,
} from '../../../lib/agents';
import {
  connectionStep,
  copyRemoteLink,
  getRemoteAccessStatus,
  republishRemoteLink,
  setRemoteAccessEnabled,
  type RemoteAccessStatus,
} from '../../../lib/remoteAccess';
import type { CheckResult, FlowStep } from '../../../lib/onboardingFlow';

export type AgentsStep = Extract<FlowStep, `agents${string}`>;

/** Remote access's own "I read: this Mac has to stay on" (RemoteAccessModal's choices). */
const REMOTE_CHOICES_KEY = 'shipstudio.remoteAccess.setup';
function markStayOnUnderstood() {
  try {
    const raw = window.localStorage.getItem(REMOTE_CHOICES_KEY);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(REMOTE_CHOICES_KEY, JSON.stringify({ ...prev, understood: true }));
  } catch {
    // Storage blocked: Remote access just asks once more.
  }
}

interface Props {
  step: AgentsStep;
  go: (step: FlowStep) => void;
  /** "Not now" / "Skip for now": on to the phone. */
  onSkip: () => void;
  onBack: () => void;
}

const errText = (e: unknown) => formatCommandError(asCommandError(e));

export function AgentsFlow({ step, go, onSkip, onBack }: Props) {
  const { showToast } = useOptionalToast();
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [gate, setGate] = useState<ImportGate | null>(null);
  const [prompt, setPrompt] = useState('');

  const load = useCallback(async () => {
    const s = await getRemoteAccessStatus().catch(() => null);
    if (s) setStatus(s);
    return s;
  }, []);

  usePolling(
    async () => {
      setNow(Date.now());
      return load();
    },
    { intervalMs: 3000, enabled: step !== 'agentsAsk', name: 'agents-flow' }
  );
  useEffect(() => {
    if (step !== 'agentsAsk') void load();
  }, [step, load]);

  // The import's own state, kept current from its events.
  useEffect(() => {
    if (step !== 'agentsStart') return;
    let live = true;
    void getImportTalk()
      .then((g) => live && setGate(g))
      .catch(() => undefined);
    void getImportPrompt()
      .then((p) => live && setPrompt(p))
      .catch(() => undefined);
    const unlisten = listen<ImportGate | null>(AGENT_EVENTS.importTalk, (e) => {
      if (live) setGate(e.payload);
    });
    return () => {
      live = false;
      void unlisten.then((u) => u()).catch(() => undefined);
    };
  }, [step]);

  const act = async (key: string, fn: () => Promise<RemoteAccessStatus | void>) => {
    setBusy(key);
    try {
      const next = await fn();
      if (next) setStatus(next);
    } catch (err) {
      showToast(errText(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  const recheck = async () => {
    setChecking(true);
    await load();
    setChecking(false);
  };

  const connection = status ? connectionStep(status, now) : null;
  const linkLive = connection?.kind === 'ready';
  const connected = !!status?.everConnected;
  const talk = gate?.talk ?? null;
  const started = talk !== null && (talk.state === 'imported' || talkIsLive(talk));

  useAdvanceWhenPassed(
    step === 'agentsTailscale' && status?.tailscale.state === 'connected',
    () => go('agentsLink'),
    step
  );
  useAdvanceWhenPassed(step === 'agentsLink' && linkLive, () => go('agentsConnect'), step);
  useAdvanceWhenPassed(step === 'agentsConnect' && connected, () => go('agentsStart'), step);

  const skip = <Skip onSkip={onSkip} />;

  if (step === 'agentsAsk') {
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title="Bring your agents from another assistant?"
        lede="If Grok, ChatGPT, Claude or another assistant runs agents for you, they can carry on here, each where it left off. Nothing is created until you say so."
        primary={<Primary onClick={() => go('agentsTailscale')}>Bring my agents</Primary>}
        secondary={<Skip onSkip={onSkip} label="Not now" />}
      />
    );
  }

  if (step === 'agentsTailscale') {
    const view = tailscaleMacView({
      tailscale: status?.tailscale,
      checking,
      onCheck: () => void recheck(),
      onNext: () => go('agentsLink'),
      skip,
    });
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title={view.title}
        lede="A free app that gives this Mac a private address on your own account. Your assistant reaches your agents through it."
        primary={view.primary}
        secondary={view.secondary}
      >
        {view.children}
      </FlowShell>
    );
  }

  if (step === 'agentsLink') {
    const check: CheckResult | null = !connection
      ? { state: 'checking', line: 'Checking remote access…' }
      : connection.kind === 'ready'
        ? { state: 'pass', line: 'The private link is live.' }
        : connection.kind === 'off'
          ? null
          : connection.kind === 'publishing' || connection.kind === 'starting'
            ? {
                state: 'checking',
                line: 'Making the link reachable. This can take a minute or two the first time.',
              }
            : connection.kind === 'approveFunnel'
              ? {
                  state: 'fail',
                  line: 'One switch in Tailscale is off: Funnel.',
                  fix: 'It lets your assistant reach this Mac. Turn it on, then come back.',
                  action: { label: 'Open Tailscale', url: connection.url },
                }
              : connection.kind === 'unreachable'
                ? { state: 'fail', line: 'The link isn’t reachable yet.', fix: connection.detail }
                : connection.kind === 'funnelFailed'
                  ? {
                      state: 'fail',
                      line: 'Tailscale didn’t open the link.',
                      fix: connection.detail,
                    }
                  : connection.kind === 'serverStopped'
                    ? { state: 'fail', line: 'Remote access stopped.', fix: 'Turn it on again.' }
                    : {
                        state: 'fail',
                        line: 'Tailscale on this Mac isn’t ready.',
                        fix: 'Go back one step and finish it.',
                      };
    const off = connection?.kind === 'off' || connection?.kind === 'serverStopped';
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title="Turn on the private link"
        lede="Your assistant reaches your agents through this Mac, so it stays awake while remote access is on. Keep it plugged in while you’re away."
        primary={
          off ? (
            <Primary
              busy={busy === 'enable'}
              onClick={() =>
                void act('enable', async () => {
                  markStayOnUnderstood();
                  return setRemoteAccessEnabled(true);
                })
              }
            >
              Turn on remote access
            </Primary>
          ) : linkLive ? (
            <Primary onClick={() => go('agentsConnect')}>Continue</Primary>
          ) : undefined
        }
        secondary={skip}
      >
        {check && (
          <CheckLine
            result={check}
            checking={checking || busy === 'republish'}
            onCheckAgain={
              check.state === 'fail' ? () => void act('republish', republishRemoteLink) : undefined
            }
          />
        )}
      </FlowShell>
    );
  }

  if (step === 'agentsConnect') {
    const check: CheckResult = connected
      ? { state: 'pass', line: 'Your assistant connected.' }
      : { state: 'checking', line: 'Waiting for your assistant to connect…' };
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title="Add the link to your assistant"
        lede={`In your assistant, add a custom connector (it may say MCP), name it ${BRAND.name}, and paste the link. Then ask it: “What are my agents doing?”`}
        primary={
          connected ? (
            <Primary onClick={() => go('agentsStart')}>Continue</Primary>
          ) : (
            <Primary
              busy={busy === 'copy'}
              onClick={() =>
                void act('copy', async () => {
                  await copyRemoteLink();
                  setCopied(true);
                })
              }
            >
              {copied ? 'Copied. Copy again' : 'Copy the link'}
            </Primary>
          )
        }
        secondary={skip}
      >
        {(copied || connected) && <CheckLine result={check} />}
        <p className="flow-note">The link is a secret: it only goes to your clipboard.</p>
      </FlowShell>
    );
  }

  // agentsStart
  const armed = !!gate?.armed || started;
  const check: CheckResult | null = started
    ? {
        state: 'pass',
        line: `${talk.source} is asking to start. You’ll say OK in your Chief of Staff’s chat, next.`,
      }
    : armed
      ? { state: 'checking', line: 'Waiting for your assistant to start the import…' }
      : null;
  return (
    <FlowShell
      step={step}
      onBack={onBack}
      title={armed ? 'Send your assistant this message' : 'Start the import'}
      lede={
        armed
          ? 'It tells your Chief of Staff what each agent does. You see the plan, and choose what to import, before anything is created.'
          : 'Start lets one import begin. Then you send your assistant a message, and you see the plan before anything is created.'
      }
      primary={
        started ? (
          <Primary onClick={onSkip}>Continue</Primary>
        ) : !armed ? (
          <Primary
            busy={busy === 'arm'}
            onClick={() =>
              void act('arm', async () => {
                setGate(await armImportTalk());
              })
            }
          >
            Start the import
          </Primary>
        ) : undefined
      }
      secondary={started ? undefined : skip}
    >
      {armed && !started && prompt && <MessageCard message={prompt} autoFocus />}
      {check && <CheckLine result={check} />}
    </FlowShell>
  );
}
