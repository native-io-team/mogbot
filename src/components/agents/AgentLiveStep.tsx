/**
 * The step an agent is on right now. The working line says it in plain words
 * ("Running the Cypress tests"); under the line, on the text's edge, sits the
 * quiet hint a known slow tool gets after a minute. After ten minutes "Stop
 * this step" sits at the line's right end. Opening the line lists the steps,
 * ending on this one with its own timer, when it last showed life ("Last
 * activity 4s ago · busy") and "Show output" (what the command has
 * printed so far, where the engine streams it): output lives inside its step.
 * Once the Mac says there's been no progress for too long, the line says so
 * instead, stops shimmering, and offers "Check on it" and "Stop". While it
 * has a page open in its own browser (the agents' Chrome), a small live
 * picture of that page sits under the line (`AgentBrowserLive`).
 *
 * The words come from the Mac (`agents::work`, `agents::describe`); the
 * timings and hints from the protocol's shared helpers, so the desk and the
 * phone say the same thing.
 *
 * @module components/agents/AgentLiveStep
 */

import { useId, useState, type ReactNode } from 'react';
import { ChevronRightIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { useNow } from '../../hooks/useNow';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  checkOnAgent,
  stopAgent,
  stopAgentStep,
  type Agent,
  type TurnWork,
  type WorkStep,
} from '../../lib/agents';
import { BrowserLiveCard } from './AgentBrowserLive';
import type { CurrentStep } from './AgentWork';
import {
  formatElapsed,
  lifeLine,
  offersStopStep,
  outputNote,
  quietLine,
  slowHint,
} from '../../../packages/companion-protocol/src/work';

interface LiveStepProps {
  agent: Agent | undefined;
  work: TurnWork | undefined;
  /** What the working line says now. */
  activity: string | null | undefined;
  leaving?: boolean;
}

/** The output lines, or why there are none. */
function OutputLines({ lines, note, id }: { lines: string[]; note?: string | null; id: string }) {
  if (!lines.length) {
    return (
      <p id={id} className="agent-live__note">
        {note ?? 'Nothing printed'}
      </p>
    );
  }
  return (
    <pre id={id} className="agent-live__output">
      {lines.join('\n')}
    </pre>
  );
}

/** "Show output" and the lines under it; shared by the live step and a finished one. */
export function OutputPeek({
  lines,
  note,
  label = 'Show output',
}: {
  lines: string[];
  note?: string | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="agent-live__peek" data-open={open || undefined}>
      <TextButton
        tabIndex={0}
        className="agent-work__toggle agent-live__toggle"
        aria-expanded={open}
        aria-controls={id}
        data-open={open || undefined}
        leftIcon={<ChevronRightIcon size={12} />}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </TextButton>
      {open && <OutputLines lines={lines} note={note} id={id} />}
    </div>
  );
}

/** What the working line says, the actions on it, and what hangs under it. */
export interface LiveStep {
  /** In place of the activity: the call's words, or "No progress for 5 min · …". */
  text: string | null;
  /** No progress for a while: the line stops shimmering. */
  quiet: boolean;
  /** At the line's right end, when they apply: Check on it and Stop, or Stop this step. */
  actions: ReactNode | null;
  /** Under the line, on the text's edge: the hint, what a check found. */
  under: ReactNode | null;
  /** Under those: its page in its own browser, live. */
  browser: ReactNode | null;
  /** Last in the opened timeline: the call, its timer, its output. */
  current: CurrentStep | null;
  /** Ticks every second while there's a turn to time. */
  now: number;
}

export function useLiveStep({ agent, work, activity, leaving }: LiveStepProps): LiveStep {
  const call = work?.current;
  const now = useNow(Boolean(work && !leaving));
  const { showToast } = useOptionalToast();
  const [said, setSaid] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!agent || !work || leaving) {
    return {
      text: null,
      quiet: false,
      actions: null,
      under: null,
      browser: null,
      current: null,
      now,
    };
  }

  const run = async (what: () => Promise<string | boolean>) => {
    setBusy(true);
    try {
      const text = await what();
      if (typeof text === 'string') setSaid({ at: work.startedAt, text });
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
    } finally {
      setBusy(false);
    }
  };
  const action = (label: string, what: () => Promise<string | boolean>) => (
    <TextButton
      key={label}
      tabIndex={0}
      variant="strong"
      className="agent-live__action"
      disabled={busy}
      onClick={() => void run(what)}
    >
      {label}
    </TextButton>
  );

  const life = lifeLine(work, now);
  const quietText = quietLine(work, now);
  // The line is the call only when it's saying the call's words.
  const isCall = Boolean(call && (activity == null || activity === call.label));
  const text = quietText
    ? `${quietText}${call ? ` · ${call.label}` : ''}`
    : isCall && call
      ? call.label
      : null;

  const hint = isCall && !quietText ? slowHint(call, now) : null;
  const command = isCall && call?.kind === 'command';
  const stopStep = isCall && !quietText && offersStopStep(call, now);
  const saidHere = said && said.at === work.startedAt ? said.text : null;
  const actions = quietText
    ? [
        action('Check on it', () => checkOnAgent(agent.id)),
        action('Stop', () => stopAgent(agent.id)),
      ]
    : stopStep
      ? action('Stop this step', () => stopAgentStep(agent.id))
      : null;
  // Stalled, whether it's alive is the question: it's said under the line.
  const quietLife = quietText ? life : null;
  const under =
    hint || saidHere || quietLife ? (
      <>
        {quietLife && <p className="agent-live__life">{quietLife}</p>}
        {hint && <p className="agent-live__hint">{hint}</p>}
        {saidHere && (
          <p className="agent-live__said" role="status">
            {saidHere}
          </p>
        )}
      </>
    ) : null;
  const stepLife = quietText ? null : life;
  const details =
    stepLife || command ? (
      <>
        {stepLife && <p className="agent-live__life">{stepLife}</p>}
        {command && call && <OutputPeek lines={call.output ?? []} note={outputNote(call)} />}
      </>
    ) : null;
  const current =
    isCall && call ? { call, elapsed: formatElapsed(now - call.startedAt), details } : null;
  const browser = work.ownBrowser ? <BrowserLiveCard agent={agent} work={work} /> : null;
  return { text, quiet: Boolean(quietText), actions, under, browser, current, now };
}

/** A finished step's last lines, when it kept any. */
export function StepOutput({ step }: { step: WorkStep }) {
  if (!step.output?.length) return null;
  return <OutputPeek lines={step.output} />;
}
