/**
 * "When…" routines in the schedule popover: work that starts when something
 * happens ("When someone mentions me on GitHub: triage it") rather than at
 * a time.
 *
 * The form is a short list of sources in plain words, the one detail a
 * source needs (a folder, or what to look out for), how often to check, and
 * what to do. Under it, what it costs, said before you add it: GitHub and
 * folders are checked for free; an app source (Linear, anything else) is a
 * short read-only model call per check (Claude Code, or Codex for an app
 * connected under Apps), at least 15 minutes apart and
 * at most 24 a day, sealed to that one app (`watch_seal.rs`). It checks
 * through an app connected under Apps and given to this agent (ours,
 * preferred, reached through the relay), else one set up in Claude Code
 * itself; a claude.ai connector can't be loaded into the sealed check, so it
 * isn't offered. Linear is offered only when such a Linear app is there.
 * Backend: `src-tauri/src/agents/watch.rs`.
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
import { appTitle, listAgentApps, type AgentApp } from '../../lib/agentApps';
import { listConnections, type Connection } from '../../lib/agentLogins';
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
    // "you", as the routine reads back once added ("When someone mentions you…").
    label: 'Someone mentions you on GitHub',
    how: 'Free · checked from this Mac',
  },
  {
    kind: 'github_assigned',
    label: 'An issue or PR is assigned to you',
    how: 'Free · checked from this Mac',
  },
  {
    kind: 'linear_assigned',
    label: 'A Linear issue is assigned to you',
    how: 'Through your Linear app · uses a little of your usage each check',
  },
  { kind: 'new_file', label: 'A new file appears in a folder', how: 'Free · reads the folder' },
  {
    kind: 'custom',
    label: 'Something else…',
    how: 'You say what, in one app · uses a little of your usage each check',
  },
];

/** How often each kind of source can be checked: a folder is free, a model check isn't. */
function intervalsFor(kind: Kind): number[] {
  if (kind === 'new_file') return [1, 5, 10, 30];
  if (kind === 'github_mentions' || kind === 'github_assigned') return [5, 10, 30, 60];
  return [15, 30, 60, 240];
}

export const DEFAULT_EVERY = 10;
/** An app check's default: each one is a model call. */
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

/** An app a check can read through: `value` is what the routine saves as `app`. */
export interface WhenApp {
  value: string;
  label: string;
}

/**
 * The apps `agentId`'s check can read through, ours first: our own
 * connections given to this agent and signed in (by server key, the name its
 * tools carry), then servers set up in Claude Code itself. A claude.ai
 * connector can't be loaded into the sealed check. `linear`: whether either
 * has Linear.
 */
export function whenApps(
  agentId: string,
  connections: Connection[],
  claude: AgentApp[]
): { apps: WhenApp[]; linear: boolean } {
  const ours = connections.filter(
    (c) => c.kind.type === 'oauth' && !c.needsSignIn && c.grants.some((g) => g.agentId === agentId)
  );
  const title = (c: Connection) =>
    ours.filter((o) => o.title === c.title).length > 1 ? `${c.title} (${c.account})` : c.title;
  const theirs = claude.filter(
    (a) => a.source !== 'claudeAi' && !ours.some((c) => c.serverKey === a.name)
  );
  return {
    apps: [
      ...ours.map((c) => ({ value: c.serverKey, label: title(c) })),
      ...theirs.map((a) => ({ value: a.name, label: appTitle(a) })),
    ],
    linear:
      ours.some((c) => c.service === 'linear') ||
      theirs.some((a) => /linear/i.test(a.name) || /linear\.app/i.test(a.target)),
  };
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
  // Apps connected under Apps for this agent, then Claude Code's own: a
  // claude.ai connector can't be loaded into the sealed check.
  const [apps, setApps] = useState<WhenApp[]>([]);
  const [every, setEvery] = useState(editing?.watch?.everyMinutes ?? DEFAULT_EVERY);
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [hasLinear, setHasLinear] = useState(startKind === 'linear_assigned');

  // Linear is offered only when this agent can read a Linear app: ours, or
  // Claude Code's own. Either list failing just leaves its apps out.
  useEffect(() => {
    let live = true;
    void Promise.allSettled([listConnections(), listAgentApps()]).then(([ours, theirs]) => {
      if (!live) return;
      const found = whenApps(
        agent.id,
        ours.status === 'fulfilled' ? (ours.value ?? []) : [],
        theirs.status === 'fulfilled' ? (theirs.value?.connected ?? []) : []
      );
      setApps(found.apps);
      if (found.linear) setHasLinear(true);
    });
    return () => {
      live = false;
    };
  }, [agent.id]);

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
    ? `Each check uses a little of ${agent.name}’s usage and can only read that app, up to ${perDay} a day.`
    : 'Checks are free.';

  // The echo, as the time picker's: what it waits for, then what it does.
  // A check in the user's own words is quoted, so it reads whatever they typed.
  const waitsFor =
    source.kind === 'custom'
      ? `When ${agent.name} finds “${describeWatchSource(source)}”`
      : `When ${describeWatchSource(source)}`;
  const echo = note.trim() ? `${waitsFor} — ${note.trim().replace(/\s+/g, ' ')}` : waitsFor;

  return (
    <div className="agent-when">
      <div className="agent-schedule__field">
        <span className="agent-schedule__label" id="agent-when-source">
          When this happens
        </span>
        <div className="agent-when__sources" role="radiogroup" aria-labelledby="agent-when-source">
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
            placeholder="What to look for, e.g. a new email from dana@acme.com"
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
                options={apps}
              />
            </div>
          ) : (
            <p className="agent-when__cost">
              It checks through an app connected under Apps and given to {agent.name}. Apps
              connected on claude.ai can’t be used here.
            </p>
          ))}
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
      </div>

      <div className="agent-schedule__field">
        <label className="agent-schedule__label" htmlFor="agent-when-what">
          What
        </label>
        <TextField
          id="agent-when-what"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Triage it and tell me if it’s urgent"
          aria-label="What to do when it happens"
          maxLength={600}
          invalid={error !== null}
        />
      </div>

      <div className="agent-schedule__echo" aria-live="polite">
        {!detailMissing && <p className="agent-schedule__echo-line">{echo}</p>}
        <p className="agent-schedule__readback" data-invalid={error ? true : undefined}>
          {error ??
            (detailMissing
              ? kind === 'new_file'
                ? 'Which folder?'
                : appMissing && check.trim()
                  ? 'Which app should it check?'
                  : 'What should it look out for?'
              : `${cost} The first check only notes what’s already there, so nothing old starts work.`)}
        </p>
      </div>

      <div className="agent-when__actions">
        {(editing || onCancel) && (
          <Button variant="ghost" size="compact" onClick={onCancel ?? onDone}>
            Cancel
          </Button>
        )}
        <Button variant="strong" size="compact" disabled={!canSave} onClick={() => void save()}>
          {editing ? 'Save' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
