/**
 * First run's "bring your agents over", as a conversation with the Chief
 * (`agents::guide`).
 *
 * - **The ask** (`ImportGuideAsk`): under the greeting, "Already have agents
 *   somewhere?" with the assistants as replies. Picking one is the yes; it
 *   shows as the user's own message.
 * - **The driver** (`useImportGuide`): while the guide runs, it reads
 *   Remote Access and the import talk, works out the step (`guideStep`), and
 *   asks the Mac to say it. The Mac says each step once, as a Chief message.
 * - **The step** (`GuideStepAction`, drawn for a `guide` block): that
 *   message's one action. The current step's button; a step behind it reads
 *   Done. Nothing here ever shows the link itself (only the Mac copies it).
 *
 * @module components/agents/ImportGuide
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { ExternalLinkIcon } from '@/components/icons';
import { CheckLine } from '../setup/flow/FlowParts';
import { MessageCard } from './ImportParts';
import { useImportGate } from './ImportConnectorPanel';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { BRAND } from '../../lib/brand';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import {
  armImportTalk,
  getImportGuide,
  getImportPrompt,
  postImportGuideStep,
  setImportChoice,
  startImportGuide,
  stopImportGuide,
  type ImportGuide,
} from '../../lib/agents';
import {
  TAILSCALE_DOWNLOAD_URL,
  assistantGuides,
  copyRemoteLink,
  getRemoteAccessStatus,
  remoteProblem,
  setRemoteAccessEnabled,
  type RemoteAccessStatus,
} from '../../lib/remoteAccess';
import { guideStep, linkCheckFor } from '../../lib/onboardingFlow';
import {
  GUIDE_STEPS,
  type GuideBlock,
  type GuideStepId,
} from '../../../packages/companion-protocol/src/blocks';
import {
  GUIDE_ASK_FRESH,
  GUIDE_ASK_OPTIONS,
  GUIDE_ASK_TEXT,
} from '../../../packages/companion-protocol/src/cardWords';

/* ------------------------------------------------------------ the state */

interface GuideLive {
  guide: ImportGuide | null;
  step: GuideStepId | null;
  status: RemoteAccessStatus | null;
}

const GuideContext = createContext<GuideLive>({ guide: null, step: null, status: null });

const POLL_MS = 2500;

/**
 * Runs the guide for the Chief's chat: polls only while one runs, and asks
 * the Mac to say each new step. Wrap the chat in `ImportGuideProvider` with
 * what this returns.
 */
export function useImportGuide(isChief: boolean): GuideLive {
  const choice = useAgentsSelector((s) => s.importChoice);
  const running = isChief && choice === 'bringing';
  const { talk } = useImportGate();
  const [guide, setGuide] = useState<ImportGuide | null>(null);
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);

  useEffect(() => {
    if (!running) {
      setGuide(null);
      return;
    }
    let live = true;
    void getImportGuide()
      .then((g) => live && setGuide(g))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [running]);

  usePolling(
    async () => {
      setStatus(await getRemoteAccessStatus());
    },
    { intervalMs: POLL_MS, enabled: running }
  );

  const step = running && guide ? guideStep(status, talk, guide.assistant, Date.now()) : null;

  // Say each step the first time it's reached. The Mac keeps the "once".
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!step || asked.current === step) return;
    asked.current = step;
    void postImportGuideStep(step)
      .then((said) => {
        if (said) setGuide((g) => (g ? { ...g, posted: [...g.posted, step] } : g));
      })
      .catch(() => {
        asked.current = null;
      });
  }, [step]);

  return { guide: running ? guide : null, step, status };
}

export const ImportGuideProvider = GuideContext.Provider;

/* -------------------------------------------------------------- the ask */

/**
 * Under the greeting while the question is open: which assistant their
 * agents live in, or start fresh. Hidden once answered or while an import
 * is already going.
 */
export function ImportGuideAsk() {
  const choice = useAgentsSelector((s) => s.importChoice);
  const { talk } = useImportGate();
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState(false);
  if (choice !== 'undecided' || talk) return null;

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(() => refreshAgents())
      .catch((e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="agent-guide-ask" data-testid="agent-import-choice">
      <p className="agent-guide-ask__text">{GUIDE_ASK_TEXT}</p>
      <div className="agent-guide-ask__options" role="group" aria-label={GUIDE_ASK_TEXT}>
        {GUIDE_ASK_OPTIONS.map((o) => (
          <Button
            key={o.id}
            variant="secondary"
            size="compact"
            disabled={busy}
            onClick={() => run(() => startImportGuide(o.id))}
            data-guide-pick={o.id}
          >
            {o.label}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="compact"
          disabled={busy}
          onClick={() => run(() => setImportChoice('declined'))}
        >
          {GUIDE_ASK_FRESH}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the step */

const order = (s: GuideStepId) => GUIDE_STEPS.indexOf(s);

/** The `guide` block under a Chief message: that step's one action. */
export function GuideStepAction({ block }: { block: GuideBlock }) {
  const { guide, step: current, status } = useContext(GuideContext);
  // The guide ended (imported, or start fresh): the words stay, the actions go.
  if (!guide || !current) return null;
  const past =
    order(block.step) < order(current) ||
    // "approve" is skipped when Tailscale never asks: link is done once connect is reached.
    (block.step === 'approve' && order(current) > order('approve'));
  if (past) {
    return <CheckLine result={{ state: 'pass', line: DONE_LINES[block.step] }} />;
  }
  if (block.step !== current) return null;
  return <CurrentStep block={block} status={status} />;
}

const DONE_LINES: Record<GuideStepId, string> = {
  tailscale: 'Tailscale is on.',
  link: 'Your link is on.',
  approve: 'Tailscale approved it.',
  connect: 'Connected.',
  send: 'It started.',
  talking: 'Done.',
};

function CurrentStep({ block, status }: { block: GuideBlock; status: RemoteAccessStatus | null }) {
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .catch((e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error'))
      .finally(() => setBusy(false));
  };
  const name = assistantLabel(block.assistant);
  const guideFor = assistantGuides(BRAND.name).find((g) => g.id === block.assistant);

  switch (block.step) {
    case 'tailscale':
      return (
        <StepRow waiting="Waiting for Tailscale…">
          <Button variant="strong" size="compact" onClick={() => void openUrl(TAILSCALE_DOWNLOAD_URL)}>
            Get Tailscale <ExternalLinkIcon size={12} />
          </Button>
        </StepRow>
      );
    case 'link': {
      const problem = status ? linkCheckFor(remoteProblem(status, Date.now())) : null;
      const line = problem && problem.kind === 'check' && problem.check.state === 'fail' ? problem.check : null;
      return (
        <StepRow failure={line?.line}>
          <Button
            variant="strong"
            size="compact"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const next = await setRemoteAccessEnabled(true);
                // Tailscale's approval is the next thing: open it on this click.
                if (next.funnelApprovalUrl) void openUrl(next.funnelApprovalUrl);
              })
            }
          >
            Turn on my link
          </Button>
        </StepRow>
      );
    }
    case 'approve':
      return (
        <StepRow waiting="Waiting for your OK in Tailscale…">
          <Button
            variant="strong"
            size="compact"
            disabled={!status?.funnelApprovalUrl}
            onClick={() => status?.funnelApprovalUrl && void openUrl(status.funnelApprovalUrl)}
          >
            Open Tailscale’s page <ExternalLinkIcon size={12} />
          </Button>
        </StepRow>
      );
    case 'connect':
      return (
        <div className="agent-guide-step">
          {guideFor && (
            <ol className="agent-guide-step__list">
              {guideFor.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          <StepRow waiting={`Waiting for ${name} to connect…`}>
            <Button
              variant="strong"
              size="compact"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await copyRemoteLink();
                  showToast(`Link copied. Paste it into ${name}.`, 'success');
                })
              }
            >
              Copy my link
            </Button>
            {guideFor?.url && (
              <Button variant="secondary" size="compact" onClick={() => void openUrl(guideFor.url as string)}>
                Open {name} <ExternalLinkIcon size={12} />
              </Button>
            )}
          </StepRow>
        </div>
      );
    case 'send':
      return <SendStep name={name} />;
    case 'talking':
      return null;
  }
}

/** The message to send, armed so the assistant's hello is expected. */
function SendStep({ name }: { name: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const { showToast } = useOptionalToast();
  useEffect(() => {
    let live = true;
    void getImportPrompt()
      .then((m) => live && setMessage(m))
      .catch(() => undefined);
    // The pick was the yes: this import is expected.
    void armImportTalk().catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!message) return null;
  return (
    <div className="agent-guide-step">
      <MessageCard message={message} onCopied={() => showToast(`Copied. Send it to ${name}.`, 'success')} />
      <CheckLine result={{ state: 'waiting', line: `Waiting for ${name} to say hello…` }} />
    </div>
  );
}

function StepRow({
  children,
  waiting,
  failure,
}: {
  children: React.ReactNode;
  waiting?: string;
  failure?: string;
}) {
  return (
    <div className="agent-guide-step">
      <div className="agent-guide-step__actions">{children}</div>
      {failure ? (
        <CheckLine result={{ state: 'fail', line: failure }} />
      ) : (
        waiting && <CheckLine result={{ state: 'waiting', line: waiting }} />
      )}
    </div>
  );
}

function assistantLabel(id: GuideBlock['assistant']): string {
  return GUIDE_ASK_OPTIONS.find((o) => o.id === id && id !== 'other')?.label ?? 'your assistant';
}

/** "Start fresh" partway through. */
export function stopGuide() {
  return stopImportGuide().then(() => refreshAgents());
}
