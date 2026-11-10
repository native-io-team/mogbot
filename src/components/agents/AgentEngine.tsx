/**
 * What an agent runs on, in the places it shows: the editor's "Runs on"
 * field, a quiet "Also use Codex" link for an engine that isn't set up, and
 * a small badge beside its name in the list.
 *
 * The picker only appears once two engines are installed: most people have
 * one, and a choice between one thing and a greyed-out other is noise. One
 * that's installed but not signed in is disabled, with the reason and the way
 * to fix it underneath. What the engine itself holds to under the agent's
 * independence (`engineProtections`) is the engine's own detail, under
 * Advanced (`AgentEngineProtections`), never beside the choice or the level,
 * where it read as a second answer to "what does it do on its own", and
 * never on the New agent review, where nobody can act on it.
 *
 * @module components/agents/AgentEngine
 */

import { SegmentedControl } from '../primitives/SegmentedControl';
import { TextButton } from '../primitives/TextButton';
import {
  ENGINE_LABEL,
  engineProtections,
  engineUnavailable,
  type AgentEngine,
  type EngineInfo,
} from '../../lib/agents';

/** The default engine wears no badge: only an agent on another one is marked. */
export function AgentEngineBadge({ engine }: { engine: AgentEngine }) {
  if (engine === 'claude') return null;
  return (
    <span className="agent-engine-badge" title={`Runs on ${ENGINE_LABEL[engine]}`}>
      {ENGINE_LABEL[engine]}
    </span>
  );
}

type SetUp = (engine: AgentEngine, step: 'install' | 'sign-in') => void;

/** The engines worth offering: installed ones, plus whatever is chosen now. */
function offered(engines: EngineInfo[], value: AgentEngine, current?: AgentEngine) {
  return engines.filter((e) => e.installed || e.id === value || e.id === current);
}

/** Whether the editor shows a "Runs on" choice at all. */
export function showsEnginePicker(engines: EngineInfo[]): boolean {
  return engines.filter((e) => e.installed).length >= 2;
}

interface AgentEngineFieldProps {
  engines: EngineInfo[];
  value: AgentEngine;
  /** The engine the agent is on now (editing); it stays selectable whatever its state. */
  current?: AgentEngine;
  onChange: (engine: AgentEngine) => void;
  /** Install or sign in to an engine (the same terminal the chat's "Set up" opens). */
  onSetUp?: SetUp;
  /** A line about the choice itself (switching an agent over). */
  note?: string | false;
}

export function AgentEngineField({
  engines,
  value,
  current,
  onChange,
  onSetUp,
  note,
}: AgentEngineFieldProps) {
  // Before the overview arrives there is nothing true to show.
  if (engines.length === 0) return null;
  const shown = offered(engines, value, current);
  const blocked = shown.flatMap((info) => {
    const need = engineUnavailable(info);
    return need ? [{ info, need }] : [];
  });
  const reasons = blocked.map(({ info, need }) => (
    <p key={info.id} className="agent-editor__hint">
      {reason(info, need)}{' '}
      {onSetUp && (
        <TextButton tabIndex={0} onClick={() => onSetUp(info.id, need)}>
          {need === 'install' ? `Set up ${info.label}` : `Sign in to ${info.label}`}
        </TextButton>
      )}
    </p>
  ));

  if (!showsEnginePicker(engines)) {
    // One engine: nothing to choose, so say only what's wrong with it, if anything.
    const own = reasons.filter((r) => r.key === value);
    return own.length ? <>{own}</> : null;
  }

  return (
    <div className="agent-editor__label" role="group" aria-label="Runs on">
      Runs on
      <SegmentedControl
        value={value}
        options={shown.map((info) => {
          const need = info.id === current ? null : engineUnavailable(info);
          return {
            value: info.id,
            label: info.label,
            disabled: Boolean(need),
            title: need ? reason(info, need) : undefined,
          };
        })}
        onValueChange={onChange}
        aria-label="Runs on"
      />
      {note && <p className="agent-editor__hint">{note}</p>}
      {reasons}
    </div>
  );
}

/** Under Advanced: what the engine holds to under the agent's independence, in plain words. */
export function AgentEngineProtections({
  engines,
  value,
}: {
  engines: EngineInfo[];
  value: AgentEngine;
}) {
  const selected = engines.find((e) => e.id === value);
  if (!selected?.installed) return null;
  return (
    <p className="agent-editor__hint" data-testid="agent-engine-protections">
      {engineProtections(value, selected)}
    </p>
  );
}

/** The quiet half, low in the editor: with one engine, a link to set up another. */
export function AgentEngineMore({
  engines,
  value,
  onSetUp,
}: {
  engines: EngineInfo[];
  value: AgentEngine;
  onSetUp?: SetUp;
}) {
  if (engines.length === 0) return null;
  const missing = showsEnginePicker(engines)
    ? []
    : engines.filter((e) => !e.installed && e.id !== value);
  return (
    <>
      {onSetUp &&
        missing.map((info) => (
          <TextButton
            key={info.id}
            tabIndex={0}
            className="agent-editor__more"
            onClick={() => onSetUp(info.id, 'install')}
          >
            Also use {info.label}
          </TextButton>
        ))}
    </>
  );
}

function reason(info: EngineInfo, need: 'install' | 'sign-in'): string {
  return need === 'install' ? `${info.label} isn't set up yet.` : `${info.label} isn't signed in.`;
}
