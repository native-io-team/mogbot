/**
 * The step an agent is on right now, under its working line: in plain words
 * with a live timer ("Running the Cypress tests · 5:32"), the quiet hint a
 * known slow tool gets after a minute, "Show output" (what the command has
 * printed so far, where the engine streams it), and after ten minutes "Stop
 * this step". Calm by default; whether it's alive is always one click away
 * (the line itself: "Last activity 4s ago · using the CPU"). Once the Mac
 * says there's been no progress for too long, the line says so instead and
 * offers "Check on it" and "Stop".
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

/** What the working line shows, and what hangs under it. */
export function useLiveStep({ agent, work, activity, leaving }: LiveStepProps): {
  /** In place of the activity text: the step and its timer, or "No progress". */
  line: ReactNode | null;
  /** Under the working line: hint, output, Stop this step, what a check found. */
  details: ReactNode | null;
} {
  const call = work?.current;
  const quiet = work?.quietSince != null;
  const now = useNow(Boolean((call || quiet) && !leaving));
  const { showToast } = useOptionalToast();
  const [lifeOpen, setLifeOpen] = useState(false);
  const [said, setSaid] = useState<{ at: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!agent || !work || leaving) return { line: null, details: null };

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

  const life = lifeLine(work, now);
  const quietText = quietLine(work, now);
  // The line is the call only when it's saying the call's words.
  const isCall = Boolean(call && (activity == null || activity === call.label));
  let line: ReactNode = null;
  if (quietText) {
    line = (
      <span className="agent-live__quiet">
        <span className="agent-working__activity" data-quiet>
          {quietText}
          {call ? ` · ${call.label}` : ''}
        </span>
        <TextButton
          tabIndex={0}
          variant="strong"
          className="agent-live__action"
          disabled={busy}
          onClick={() => void run(() => checkOnAgent(agent.id))}
        >
          Check on it
        </TextButton>
        <TextButton
          tabIndex={0}
          variant="strong"
          className="agent-live__action"
          disabled={busy}
          onClick={() => void run(() => stopAgent(agent.id))}
        >
          Stop
        </TextButton>
      </span>
    );
  } else if (isCall && call) {
    line = (
      <TextButton
        tabIndex={0}
        className="agent-live__step"
        aria-expanded={lifeOpen}
        title={life ?? undefined}
        onClick={() => setLifeOpen((o) => !o)}
      >
        <span className="agent-working__activity">{call.label}</span>
        <time className="agent-live__timer">· {formatElapsed(now - call.startedAt)}</time>
      </TextButton>
    );
  }

  const hint = isCall ? slowHint(call, now) : null;
  const command = isCall && call?.kind === 'command';
  const stopStep = isCall && offersStopStep(call, now);
  const saidHere = said && said.at === work.startedAt ? said.text : null;
  const showLife = (lifeOpen || quiet) && life;
  const details =
    hint || command || stopStep || saidHere || showLife ? (
      <div className="agent-live">
        {showLife && <p className="agent-live__life">{life}</p>}
        {hint && <p className="agent-live__hint">{hint}</p>}
        {(command || stopStep) && (
          <div className="agent-live__row">
            {command && call && <OutputPeek lines={call.output ?? []} note={outputNote(call)} />}
            {stopStep && (
              <TextButton
                tabIndex={0}
                variant="strong"
                className="agent-live__action"
                disabled={busy}
                onClick={() => void run(() => stopAgentStep(agent.id))}
              >
                Stop this step
              </TextButton>
            )}
          </div>
        )}
        {saidHere && (
          <p className="agent-live__said" role="status">
            {saidHere}
          </p>
        )}
      </div>
    ) : null;
  return { line, details };
}

/** A finished step's last lines, when it kept any. */
export function StepOutput({ step }: { step: WorkStep }) {
  if (!step.output?.length) return null;
  return <OutputPeek lines={step.output} />;
}
