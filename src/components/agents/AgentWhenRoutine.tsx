/**
 * "When…" routines in the schedule popover: work that starts when something
 * happens ("When someone mentions me on GitHub: triage it") rather than at
 * a time.
 *
 * The form is a short list of sources in plain words, the one detail a
 * source needs (a folder, or what to look out for), how often to check, and
 * what to do. Under it, what it costs, said before you add it: GitHub and
 * folders are checked for free; an app source (Linear, anything else) is a
 * short read-only Claude Code call per check, at least 15 minutes apart and
 * at most 24 a day, sealed to that one app (`watch_seal.rs`). It checks
 * through an app set up in Claude Code; a claude.ai connector can't be
 * loaded into the sealed check, so it isn't offered. Linear is offered only
 * when such a Linear app is there. Backend: `src-tauri/src/agents/watch.rs`.
 *
 * @module components/agents/AgentWhenRoutine
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button } from '../primitives/Button';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { TextField } from '../primitives/TextField';
import {
  createWatch,
  DEFAULT_MAX_CHECKS_PER_DAY,
  describeEvery,
  describeWatchSource,
  updateWatch,
  watchUsesModel,
  type Agent,
  type CheckIn,
  type WatchSource,
} from '../../lib/agents';
import { listAgentApps } from '../../lib/agentApps';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';

type Kind = Exclude<WatchSource['kind'], 'unknown'>;

interface SourceChoice {
  kind: Kind;
  label: string;
  /** How it's checked, and what that costs. */
  how: string;
}

const SOURCES: SourceChoice[] = [
  {
    kind: 'github_mentions',
    label: 'Someone mentions me on GitHub',
    how: 'Free · checked with the GitHub CLI',
  },
  {
    kind: 'github_assigned',
    label: 'An issue or PR is assigned to me',
    how: 'Free · checked with the GitHub CLI',
  },
  {
    kind: 'linear_assigned',
    label: 'A Linear issue is assigned to me',
    how: 'Through your Linear app · a short read-only Claude Code call per check',
  },
  { kind: 'new_file', label: 'A new file appears in a folder', how: 'Free · reads the folder' },
  {
    kind: 'custom',
    label: 'Something else…',
    how: 'You say what, in one app · a short read-only Claude Code call per check',
  },
];

/** How often each kind of source can be checked: a folder is free, a model check isn't. */
function intervalsFor(kind: Kind): number[] {
  if (kind === 'new_file') return [1, 5, 10, 30];
  if (kind === 'github_mentions' || kind === 'github_assigned') return [5, 10, 30, 60];
  return [15, 30, 60, 240];
}

export const DEFAULT_EVERY = 10;
/** An app check's default: each one is a Claude Code call. */
export const DEFAULT_MODEL_EVERY = 30;

const isModelKind = (kind: Kind) => kind === 'linear_assigned' || kind === 'custom';

/** "10 min", "1 hour": the interval chips, after "Check every". */
function shortEvery(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

function sourceOf(kind: Kind, folder: string, check: string, app: string): WatchSource {
  if (kind === 'new_file') return { kind, folder };
  if (kind === 'custom') return { kind, check, app };
  return { kind };
}

/** A Validation error's reason; anything else as the app words it. */
function reasonOf(err: unknown): string {
  const e = asCommandError(err);
  return e.type === 'Validation' ? e.reason : formatCommandError(e);
}

interface WhenComposerProps {
  agent: Agent;
  /** The "When…" routine being edited, or null to add one. */
  editing: CheckIn | null;
  /** Saved: back to the list. */
  onDone: () => void;
  /** Leave without saving; offered for a new routine only when there's somewhere to go back to. */
  onCancel?: () => void;
}

/** Add or edit a "When…" routine. Mounted fresh for each edit (keyed by the caller). */
export function WhenComposer({ agent, editing, onDone, onCancel }: WhenComposerProps) {
  const start = editing?.watch?.source;
  const startKind: Kind = start && start.kind !== 'unknown' ? start.kind : 'github_mentions';
  const [kind, setKind] = useState<Kind>(startKind);
  const [folder, setFolder] = useState(start?.kind === 'new_file' ? start.folder : '');
  const [check, setCheck] = useState(start?.kind === 'custom' ? start.check : '');
  const [app, setApp] = useState(start?.kind === 'custom' ? (start.app ?? '') : '');
  // Apps set up in Claude Code itself: a claude.ai connector can't be loaded
  // into the sealed check.
  const [apps, setApps] = useState<string[]>([]);
  const [every, setEvery] = useState(editing?.watch?.everyMinutes ?? DEFAULT_EVERY);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [hasLinear, setHasLinear] = useState(startKind === 'linear_assigned');

  // Linear is offered only when Claude Code has a Linear app of its own.
  useEffect(() => {
    let live = true;
    listAgentApps()
      .then((list) => {
        if (!live) return;
        const own = list.connected.filter((a) => a.source !== 'claudeAi');
        setApps(own.map((a) => a.name));
        if (own.some((a) => /linear/i.test(a.name) || /linear\.app/i.test(a.target))) {
          setHasLinear(true);
        }
      })
      .catch(() => {
        /* Not knowing isn't an error worth showing: Linear just isn't offered. */
      });
    return () => {
      live = false;
    };
  }, []);

  const choices = SOURCES.filter((s) => s.kind !== 'linear_assigned' || hasLinear);
  const offered = intervalsFor(kind);
  const intervals = offered.includes(every) ? offered : [...offered, every].sort((a, b) => a - b);
  const source = sourceOf(kind, folder.trim(), check.trim(), app);
  const appMissing = kind === 'custom' && !app;
  const detailMissing =
    (kind === 'new_file' && !folder.trim()) || (kind === 'custom' && !check.trim()) || appMissing;

  const pick = (next: Kind) => {
    setKind(next);
    setError(null);
    const allowed = intervalsFor(next);
    if (isModelKind(next) && !isModelKind(kind)) setEvery(DEFAULT_MODEL_EVERY);
    else if (every < allowed[0])
      setEvery(allowed.includes(DEFAULT_EVERY) ? DEFAULT_EVERY : allowed[0]);
  };

  const { execute: save, isLoading: saving } = useAsyncState(async () => {
    setError(null);
    try {
      if (editing) await updateWatch(agent.id, editing.id, source, every, note.trim());
      else await createWatch(agent.id, source, every, note.trim());
      await refreshAgents();
      onDone();
    } catch (err) {
      setError(reasonOf(err));
    }
  });
  const canSave = !saving && !detailMissing && note.trim().length > 0;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (canSave) void save();
  };

  const perDay = Math.min(Math.floor((24 * 60) / Math.max(every, 1)), DEFAULT_MAX_CHECKS_PER_DAY);
  const cost = watchUsesModel(source)
    ? `Each check is a short read-only Claude Code call on Haiku, up to ${perDay} a day, counted in ${agent.name}’s usage.`
    : 'Checks are free.';

  return (
    <div className="agent-when">
      <div className="agent-when__sources" role="radiogroup" aria-label="When this happens">
        {choices.map((s) => (
          <button
            key={s.kind}
            type="button"
            role="radio"
            aria-checked={kind === s.kind}
            className="agent-when__source"
            onClick={() => pick(s.kind)}
          >
            <span className="agent-when__source-label">{s.label}</span>
            <span className="agent-when__source-how">{s.how}</span>
          </button>
        ))}
      </div>

      {kind === 'new_file' && (
        <TextField
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Folder, e.g. ~/Downloads/invoices"
          aria-label="Which folder"
          maxLength={500}
        />
      )}
      {kind === 'custom' && (
        <TextField
          value={check}
          onChange={(e) => setCheck(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. a new email from dana@acme.com"
          aria-label="What to look out for"
          maxLength={400}
        />
      )}
      {kind === 'custom' &&
        (apps.length > 0 ? (
          <div className="agent-when__every">
            <span className="agent-when__every-label">Through</span>
            <SegmentedControl
              aria-label="Which app to check through"
              value={app}
              onValueChange={(v) => {
                setApp(v);
                setError(null);
              }}
              options={apps.map((name) => ({ value: name, label: name }))}
            />
          </div>
        ) : (
          <p className="agent-when__cost">
            Checks go through one app set up in Claude Code (Apps). claude.ai connectors can’t be
            used here.
          </p>
        ))}
      <TextField
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Then what? e.g. triage it and tell me if it’s urgent"
        aria-label="What to do when it happens"
        maxLength={600}
        invalid={error !== null}
      />

      <div className="agent-when__every">
        <span className="agent-when__every-label">Check every</span>
        <SegmentedControl
          aria-label="How often to check"
          value={String(every)}
          onValueChange={(v) => setEvery(Number(v))}
          options={intervals.map((m) => ({
            value: String(m),
            label: shortEvery(m),
            ariaLabel: describeEvery(m),
          }))}
        />
      </div>

      <p
        className="agent-schedule__readback"
        data-invalid={error ? true : undefined}
        aria-live="polite"
      >
        {error ??
          (detailMissing
            ? kind === 'new_file'
              ? 'Which folder?'
              : appMissing && check.trim()
                ? 'Which app should it check?'
                : 'What should it look out for?'
            : `When ${describeWatchSource(source)}, ${agent.name} gets a turn.`)}
      </p>
      <p className="agent-when__cost">
        {cost} The first check only notes what’s already there, so nothing old starts work.
      </p>

      <div className="agent-when__actions">
        {(editing || onCancel) && (
          <Button variant="ghost" size="compact" onClick={onCancel ?? onDone}>
            Cancel
          </Button>
        )}
        <Button variant="primary" size="compact" disabled={!canSave} onClick={() => void save()}>
          {editing ? 'Save' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
