/**
 * Routines in steps on the desk (`agents/routine_steps.rs`): the editor's
 * "Then…" rows under What, the numbered steps under a routine's row, and the
 * body of the "OK to go on?" card a run waits on between two steps.
 *
 * Calm by construction: one line per step, the step that waits for you
 * marked in words ("after your OK"), no colour but the muted number. The
 * card shows what comes next word for word, then what the step before made,
 * folded once it's long; Go ahead says yes to exactly that.
 *
 * @module components/agents/AgentRoutineSteps
 */

import { useState } from 'react';
import { CloseIcon, PlusIcon } from '@/components/icons';
import { Checkbox } from '../primitives/Checkbox';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { Prose } from './AgentProse';
import {
  MAX_THEN,
  routineSteps,
  type CheckIn,
  type RoutineGate,
  type RoutineStep,
} from '../../lib/agents';

/** "Then…" in the routine editor: the steps after What. */
export function AgentStepsEditor({
  steps,
  onChange,
  onKeyDown,
}: {
  steps: RoutineStep[];
  onChange: (steps: RoutineStep[]) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const set = (i: number, patch: Partial<RoutineStep>) =>
    onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="agent-steps" role="group" aria-label="Then">
      {steps.map((s, i) => (
        <div key={i} className="agent-steps__row">
          <span className="agent-steps__number" aria-hidden="true">
            {i + 2}
          </span>
          <TextField
            className="ss-text-field--compact agent-steps__field"
            value={s.text}
            onChange={(e) => set(i, { text: e.target.value })}
            onKeyDown={onKeyDown}
            placeholder="Post it to #team on Slack"
            aria-label={`Step ${i + 2}`}
            maxLength={600}
            // A new step is where the cursor goes.
            autoFocus={i === steps.length - 1 && !s.text}
          />
          <label className="agent-steps__ask">
            <Checkbox
              checked={Boolean(s.askFirst)}
              onChange={(askFirst) => set(i, { askFirst })}
              label={`Step ${i + 2}: wait for your OK first`}
            />
            <span aria-hidden="true">Your OK first</span>
          </label>
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<CloseIcon size={12} />}
            aria-label={`Remove step ${i + 2}`}
            title="Remove step"
            onClick={() => onChange(steps.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      {steps.length < MAX_THEN && (
        <div className="agent-steps__add">
          <TextButton
            tabIndex={0}
            leftIcon={<PlusIcon size={10} />}
            // The usual second step sends what the first drafted: it asks first.
            onClick={() => onChange([...steps, { text: '', askFirst: true }])}
          >
            {steps.length === 0 ? 'Then…' : 'Add a step'}
          </TextButton>
          {steps.length === 0 && (
            <span className="agent-steps__hint">Draft first, then post once you OK it.</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A routine's steps; nothing for a routine of one step. `afterNote`: the
 * row already shows the note (step 1), so the list starts at step 2.
 */
export function AgentStepsList({
  item,
  afterNote = false,
}: {
  item: Pick<CheckIn, 'note' | 'then'>;
  afterNote?: boolean;
}) {
  const steps = routineSteps(item);
  if (steps.length < 2) return null;
  return (
    <ol className="agent-steps__list" aria-label="Steps">
      {steps.slice(afterNote ? 1 : 0).map((s) => (
        <li key={s.n} className="agent-steps__item">
          <span className="agent-steps__number" aria-hidden="true">
            {s.n}
          </span>
          <span className="agent-steps__text">
            {s.askFirst && <span className="agent-steps__gate">After your OK · </span>}
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Past this many characters, what the step made folds behind "Show all". */
const FOLD_AT = 700;

/** The body of "OK to go on?": what's next, then what the step before made. */
export function AgentGateBody({ gate, produced }: { gate: RoutineGate; produced: string }) {
  const [open, setOpen] = useState(false);
  const draft = produced.trim();
  const long = draft.length > FOLD_AT;
  return (
    <div className="agent-gate">
      <div className="agent-gate__next">
        <span className="agent-gate__label">
          Next, step {gate.done + 1} of {gate.total}
        </span>
        <span className="agent-gate__step">{gate.next}</span>
      </div>
      {draft && (
        <figure className="agent-gate__made" data-folded={long && !open ? '' : undefined}>
          <figcaption className="agent-gate__label">What step {gate.done} made</figcaption>
          <div className="agent-gate__prose">
            <Prose text={long && !open ? `${draft.slice(0, FOLD_AT).trimEnd()}…` : draft} />
          </div>
          {long && (
            <TextButton
              tabIndex={0}
              className="agent-gate__more"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Show less' : 'Show all'}
            </TextButton>
          )}
        </figure>
      )}
    </div>
  );
}
