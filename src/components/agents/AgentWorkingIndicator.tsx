/**
 * The working line under the last message while an agent works. One line,
 * no bubble: the agent on a key, being typed on (`AgentKey`), then what it's doing in
 * calm text with a soft shimmer while it's live, and muted at the end how
 * many steps so far and how long the turn has run:
 *
 *   [key] Running the Cypress tests · 5 steps · 6:02          Stop this step
 *         Test runs usually take a few minutes
 *         [its browser, live]
 *
 * The line itself is the toggle: pressing it opens the steps under it, in the
 * column the finished timeline uses, ending on the step it's on now with its
 * timer and output. Anything that hangs under the line (a hint, what a check
 * found, the live browser card) sits on the text's left edge; actions are
 * quiet text buttons at the line's right end. When the turn ends the line
 * gives way to "› Worked 6 min · 5 steps" in the same place, its chevron in
 * the column the key cap held.
 *
 * The words are steadied (`useSteadyLine`), so they don't flicker step to
 * step; the time sits in tabular figures at the end, so ticking moves nothing.
 *
 * @module components/agents/AgentWorkingIndicator
 */

import { useState, type ReactNode } from 'react';
import { TextButton } from '../primitives/TextButton';
import { TypingDots } from '../primitives/TypingDots';
import { useSteadyLine } from '../../hooks/useSteadyLine';
import type { Agent, TurnWork } from '../../lib/agents';
import { formatElapsed } from '../../../packages/companion-protocol/src/work';
import { AgentKey } from './AgentKey';
import { useLiveStep } from './AgentLiveStep';
import { WorkMenu } from './AgentTakeover';
import { useLiveWork } from './AgentWork';

interface WorkingIndicatorProps {
  activity: string | null;
  /** The turn's steps so far (`status.work`), and whose they are. */
  work?: TurnWork;
  agent?: Agent;
  /** It appeared after the chat opened: open its height rather than pop in. */
  entering?: boolean;
  /** The turn ended: collapse, then `onExited` unmounts it. */
  leaving?: boolean;
  onExited?: () => void;
  /** Where the turn answers, when it isn't this chat (a room). */
  place?: ReactNode;
}

const plural = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

export function WorkingIndicator({
  activity,
  work,
  agent,
  entering,
  leaving,
  onExited,
  place,
}: WorkingIndicatorProps) {
  // Each step holds a moment and a blink of "Thinking" between two never
  // shows (the sidebar's rule), so the line doesn't flicker step to step.
  const steady = useSteadyLine(activity ?? '') || null;
  // Keep the last thing it said while it collapses, rather than blanking it.
  const [shown, setShown] = useState(steady);
  if (!leaving && steady !== shown) setShown(steady);
  // Only a change of activity crossfades; the first one is just there.
  const [first] = useState(shown);
  const step = useLiveStep({ agent, work, activity, leaving });
  const live = useLiveWork({ work, agent, activity, leaving, current: step.current });
  const [frozen, setFrozen] = useState<string | null>(null);

  const words = step.text ?? shown;
  const steps = work && work.stepCount > 0 ? plural(work.stepCount) : null;
  const ticking = work && step.now - work.startedAt >= 1_000;
  const elapsed = ticking ? formatElapsed(step.now - work.startedAt) : null;
  const meta = [steps, elapsed].filter(Boolean).join(' · ');
  // While it collapses the time holds where it was.
  if (!leaving && frozen !== meta) setFrozen(meta);
  const tail = leaving ? frozen : meta;

  const text = (
    <span className="agent-working__text">
      {words && (
        <span
          key={words}
          className="agent-working__activity"
          data-live={!step.quiet && !leaving ? true : undefined}
          data-changed={words !== first || undefined}
        >
          {words}
        </span>
      )}
      {/* The time ticks every second: read when asked, never announced. */}
      {tail && (
        <span className="agent-working__meta" aria-live="off">
          {words ? ` · ${tail}` : tail}
        </span>
      )}
    </span>
  );
  const under = step.under || step.browser;
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--working"
      data-work={work ? true : undefined}
      data-open={live.open || undefined}
      data-entering={entering || undefined}
      data-leaving={leaving || undefined}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onExited?.();
      }}
      aria-live="polite"
    >
      <div className="agent-working__line" data-quiet={step.quiet || undefined}>
        <span className="agent-working__lead" aria-hidden>
          {agent ? (
            <AgentKey
              id={agent.id}
              name={agent.name}
              color={agent.color}
              pressing={!step.quiet && !leaving}
            />
          ) : (
            <TypingDots />
          )}
        </span>
        {place && <span className="agent-working__place">{place}</span>}
        {live.toggle ? (
          <TextButton
            tabIndex={0}
            className="agent-working__toggle"
            aria-expanded={live.open}
            aria-controls={live.controls}
            title={live.open ? 'Hide the steps' : 'Show the steps'}
            onClick={live.toggle}
          >
            {text}
          </TextButton>
        ) : (
          text
        )}
        {(step.actions || (!leaving && agent)) && (
          <span className="agent-working__actions">
            {/* Its project and its session, one ⋯ away: not a row under every turn.
                First, so the text actions keep the right edge while it's hidden. */}
            {!leaving && agent && <WorkMenu agent={agent} />}
            {step.actions}
          </span>
        )}
      </div>
      {live.list}
      {under && (
        <div className="agent-working__under">
          {step.under}
          {step.browser}
        </div>
      )}
    </div>
  );
}
