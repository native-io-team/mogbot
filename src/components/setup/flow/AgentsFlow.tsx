/**
 * Bringing your agents from another assistant, one screen at a time, each
 * one thing to look at and one decision:
 *
 * 1. "Bring your agents from another assistant?" answered by picking it
 *    (Claude, ChatGPT, Grok, another) or "I'm starting fresh".
 * 2. Tailscale on this Mac (skipped when it's already on).
 * 3. Turn on remote access: one click. When Tailscale wants its one-time
 *    approval, that click opens Tailscale's page, the app keeps the request
 *    waiting, and the screen goes on by itself once it's approved.
 * 4. Add the link to *that* assistant: Copy the link, its own few clicks,
 *    a button to its connector settings where the vendor documents one;
 *    Done the moment it really connects (`everConnected`).
 * 5. Send it one message. The import is allowed on arrival (picking the
 *    assistant was the yes; the Chief still asks on a card before the
 *    interview starts), and Done when the assistant asks to start.
 *
 * Every tick is this Mac's own check (`get_remote_access_status`, the
 * import's own state); nothing is ticked on a click. Screens already true
 * are passed over (`firstAgentsStep`). The interview itself carries on in
 * the Chief of Staff's chat, which is where onboarding ends.
 *
 * @module components/setup/flow/AgentsFlow
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CheckLine, FlowShell } from './FlowParts';
import { MessageCard } from '../../agents/ImportParts';
import { Button } from '../../primitives/Button';
import { Primary, Skip, tailscaleMacView, useAdvanceWhenPassed } from '../../phone/PhoneFlow';
import { ChevronRightIcon, ExternalLinkIcon } from '@/components/icons';
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
  assistantGuides,
  connectionStep,
  copyRemoteLink,
  getRemoteAccessStatus,
  remoteProblem,
  republishRemoteLink,
  setRemoteAccessEnabled,
  type AssistantId,
  type RemoteAccessStatus,
} from '../../../lib/remoteAccess';
import {
  assistantConnected,
  firstAgentsStep,
  linkCheckFor,
  linkIsOn,
  readAssistantChoice,
  saveAssistantChoice,
  type CheckResult,
  type FlowStep,
} from '../../../lib/onboardingFlow';
import { COMPUTER, THIS_COMPUTER } from '../../../lib/computer';

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

/** The pick list: each assistant in one line, by what people call it. */
const CHOICES: { id: AssistantId; name: string; hint: string }[] = [
  { id: 'claude', name: 'Claude', hint: 'On claude.ai, any plan' },
  { id: 'chatgpt', name: 'ChatGPT', hint: 'On chatgpt.com, from Plugins' },
  { id: 'grok', name: 'Grok', hint: 'On grok.com' },
  { id: 'other', name: 'Another assistant', hint: 'Anything that adds a custom connector (MCP)' },
];

interface Props {
  step: AgentsStep;
  go: (step: FlowStep) => void;
  /** "I'm starting fresh" / "Skip for now": on to the phone. */
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
  const [choice, setChoice] = useState<AssistantId | null>(() => readAssistantChoice());
  /** Tailscale's approval page was opened by the click that asked for it. */
  const [openedApproval, setOpenedApproval] = useState<string | null>(null);

  const guides = assistantGuides(BRAND.name);
  const guide = guides.find((g) => g.id === (choice ?? 'other')) ?? guides[guides.length - 1];
  /** "Claude", or "your assistant" when it's another one. */
  const who = guide.id === 'other' ? 'your assistant' : guide.name;
  const Who = guide.id === 'other' ? 'Your assistant' : guide.name;

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
    { intervalMs: 1500, enabled: step !== 'agentsAsk', name: 'agents-flow' }
  );
  useEffect(() => {
    void load();
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
      return next ?? null;
    } catch (err) {
      showToast(errText(err), 'error');
      return null;
    } finally {
      setBusy(null);
    }
  };
  const recheck = async () => {
    setChecking(true);
    await load();
    setChecking(false);
  };

  const connected = assistantConnected(status, choice);
  const linkOn = status ? linkIsOn(status, now) : false;
  const ready = status ? connectionStep(status, now).kind === 'ready' : false;
  const talk = gate?.talk ?? null;
  const started = talk !== null && (talk.state === 'imported' || talkIsLive(talk));

  const ahead = (s: RemoteAccessStatus | null) => go(firstAgentsStep(s, Date.now(), choice));

  useAdvanceWhenPassed(
    step === 'agentsTailscale' && status?.tailscale.state === 'connected',
    () => ahead(status),
    step
  );
  useAdvanceWhenPassed(step === 'agentsLink' && linkOn, () => go('agentsConnect'), step);
  useAdvanceWhenPassed(step === 'agentsConnect' && connected, () => go('agentsStart'), step);

  // Arriving at the message: allow the import (once per arrival). Picking
  // the assistant was the yes; the Chief still asks on a card first.
  const armedFor = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 'agentsStart') {
      armedFor.current = null;
      return;
    }
    if (!gate || gate.armed || started || armedFor.current === step) return;
    armedFor.current = step;
    void armImportTalk()
      .then(setGate)
      .catch((err) => showToast(errText(err), 'error'));
  }, [step, gate, started, showToast]);

  const skip = <Skip onSkip={onSkip} />;

  if (step === 'agentsAsk') {
    const pick = async (id: AssistantId) => {
      saveAssistantChoice(id);
      setChoice(id);
      setBusy(id);
      const s = await load();
      setBusy(null);
      go(firstAgentsStep(s, Date.now(), id));
    };
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title="Bring your agents from another assistant?"
        lede="Your agents here already run on the engine you just set up. This only brings over agents you made in another assistant, each where it left off. Nothing is created until you say so."
      >
        <div className="flow-choices">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flow-choice"
              data-flow-choice={c.id}
              disabled={busy !== null}
              onClick={() => void pick(c.id)}
            >
              <span className="flow-choice__text">
                <span className="flow-choice__name">{c.name}</span>
                <span className="flow-choice__hint">{c.hint}</span>
              </span>
              <span className="flow-choice__go" aria-hidden>
                <ChevronRightIcon size={14} />
              </span>
            </button>
          ))}
          <button
            type="button"
            className="flow-choice flow-choice--fresh"
            data-flow-skip
            data-flow-fresh
            onClick={onSkip}
          >
            <span className="flow-choice__text">
              <span className="flow-choice__name">I’m starting fresh</span>
              <span className="flow-choice__hint">
                Skip this. You can bring agents over any time later.
              </span>
            </span>
            <span className="flow-choice__go" aria-hidden>
              <ChevronRightIcon size={14} />
            </span>
          </button>
        </div>
      </FlowShell>
    );
  }

  if (step === 'agentsTailscale') {
    const view = tailscaleMacView({
      tailscale: status?.tailscale,
      checking,
      onCheck: () => void recheck(),
      onNext: () => ahead(status),
      skip,
    });
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title={view.title}
        lede={`A free app that gives ${THIS_COMPUTER} a private address on your own account. ${Who} reaches your agents through it.`}
        primary={view.primary}
        secondary={view.secondary}
      >
        {view.children}
      </FlowShell>
    );
  }

  if (step === 'agentsLink') {
    const link = status
      ? linkCheckFor(remoteProblem(status, now))
      : ({
          kind: 'check',
          check: { state: 'checking', line: 'Checking remote access…' },
          fix: null,
        } as const);
    const turnOn = () =>
      void act('enable', async () => {
        markStayOnUnderstood();
        const next = await setRemoteAccessEnabled(true);
        // The approval page is the next thing to do: open it on this same
        // click, rather than asking for a second one.
        const after = linkCheckFor(remoteProblem(next, Date.now()));
        if (after.kind === 'approve' && after.url) {
          setOpenedApproval(after.url);
          void openUrl(after.url);
        }
        return next;
      });
    if (link.kind === 'approve') {
      const opened = openedApproval === link.url;
      return (
        <FlowShell
          step={step}
          onBack={onBack}
          title="Approve it in Tailscale"
          lede={
            opened
              ? `Tailscale opened its page in your browser. One OK there, once, and your assistant can reach ${THIS_COMPUTER}.`
              : `One OK on Tailscale’s own page, once, and your assistant can reach ${THIS_COMPUTER}.`
          }
          primary={
            <Primary
              external
              onClick={() => {
                setOpenedApproval(link.url);
                void openUrl(link.url);
              }}
            >
              {opened ? 'Open the page again' : 'Open the Tailscale page'}
            </Primary>
          }
          secondary={skip}
        >
          <CheckLine result={link.check} />
        </FlowShell>
      );
    }
    const fix = link.kind === 'check' ? link.fix : null;
    const runFix = () => {
      if (!fix) return;
      if (fix.kind === 'turnOn') void act('again', () => setRemoteAccessEnabled(true));
      else if (fix.kind === 'republish') void act('again', republishRemoteLink);
      else void recheck();
    };
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title="Turn on remote access"
        lede={`It lets your assistant reach your agents on ${THIS_COMPUTER}. The ${COMPUTER} stays awake while it’s on, so keep it plugged in while you’re away.`}
        primary={
          link.kind === 'off' ? (
            <Primary busy={busy === 'enable'} onClick={turnOn}>
              Turn it on
            </Primary>
          ) : linkOn ? (
            <Primary onClick={() => go('agentsConnect')}>Continue</Primary>
          ) : undefined
        }
        secondary={skip}
      >
        {link.kind === 'check' && (
          <CheckLine
            result={link.check}
            checking={checking || busy === 'again'}
            onCheckAgain={link.check.state === 'fail' && fix ? runFix : undefined}
            againLabel={fix?.label}
          />
        )}
      </FlowShell>
    );
  }

  if (step === 'agentsConnect') {
    const check: CheckResult = connected
      ? { state: 'pass', line: `${Who} connected.` }
      : !ready
        ? {
            state: 'checking',
            line: 'Tailscale is still making the link public. Add it now: it starts working by itself.',
          }
        : { state: 'waiting', line: `${Who} hasn’t connected yet.` };
    return (
      <FlowShell
        step={step}
        onBack={onBack}
        title={guide.id === 'other' ? 'Add the link to your assistant' : `Add the link to ${who}`}
        lede={`A few steps in ${who}. This screen ticks the moment it connects.`}
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
              {copied ? 'Link copied' : 'Copy the link'}
            </Primary>
          )
        }
        secondary={skip}
      >
        <ol className="flow-steps" data-assistant={guide.id}>
          <li>Copy the link with the button below.</li>
          {guide.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {guide.url && (
          <div className="flow-links">
            <Button
              variant="secondary"
              rightIcon={<ExternalLinkIcon size={12} />}
              onClick={() => void openUrl(guide.url as string)}
              data-assistant-settings
            >
              {guide.urlLabel ?? `Open ${guide.name}`}
            </Button>
          </div>
        )}
        <CheckLine result={check} />
        <p className="flow-note">
          {guide.needs ? `${guide.needs} ` : ''}The link is a secret: it only goes to your
          clipboard.
        </p>
      </FlowShell>
    );
  }

  // agentsStart
  const check: CheckResult = started
    ? { state: 'pass', line: `${talk.source} is asking to start the import.` }
    : { state: 'waiting', on: who, line: 'It hasn’t started the import yet.' };
  return (
    <FlowShell
      step={step}
      onBack={onBack}
      title={started ? `${talk.source} is ready to bring your agents` : `Send ${who} this message`}
      lede={
        started
          ? 'Next, your Chief of Staff asks you to OK it in its chat. You choose which agents come over before anything is created.'
          : `Paste it into a new chat with ${who}. It tells your Chief of Staff what each agent does, and you choose what comes over before anything is created.`
      }
      primary={started ? <Primary onClick={onSkip}>Continue</Primary> : undefined}
      secondary={started ? undefined : skip}
    >
      {!started && prompt && <MessageCard message={prompt} autoFocus />}
      {(started || gate?.armed) && <CheckLine result={check} />}
    </FlowShell>
  );
}
