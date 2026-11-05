/**
 * An agent's schedule, anchored to the chat header: the check-ins it set for
 * itself and the routines you gave it, and a picker to add another.
 *
 * The trigger reads "N scheduled", or is a quiet clock when there's nothing.
 * Adding or editing is the phone's picker, not a grammar: When is a few
 * chips (Every day / Weekdays / Weekly + days / Every few hours / Once with a
 * date) and a time, What is one line, and above Schedule it says back what it
 * will make ("Every weekday at 9:00 AM — Draft my day") with the first run as
 * the backend resolved it, so what you save is what will fire. The picker
 * writes the same `when` words the backend's grammar reads
 * (`routineWhenPhrase`, packages/companion-protocol/src/routine-phrases.json),
 * so a desk-made routine is a phone-made one.
 *
 * Run now wakes the agent with a row at once, leaving its next time alone.
 * Changes apply at once and the list follows the agent registry.
 *
 * A routine that ran on its own this week says what it cost, as its engine
 * reported it: dollars "at API prices" when every run was priced and Claude
 * reported no plan, else tokens (on a Pro or Max plan the price isn't the
 * bill), else nothing.
 *
 * @module components/agents/AgentSchedulePopover
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CloseIcon,
  EditFieldIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SkipNextIcon,
} from '@/components/icons';
import { Dropdown } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { ToggleButton } from '../primitives/ToggleButton';
import { Tooltip } from '../primitives/Tooltip';
import {
  CADENCES,
  cancelCheckIn,
  COST_BASIS_NOTE,
  createCheckIn,
  describeCheckInTime,
  describeRepeat,
  describeRun,
  describeRunDetail,
  formatWhen,
  formatWhenInline,
  getAgentUsage,
  INTERVALS,
  intervalLabel,
  newPicker,
  onClaudePlan,
  onceDays,
  pauseCheckIn,
  pickerOf,
  previewSchedule,
  routineEcho,
  routineInPast,
  routineWeekLine,
  routineWhenOf,
  routineWhenPhrase,
  runCheckInNow,
  sortCheckIns,
  toggleDay,
  updateCheckIn,
  WEEK,
  whenOf,
  type Agent,
  type CheckIn,
  type CheckInRun,
  type PickerState,
  type SchedulePreview,
  type UsageSummary,
} from '../../lib/agents';
import { KeepAwakeLink } from './AgentsStayOn';
import { useQuotaLines } from './AgentsQuota';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

/** A Validation error's reason, without the examples meant for an agent. */
function reasonOf(err: unknown): string {
  const e = asCommandError(err);
  const text = e.type === 'Validation' ? e.reason : formatCommandError(e);
  return text.split(' Examples:')[0];
}

/** The backend's reading: "First run tomorrow at 9:00 AM" / "Runs today at 5:00 PM". */
function firstRun(p: SchedulePreview): string {
  const when = formatWhenInline(p.nextAt);
  return p.repeat ? `First run ${when}` : `Runs ${when}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

interface AgentSchedulePopoverProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentSchedulePopover({ agent, open, onOpenChange }: AgentSchedulePopoverProps) {
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
            title="Scheduled routines"
          >
            {count} scheduled
          </Button>
        ) : (
          <IconButton
            {...p}
            tabIndex={0}
            variant="ghost"
            icon={<HistoryIcon size={14} />}
            title="Schedule a routine"
            aria-label={`Schedule a routine for ${agent.name}`}
          />
        )
      }
    >
      <ScheduleBody agent={agent} onRan={() => onOpenChange(false)} />
    </Dropdown>
  );
}

/** Mounted each time the popover opens, so it starts fresh. */
function ScheduleBody({ agent, onRan }: { agent: Agent; onRan: () => void }) {
  const items = sortCheckIns(agent.checkIns ?? []);
  /** The picker: open for a new routine (`'new'`) or for a row's edit. */
  const [composing, setComposing] = useState<CheckIn | 'new' | null>(() =>
    items.length === 0 ? 'new' : null
  );
  const editing = composing && composing !== 'new' ? composing : null;
  const [error, setError] = useState<string | null>(null);

  // Each routine's week, read once per opening (it moves only when a run ends).
  const usage = useAsyncState<UsageSummary>(() => getAgentUsage(agent.id), { immediate: true });
  const weekOf = (id: string) => usage.data?.routines?.find((r) => r.id === id)?.week;
  const onPlan = onClaudePlan(useQuotaLines());
  const { execute: run, isLoading: busy } = useAsyncState(
    async (change: () => Promise<void>): Promise<boolean> => {
      setError(null);
      try {
        await change();
        await refreshAgents();
        return true;
      } catch (err) {
        setError(reasonOf(err));
        return false;
      }
    }
  );

  return (
    <div className="agent-schedule__body">
      {items.length > 0 ? (
        <ul className="agent-schedule__list" aria-label="Scheduled">
          {items.map((c) => (
            <ScheduleRow
              key={c.id}
              item={c}
              spent={routineWeekLine(weekOf(c.id), onPlan)}
              priced={!onPlan && (weekOf(c.id)?.pricedTurns ?? 0) > 0}
              busy={busy}
              editing={editing?.id === c.id}
              onRunNow={() =>
                void run(async () => {
                  await runCheckInNow(agent.id, c.id);
                  onRan();
                })
              }
              onEdit={() => {
                setError(null);
                setComposing(c);
              }}
              onTogglePause={() => void run(() => pauseCheckIn(agent.id, c.id, !c.paused))}
              onCancel={() => void run(() => cancelCheckIn(agent.id, c.id))}
            />
          ))}
        </ul>
      ) : (
        <p className="agent-schedule__empty">Nothing scheduled for {agent.name} yet.</p>
      )}

      {composing ? (
        <RoutinePicker
          // A fresh picker for each row edited.
          key={editing?.id ?? 'new'}
          agent={agent}
          editing={editing}
          busy={busy}
          error={error}
          onCancel={
            items.length > 0 || editing
              ? () => {
                  setError(null);
                  setComposing(null);
                }
              : undefined
          }
          onSave={(phrase, note) =>
            void run(async () => {
              if (editing) await updateCheckIn(agent.id, editing.id, phrase, note);
              else await createCheckIn(agent.id, phrase, note);
            }).then((ok) => ok && setComposing(null))
          }
        />
      ) : (
        <div className="agent-schedule__add">
          <Button
            tabIndex={0}
            variant="secondary"
            size="compact"
            leftIcon={<PlusIcon size={12} />}
            onClick={() => {
              setError(null);
              setComposing('new');
            }}
          >
            New routine
          </Button>
          {error && (
            <p className="agent-schedule__readback" data-invalid>
              {error}
            </p>
          )}
        </div>
      )}

      <p className="agent-schedule__foot">
        Runs only while the app is open and this Mac is awake; a missed routine runs once when it’s
        back.
        <KeepAwakeLink />
      </p>
    </div>
  );
}

type Reading =
  | { kind: 'reading' }
  | { kind: 'ok'; preview: SchedulePreview }
  | { kind: 'bad'; reason: string };

/**
 * When (chips and a time) and What (one line), the echo of what it will
 * make, then Cancel / Schedule. The phone's picker, on the desk.
 */
function RoutinePicker({
  agent,
  editing,
  busy,
  error,
  onCancel,
  onSave,
}: {
  agent: Agent;
  editing: CheckIn | null;
  busy: boolean;
  error: string | null;
  /** Absent when there's nothing else to show (no routines yet). */
  onCancel?: () => void;
  /** `phrase` is empty for an edit that left When as it was. */
  onSave: (phrase: string, note: string) => void;
}) {
  const [picker, setPicker] = useState<PickerState>(() =>
    editing ? pickerOf(routineWhenOf(editing)) : newPicker()
  );
  // What When said when the picker opened: unchanged, it isn't re-sent, so
  // "every 2 hours" isn't re-anchored to now by editing the note.
  const [openedAs] = useState(() => (editing ? routineWhenPhrase(routineWhenOf(editing)) : null));
  const [note, setNote] = useState(() => editing?.note ?? '');
  const [answer, setAnswer] = useState<{ phrase: string; reading: Reading } | null>(null);
  const noteRef = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<PickerState>) => setPicker((p) => ({ ...p, ...patch }));

  // After the Dropdown's own focus handling, which would park it on the menu.
  useEffect(() => noteRef.current?.focus(), []);

  // The clock as the picker opened: it lives only while the popover is open.
  const [now] = useState(() => Date.now());
  const when = whenOf(picker);
  const phrase = when ? routineWhenPhrase(when) : '';
  const past = when ? routineInPast(when, now) : false;
  const [keepDate] = useState(() => (editing && !editing.repeat ? picker.date : undefined));
  const days = useMemo(() => onceDays(now, keepDate), [now, keepDate]);
  const [intervals] = useState(() =>
    INTERVALS.includes(picker.minutes) ? INTERVALS : [...INTERVALS, picker.minutes]
  );

  // The backend reads the words back: the first run, or why it can't.
  useEffect(() => {
    if (!phrase || past) return;
    let live = true;
    const timer = window.setTimeout(() => {
      previewSchedule(phrase).then(
        (preview) => live && setAnswer({ phrase, reading: { kind: 'ok', preview } }),
        (err: unknown) =>
          live && setAnswer({ phrase, reading: { kind: 'bad', reason: reasonOf(err) } })
      );
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [phrase, past]);

  const reading: Reading = past
    ? { kind: 'bad', reason: 'That time has passed. Pick a later one.' }
    : answer?.phrase === phrase
      ? answer.reading
      : { kind: 'reading' };
  const ready = reading.kind === 'ok' && note.trim().length > 0 && !busy;
  const save = () => {
    if (!ready) return;
    onSave(editing && phrase === openedAs ? '' : phrase, note.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && onCancel) {
      // Leave the picker, not the popover.
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    save();
  };
  const timed = picker.cadence !== 'hours';

  return (
    <div
      className="agent-schedule__picker"
      role="group"
      aria-label={editing ? 'Edit routine' : 'New routine'}
    >
      <div className="agent-schedule__field">
        <span className="agent-schedule__label" id="agent-schedule-when">
          When
        </span>
        <div className="agent-schedule__chips" role="group" aria-labelledby="agent-schedule-when">
          {CADENCES.map((c) => (
            <ToggleButton
              key={c.value}
              tabIndex={0}
              size="compact"
              variant="secondary"
              pressed={picker.cadence === c.value}
              onClick={() => change({ cadence: c.value })}
            >
              {c.label}
            </ToggleButton>
          ))}
        </div>
        {picker.cadence === 'weekly' && (
          <div className="agent-schedule__chips" role="group" aria-label="On these days">
            {WEEK.map((d) => (
              <ToggleButton
                key={d.day}
                tabIndex={0}
                size="compact"
                variant="secondary"
                aria-label={d.name}
                pressed={picker.days.includes(d.day)}
                onClick={() => change({ days: toggleDay(picker.days, d.day) })}
              >
                {d.short}
              </ToggleButton>
            ))}
          </div>
        )}
        {picker.cadence === 'hours' && (
          <div className="agent-schedule__chips" role="group" aria-label="Every">
            {intervals.map((m) => (
              <ToggleButton
                key={m}
                tabIndex={0}
                size="compact"
                variant="secondary"
                pressed={picker.minutes === m}
                onClick={() => change({ minutes: m })}
              >
                {intervalLabel(m)}
              </ToggleButton>
            ))}
          </div>
        )}
        {picker.cadence === 'once' && (
          <div className="agent-schedule__chips" role="group" aria-label="On">
            {days.map((d) => (
              <ToggleButton
                key={d.date}
                tabIndex={0}
                size="compact"
                variant="secondary"
                pressed={picker.date === d.date}
                onClick={() => change({ date: d.date })}
              >
                {d.label}
              </ToggleButton>
            ))}
          </div>
        )}
        {timed && (
          <label className="agent-schedule__time">
            <span>At</span>
            <TextField
              type="time"
              required
              value={`${pad2(picker.hour)}:${pad2(picker.minute)}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) change({ hour: h, minute: m });
              }}
              onKeyDown={onKeyDown}
              aria-label="At"
            />
          </label>
        )}
      </div>

      <div className="agent-schedule__field">
        <label className="agent-schedule__label" htmlFor="agent-schedule-what">
          What
        </label>
        <TextField
          id="agent-schedule-what"
          ref={noteRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Draft my day"
          aria-label={`What ${agent.name} should do`}
          maxLength={600}
        />
      </div>

      <div className="agent-schedule__echo" aria-live="polite">
        {when && <p className="agent-schedule__echo-line">{routineEcho(when, note || '…')}</p>}
        <p
          className="agent-schedule__readback"
          data-invalid={reading.kind === 'bad' || error ? true : undefined}
        >
          {error ??
            (reading.kind === 'ok'
              ? `${firstRun(reading.preview)}${note.trim() ? '' : ` · now say what ${agent.name} should do`}`
              : reading.kind === 'bad'
                ? reading.reason
                : ' ')}
        </p>
      </div>

      <div className="agent-schedule__picker-actions">
        {onCancel && (
          <Button tabIndex={0} variant="ghost" size="compact" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button tabIndex={0} variant="primary" size="compact" disabled={!ready} onClick={save}>
          {editing ? 'Save' : 'Schedule'}
        </Button>
      </div>
    </div>
  );
}

function ScheduleRow({
  item,
  spent,
  priced,
  busy,
  editing,
  onRunNow,
  onEdit,
  onTogglePause,
  onCancel,
}: {
  item: CheckIn;
  /** "$0.84 at API prices this week" or "96k tokens this week", when it ran on its own this week. */
  spent: string | null;
  /** `spent` is a price (Claude Code's), not a token count. */
  priced: boolean;
  busy: boolean;
  editing: boolean;
  onRunNow: () => void;
  onEdit: () => void;
  onTogglePause: () => void;
  onCancel: () => void;
}) {
  const runs = item.runs ?? [];
  const [showRuns, setShowRuns] = useState(false);
  // A repeating routine on its schedule reads as two lines that each stay
  // whole: how often, then "Next: tomorrow at 9:00 AM".
  const plain = item.repeat && !item.paused && !item.retry;
  return (
    <li
      className="agent-schedule__item"
      data-paused={item.paused || undefined}
      data-editing={editing || undefined}
      data-history={showRuns || undefined}
    >
      <div className="agent-schedule__text">
        <span className="agent-schedule__note">{item.note}</span>
        {plain && item.repeat ? (
          <>
            <span className="agent-schedule__when">{describeRepeat(item.repeat)}</span>
            <span className="agent-schedule__when">Next: {formatWhenInline(item.nextAt)}</span>
          </>
        ) : (
          <span className="agent-schedule__when" data-retrying={item.retry ? '' : undefined}>
            {describeCheckInTime(item)}
          </span>
        )}
        {spent && (
          <span className="agent-schedule__spent" title={priced ? COST_BASIS_NOTE : undefined}>
            {spent}
          </span>
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
        <Tooltip content="Run now">
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<SkipNextIcon size={12} />}
            onClick={onRunNow}
            disabled={busy}
            aria-label={`Run “${item.note}” now`}
          />
        </Tooltip>
        <Tooltip content="Edit">
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<EditFieldIcon size={12} />}
            onClick={onEdit}
            disabled={busy}
            aria-label={`Edit “${item.note}”`}
          />
        </Tooltip>
        {item.repeat && (
          <Tooltip content={item.paused ? 'Resume' : 'Pause'}>
            <IconButton
              tabIndex={0}
              variant="ghost"
              size="compact"
              icon={item.paused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
              onClick={onTogglePause}
              disabled={busy}
              aria-label={item.paused ? `Resume “${item.note}”` : `Pause “${item.note}”`}
            />
          </Tooltip>
        )}
        <Tooltip content="Cancel this routine">
          <IconButton
            tabIndex={0}
            variant="ghost"
            size="compact"
            icon={<CloseIcon size={12} />}
            onClick={onCancel}
            disabled={busy}
            aria-label={`Cancel “${item.note}”`}
          />
        </Tooltip>
      </div>
      {showRuns && <RunHistory runs={runs} />}
    </li>
  );
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
