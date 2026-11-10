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
  describeEvery,
  updateWatch,
  type Agent,
  type CheckIn,
} from '../../lib/agents';
import { listAgentApps } from '../../lib/agentApps';
import { listConnections } from '../../lib/agentLogins';
import { refreshAgents } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAsyncState } from '../../hooks/useAsyncState';
// The composer's words and rules, shared with the phone's.
import {
  DEFAULT_WHEN_EVERY,
  everyAfterPick,
  shortEvery,
  whenApps,
  whenEcho,
  whenIntervalChoices,
  whenMissing,
  whenNoApps,
  whenReadback,
  whenSourceChoices,
  whenSourceOf,
  WHEN_WORDS,
  type WhenApp,
  type WhenKind,
} from '../../../packages/companion-protocol/src/whenComposer';

type Kind = WhenKind;

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
  const [every, setEvery] = useState(editing?.watch?.everyMinutes ?? DEFAULT_WHEN_EVERY);
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

  const choices = whenSourceChoices(hasLinear);
  const intervals = whenIntervalChoices(kind, every);
  const source = whenSourceOf(kind, folder.trim(), check.trim(), app);
  const missing = whenMissing(kind, folder, check, app);
  const detailMissing = missing !== null;

  const pick = (next: Kind) => {
    setKind(next);
    setError(null);
    setEvery(everyAfterPick(kind, next, every));
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

  // The echo, as the time picker's: what it waits for, then what it does.
  const echo = whenEcho(agent.name, source, note);

  return (
    <div className="agent-when">
      <div className="agent-schedule__field">
        <span className="agent-schedule__label" id="agent-when-source">
          {WHEN_WORDS.source}
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
            placeholder={WHEN_WORDS.folderPlaceholder}
            aria-label="Which folder"
            maxLength={500}
          />
        )}
        {kind === 'custom' && (
          <TextField
            value={check}
            onChange={(e) => setCheck(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={WHEN_WORDS.checkPlaceholder}
            aria-label="What to look out for"
            maxLength={400}
          />
        )}
        {kind === 'custom' &&
          (apps.length > 0 ? (
            <div className="agent-when__every">
              <span className="agent-when__every-label">{WHEN_WORDS.through}</span>
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
            <p className="agent-when__cost">{whenNoApps(agent.name)}</p>
          ))}
        <div className="agent-when__every">
          <span className="agent-when__every-label">{WHEN_WORDS.every}</span>
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
          {WHEN_WORDS.what}
        </label>
        <TextField
          id="agent-when-what"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={WHEN_WORDS.whatPlaceholder}
          aria-label="What to do when it happens"
          maxLength={600}
          invalid={error !== null}
        />
      </div>

      <div className="agent-schedule__echo" aria-live="polite">
        {!detailMissing && <p className="agent-schedule__echo-line">{echo}</p>}
        <p className="agent-schedule__readback" data-invalid={error ? true : undefined}>
          {error ?? missing ?? whenReadback(agent.name, source, every)}
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
