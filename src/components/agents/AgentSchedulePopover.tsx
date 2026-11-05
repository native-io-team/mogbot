/**
 * An agent's schedule, anchored to the chat header: the check-ins it set for
 * itself and the routines you gave it, and one line to add another.
 *
 * The trigger reads "N scheduled", or is a quiet clock when there's nothing.
 * The composer takes "when: what" in one line and reads the time back as the
 * backend resolved it, so what you see is what will fire. Edit puts a row's
 * own words back in that composer; Run now wakes the agent with it at once,
 * leaving its next time alone. Changes apply at once and the list follows
 * the agent registry.
 *
 * "At a time / When…" switches the composer: a "When…" routine starts when
 * something happens (`AgentWhenRoutine`). Its row says what it waits for,
 * what it does, and what its last check found; Run now is Check now.
 *
 * @module components/agents/AgentSchedulePopover
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  CloseIcon,
  EditFieldIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  SkipNextIcon,
} from '@/components/icons';
import { Dropdown } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { WhenComposer } from './AgentWhenRoutine';
import {
  cancelCheckIn,
  checkWatchNow,
  createCheckIn,
  describeCheckInTime,
  describeRepeat,
  describeRun,
  describeRunDetail,
  describeWatchCost,
  describeWatchStatus,
  describeWatchTitle,
  formatWhen,
  pauseCheckIn,
  previewSchedule,
  runCheckInNow,
  scheduleWhenPhrase,
  sortCheckIns,
  splitScheduleInput,
  updateCheckIn,
  type Agent,
  type CheckIn,
  type CheckInRun,
  type SchedulePreview,
  type WatchCheckOutcome,
} from '../../lib/agents';
import { KeepAwakeLink } from './AgentsStayOn';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

/** A Validation error's reason, without the examples meant for an agent. */
function reasonOf(err: unknown): string {
  const e = asCommandError(err);
  const text = e.type === 'Validation' ? e.reason : formatCommandError(e);
  return text.split(' Examples:')[0];
}

/** "Every weekday at 9:00 AM, first tomorrow 9:00 AM" / "Tomorrow 9:00 AM". */
function readBack(p: SchedulePreview): string {
  if (!p.repeat) return formatWhen(p.nextAt);
  const first = formatWhen(p.nextAt).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return `${describeRepeat(p.repeat)}, first ${first}`;
}

interface AgentSchedulePopoverProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on the "When…" composer (⌘K → "Start work when something happens…"). */
  startWhen?: boolean;
}

export function AgentSchedulePopover({
  agent,
  open,
  onOpenChange,
  startWhen = false,
}: AgentSchedulePopoverProps) {
  const count = agent.checkIns?.length ?? 0;
  return (
    <Dropdown
      align="right"
      portal
      open={open}
      onOpenChange={onOpenChange}
      menuClassName="agent-schedule"
      trigger={(p) =>
        count > 0 ? (
          <Button
            {...p}
            tabIndex={0}
            variant="ghost"
            className="agent-chat__scheduled"
            leftIcon={<HistoryIcon size={12} />}
            title="Scheduled check-ins"
          >
            {count} scheduled
          </Button>
        ) : (
          <IconButton
            {...p}
            tabIndex={0}
            variant="ghost"
            icon={<HistoryIcon size={14} />}
            title="Schedule a check-in"
            aria-label={`Schedule a check-in for ${agent.name}`}
          />
        )
      }
    >
      <ScheduleBody agent={agent} startWhen={startWhen} onRan={() => onOpenChange(false)} />
    </Dropdown>
  );
}

/** Mounted each time the popover opens, so it starts fresh with focus in the composer. */
function ScheduleBody({
  agent,
  startWhen,
  onRan,
}: {
  agent: Agent;
  startWhen: boolean;
  onRan: () => void;
}) {
  const items = sortCheckIns(agent.checkIns ?? []);
  const [mode, setMode] = useState<'time' | 'when'>(startWhen ? 'when' : 'time');
  /** The "When…" routine in the composer, if it's an edit. */
  const [editingWhen, setEditingWhen] = useState<CheckIn | null>(null);
  const [text, setText] = useState('');
  /** The row whose words are in the composer, if it's an edit. */
  const [editing, setEditing] = useState<CheckIn | null>(null);
  const [preview, setPreview] = useState<SchedulePreview | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { when, note } = splitScheduleInput(text);

  // After the Dropdown's own focus handling, which would park it on the menu.
  useEffect(() => inputRef.current?.focus(), [mode]);

  // Read the time back as it's typed, after a short pause.
  useEffect(() => {
    if (!when) return;
    let live = true;
    const timer = window.setTimeout(() => {
      previewSchedule(when)
        .then((p) => live && setPreview(p))
        .catch((err) => live && setPreview(reasonOf(err)));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [when]);

  const { execute: run, isLoading: busy } = useAsyncState(async (change: () => Promise<void>) => {
    setError(null);
    try {
      await change();
      await refreshAgents();
    } catch (err) {
      setError(reasonOf(err));
    }
  });

  const parsed = when && preview !== null && typeof preview !== 'string' ? preview : null;
  const canAdd = parsed !== null && note.length > 0 && !busy;

  const reset = () => {
    setEditing(null);
    setText('');
    setPreview(null);
    setError(null);
  };

  const startEdit = (c: CheckIn) => {
    if (c.watch) {
      reset();
      setMode('when');
      setEditingWhen(c);
      return;
    }
    setMode('time');
    setEditingWhen(null);
    setEditing(c);
    setError(null);
    setText(`${scheduleWhenPhrase(c)}: ${c.note}`);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && editing) {
      // Leave the edit, not the popover.
      e.preventDefault();
      e.stopPropagation();
      reset();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!canAdd) return;
    void run(async () => {
      if (editing) await updateCheckIn(agent.id, editing.id, when, note);
      else await createCheckIn(agent.id, when, note);
      reset();
    });
  };

  const reason = when && typeof preview === 'string' ? preview : null;
  const problem = error ?? reason;
  const invalid = problem !== null;
  let readback = 'Say when, then what to do. Return adds it.';
  if (problem) readback = problem;
  else if (parsed && !note) readback = `${readBack(parsed)} · then a colon and what to do`;
  else if (parsed) readback = readBack(parsed);
  else if (when) readback = '\u00a0';

  return (
    <div className="agent-schedule__body">
      {items.length > 0 ? (
        <ul className="agent-schedule__list" aria-label="Scheduled">
          {items.map((c) => (
            <ScheduleRow
              key={c.id}
              item={c}
              busy={busy}
              editing={editing?.id === c.id || editingWhen?.id === c.id}
              onRunNow={() =>
                void run(async () => {
                  await runCheckInNow(agent.id, c.id);
                  onRan();
                })
              }
              onCheckNow={async () => {
                const outcome = await checkWatchNow(agent.id, c.id);
                await refreshAgents();
                return outcome;
              }}
              onEdit={() => startEdit(c)}
              onTogglePause={() => void run(() => pauseCheckIn(agent.id, c.id, !c.paused))}
              onCancel={() => void run(() => cancelCheckIn(agent.id, c.id))}
            />
          ))}
        </ul>
      ) : (
        <p className="agent-schedule__empty">Nothing scheduled for {agent.name} yet.</p>
      )}

      <div className="agent-schedule__mode">
        <SegmentedControl
          aria-label="Kind of routine"
          value={mode}
          onValueChange={(m) => {
            reset();
            setEditingWhen(null);
            setMode(m);
          }}
          options={[
            { value: 'time', label: 'At a time' },
            { value: 'when', label: 'When…' },
          ]}
        />
      </div>

      {mode === 'when' ? (
        <div className="agent-schedule__composer">
          <WhenComposer
            key={editingWhen?.id ?? 'new'}
            agent={agent}
            editing={editingWhen}
            onDone={() => setEditingWhen(null)}
          />
        </div>
      ) : (
        <div className="agent-schedule__composer">
          <TextField
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. every weekday 9am: brief me on Acme"
            aria-label={
              editing
                ? `Edit “${editing.note}”: when, a colon, then what to do`
                : 'New check-in: when, a colon, then what to do'
            }
            invalid={invalid}
            maxLength={640}
          />
          <p
            className="agent-schedule__readback"
            data-invalid={invalid || undefined}
            aria-live="polite"
          >
            {readback}
          </p>
        </div>
      )}

      <p className="agent-schedule__foot">
        {editing ? (
          'Return saves the change; Esc leaves it as it was.'
        ) : mode === 'when' ? (
          <>
            Checks run only while the app is open and this Mac is awake; what arrives meanwhile is
            found by the next check.
            <KeepAwakeLink />
          </>
        ) : (
          <>
            Runs only while the app is open and this Mac is awake; a missed check-in runs once when
            it’s back.
            <KeepAwakeLink />
          </>
        )}
      </p>
    </div>
  );
}

function ScheduleRow({
  item,
  busy,
  editing,
  onRunNow,
  onCheckNow,
  onEdit,
  onTogglePause,
  onCancel,
}: {
  item: CheckIn;
  busy: boolean;
  editing: boolean;
  onRunNow: () => void;
  onCheckNow: () => Promise<WatchCheckOutcome>;
  onEdit: () => void;
  onTogglePause: () => void;
  onCancel: () => void;
}) {
  const runs = item.runs ?? [];
  const [showRuns, setShowRuns] = useState(false);
  const watch = item.watch;
  // What Check now came to, said under the row until the popover closes.
  const [checked, setChecked] = useState<string | null>(null);
  const { execute: checkNow, isLoading: checking } = useAsyncState(async () => {
    setChecked(null);
    try {
      setChecked(describeCheck(await onCheckNow()));
    } catch (err) {
      setChecked(reasonOf(err));
    }
  });
  const cost = watch ? describeWatchCost(watch) : null;
  return (
    <li
      className="agent-schedule__item"
      data-paused={item.paused || undefined}
      data-editing={editing || undefined}
      data-history={showRuns || undefined}
    >
      <div className="agent-schedule__text">
        {watch ? (
          <>
            <span className="agent-schedule__note">{describeWatchTitle(watch.source)}</span>
            <span className="agent-when__then">{item.note}</span>
            <span
              className="agent-schedule__when"
              data-retrying={item.retry || (watch.failures > 0 && !item.paused) ? '' : undefined}
            >
              {describeWatchStatus(item)}
            </span>
            {cost && <span className="agent-when__spent">{cost}</span>}
            {checked && (
              <span className="agent-when__checked" aria-live="polite">
                {checked}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="agent-schedule__note">{item.note}</span>
            <span className="agent-schedule__when" data-retrying={item.retry ? '' : undefined}>
              {describeCheckInTime(item)}
            </span>
          </>
        )}
        {runs.length > 0 && (
          <TextButton
            tabIndex={0}
            className="agent-schedule__last"
            aria-expanded={showRuns}
            onClick={() => setShowRuns((v) => !v)}
          >
            {showRuns ? 'Hide past runs' : `Past runs (${runs.length})`}
          </TextButton>
        )}
      </div>
      <div className="agent-schedule__actions">
        {watch ? (
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<SearchIcon size={12} />}
            onClick={() => void checkNow()}
            disabled={busy || checking}
            title="Check now"
            aria-label={`Check now for “${item.note}”`}
          />
        ) : (
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<SkipNextIcon size={12} />}
            onClick={onRunNow}
            disabled={busy}
            title="Run now"
            aria-label={`Run “${item.note}” now`}
          />
        )}
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<EditFieldIcon size={12} />}
          onClick={onEdit}
          disabled={busy}
          title="Edit"
          aria-label={`Edit “${item.note}”`}
        />
        {(item.repeat || watch) && (
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={item.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
            onClick={onTogglePause}
            disabled={busy}
            title={item.paused ? 'Resume' : 'Pause'}
            aria-label={item.paused ? `Resume “${item.note}”` : `Pause “${item.note}”`}
          />
        )}
        <IconButton
          tabIndex={0}
          variant="ghost"
          size="compact"
          icon={<CloseIcon size={12} />}
          onClick={onCancel}
          disabled={busy}
          title="Cancel"
          aria-label={`Cancel “${item.note}”`}
        />
      </div>
      {showRuns && <RunHistory runs={runs} />}
    </li>
  );
}

/** What Check now came to, in a line. */
function describeCheck(o: WatchCheckOutcome): string {
  if (o.paused) return o.paused;
  if (o.error) return `Check failed: ${o.error}`;
  if (o.baseline) return 'Noted what’s there now; anything new from here starts work.';
  if (o.found > 0) return `Found ${o.found} new; it’s on it.`;
  return 'Nothing new.';
}

/** The last runs, newest first: when, and what came of it. */
function RunHistory({ runs }: { runs: CheckInRun[] }) {
  return (
    <ul className="agent-schedule__history" aria-label="Past runs">
      {[...runs].reverse().map((run) => {
        const extra = [
          run.manual ? 'run now' : null,
          run.detail ? describeRunDetail(run.detail) : null,
          run.signIn?.length ? `${run.signIn.join(', ')} needs signing in again` : null,
        ].filter(Boolean);
        const outcome = [describeRun(run), ...extra].join(' · ');
        return (
          <li
            key={`${run.at}-${run.attempt}`}
            className="agent-schedule__run"
            data-outcome={run.outcome}
          >
            <time className="agent-schedule__run-time" dateTime={new Date(run.at).toISOString()}>
              {formatWhen(run.at)}
            </time>
            <span className="agent-schedule__run-outcome" title={outcome}>
              {outcome}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
