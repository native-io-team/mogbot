/**
 * The moment an import is checked by the person it's for
 * (`agents/harvest.rs`, `agents/connector.rs`): before anything is created,
 * the Chief plays back what each agent will do, in plain words and the first
 * person ("Every Monday at 09:00: send you last week's spending"), and asks
 * "Is there anything I'm missing?".
 *
 * The lines are built by the backend from what was staged, never written by
 * a model, so they say exactly what Import would bring. What the user adds
 * goes back to the sealed interview, which folds it in and plays the plan
 * back again; "That's everything" brings up the review card. Lines the
 * import couldn't fill ("Nothing on a schedule…") are shown as gaps, so a
 * missing routine reads as something to add, not something lost.
 *
 * @module components/agents/ImportPlaybackCard
 */

import { memo, useState } from 'react';
import { CheckIcon, DownloadIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/TextField';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  answerImportPlayback,
  type AgentMessage,
  type ConnectorCard,
  type PlaybackAgent,
} from '../../lib/agents';
import { AgentCard } from './AgentCard';

/** The plan for one agent: its name, then what it will do, gaps last. */
export function PlaybackPlan({ agent }: { agent: PlaybackAgent }) {
  const said = agent.lines.filter((l) => l.kind !== 'gap');
  const gaps = agent.lines.filter((l) => l.kind === 'gap');
  return (
    <section className="agent-import-playback__agent" aria-label={`What ${agent.name} will do`}>
      <h4 className="agent-import-playback__name">{agent.name}</h4>
      {said.length > 0 && (
        <ul className="agent-import-playback__lines">
          {said.map((l, i) => (
            <li key={i} data-kind={l.kind}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
      {gaps.length > 0 && (
        <ul className="agent-import-playback__lines agent-import-playback__lines--gaps">
          {gaps.map((l, i) => (
            <li key={i} data-kind="gap">
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ImportPlaybackCardProps {
  message: AgentMessage;
  card: ConnectorCard;
  arrived?: boolean;
}

export const ImportPlaybackCard = memo(function ImportPlaybackCard({
  message,
  card,
  arrived,
}: ImportPlaybackCardProps) {
  const approval = message.approval!;
  const pending = approval.status === 'pending';
  const plan = card.playback ?? [];
  const [addition, setAddition] = useState('');
  const [busy, setBusy] = useState(false);
  const { showToast } = useOptionalToast();

  const answer = async (text?: string) => {
    setBusy(true);
    try {
      await answerImportPlayback(message.agentId, approval.requestId, text);
      setAddition('');
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const outcome =
    approval.status === 'allowed'
      ? (approval.choice ?? 'That’s everything')
      : approval.status === 'expired' || approval.status === 'denied'
        ? 'The import was stopped. Nothing was created.'
        : null;

  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        as="section"
        className="agent-import-playback"
        data={{ status: approval.status }}
        aria-label={approval.title}
        data-testid="agent-import-playback"
        icon={<DownloadIcon size={14} />}
        title={approval.title}
        actions={
          pending ? (
            <>
              <Button
                variant="secondary"
                disabled={busy || !addition.trim()}
                onClick={() => void answer(addition)}
                data-testid="agent-import-playback-add"
              >
                Add this
              </Button>
              {/* The affirmative answer: neutral, like Allow. */}
              <Button variant="strong" disabled={busy} onClick={() => void answer()}>
                That’s everything
              </Button>
            </>
          ) : undefined
        }
        outcome={
          pending ? undefined : (
            <span className="agent-import-review__outcome" data-status={approval.status}>
              {approval.status === 'allowed' && <CheckIcon size={12} />}
              {outcome}
            </span>
          )
        }
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
      >
        {pending && (
          <p className="agent-import-review__lede">
            Here’s what I understood from {card.source}. Nothing is created yet: you review every
            agent next.
          </p>
        )}
        <div className="agent-import-playback__plan">
          {plan.map((a) => (
            <PlaybackPlan key={a.key} agent={a} />
          ))}
        </div>
        {pending && (
          <label className="agent-import-playback__ask">
            <span className="agent-import-playback__question">Is there anything I’m missing?</span>
            <TextArea
              rows={2}
              value={addition}
              disabled={busy}
              placeholder="Something it does that isn’t here, like “it also reminds me to pay rent on the 1st”"
              onChange={(e) => setAddition(e.target.value)}
              data-testid="agent-import-playback-input"
            />
          </label>
        )}
      </AgentCard>
    </div>
  );
});
