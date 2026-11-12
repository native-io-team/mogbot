/**
 * "Describe the agent you want": the top of the New agent dialog. A few
 * sentences in, **Draft it**, and the app asks the engine new agents start on
 * for the whole agent (`agents_draft`, `agents/draft.rs`): a name, a colour,
 * a one-line role, its briefing, routines and the apps it will need. The
 * draft fills the dialog's own fields, which stay editable, and the routines
 * come back as a list to keep or leave (`AgentDraftRoutines`). Nothing is
 * made until Create.
 *
 * Each routine shows the time as the app's own grammar read it, never the
 * model's words alone; one it couldn't read says why and can't be ticked.
 * Apps are named as what it will ask for, never as connected.
 *
 * @module components/agents/AgentDescribe
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { ErrorIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { Spinner } from '../primitives/Spinner';
import { TextArea } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { AgentStepsList } from './AgentRoutineSteps';
import {
  DESCRIBE_PLACEHOLDER,
  draftAgent,
  draftAppsLine,
  whenLabel,
  type AgentDraft,
  type DraftRoutine,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';
import { ROUTINES_MEANS } from '../../../packages/companion-protocol/src/cardWords';
import { THIS_COMPUTER } from '../../lib/computer';

/** The one prompt, and Draft it. */
export function AgentDescribe({
  autoFocus = false,
  onDrafted,
}: {
  autoFocus?: boolean;
  onDrafted: (draft: AgentDraft, description: string) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useAsyncState(async () => {
    setError(null);
    try {
      onDrafted(await draftAgent(text.trim()), text.trim());
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  });
  const ready = text.trim().length >= 8 && !draft.isLoading;
  // ⌘Enter drafts here, rather than creating an empty agent from the form.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    if (ready) void draft.execute();
  };
  return (
    <div className="agent-describe">
      <label className="agent-editor__label" htmlFor="agent-describe-text">
        Describe the agent you want
      </label>
      <TextArea
        id="agent-describe-text"
        ref={ref}
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={DESCRIBE_PLACEHOLDER}
        maxLength={4000}
        autoFocus={autoFocus}
        disabled={draft.isLoading}
      />
      <div className="agent-describe__actions">
        {/* The dialog's one strong button until there's a draft: neutral,
            so it never looks like the agent's colour or a status. */}
        <Button
          tabIndex={0}
          variant="strong"
          disabled={!ready}
          leftIcon={draft.isLoading ? <Spinner size="sm" /> : undefined}
          onClick={() => void draft.execute()}
        >
          {draft.isLoading ? 'Drafting…' : 'Draft it'}
        </Button>
        <span className="agent-describe__hint">
          {draft.isLoading
            ? 'Writing its name, what it does and when it runs. This takes a little while.'
            : 'Its name, what it does and when it runs, for you to check before anything is made.'}
        </span>
      </div>
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}

/** After a draft: where it came from, and the way back. */
export function AgentDrafted({ onStartOver }: { onStartOver: () => void }) {
  return (
    <p className="agent-describe__drafted">
      Drafted from your description. Check it, then Create.{' '}
      <TextButton tabIndex={0} onClick={onStartOver}>
        Start over
      </TextButton>
    </p>
  );
}

/** The drafted routines to keep or leave, and the apps it will ask for. */
export function AgentDraftRoutines({
  draft,
  kept,
  onKept,
}: {
  draft: AgentDraft;
  kept: boolean[];
  onKept: (index: number, on: boolean) => void;
}) {
  const apps = draftAppsLine(draft.apps);
  if (draft.routines.length === 0 && !apps) return null;
  return (
    <div className="agent-editor__label" role="group" aria-label="Routines">
      {draft.routines.length > 0 && (
        <>
          Routines
          <p className="agent-editor__hint">{ROUTINES_MEANS}</p>
          <ul className="agent-draft__routines">
            {draft.routines.map((r, i) => (
              <DraftRoutineRow
                key={`${i}-${r.when}`}
                routine={r}
                on={!r.problem && kept[i] !== false}
                onChange={(on) => onKept(i, on)}
              />
            ))}
          </ul>
          <p className="agent-editor__hint">
            Routines run while the app is open and {THIS_COMPUTER} is awake. A step after your OK
            waits on a card in its chat, here or on your phone.
          </p>
        </>
      )}
      {apps && <p className="agent-editor__hint agent-draft__apps">{apps}</p>}
    </div>
  );
}

function DraftRoutineRow({
  routine,
  on,
  onChange,
}: {
  routine: DraftRoutine;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const when = whenLabel(routine.readsAs ?? routine.when);
  const steps = (routine.then?.length ?? 0) > 0;
  return (
    <li className="agent-draft__routine" data-off={!on || undefined}>
      <Checkbox
        checked={on}
        disabled={!!routine.problem}
        onChange={onChange}
        label={`Keep: ${when}, ${routine.note}`}
      />
      <div className="agent-draft__routine-text">
        <span className="agent-draft__when">{when}</span>
        {steps ? (
          <AgentStepsList item={routine} />
        ) : (
          <span className="agent-draft__note">{routine.note}</span>
        )}
        {routine.problem && <span className="agent-draft__problem">{routine.problem}</span>}
      </div>
    </li>
  );
}
