/**
 * What an agent runs on, in the two places it shows: the editor's "Runs on"
 * field and a small badge beside its name in the list.
 *
 * Every engine Agents knows about is listed in the field, so Codex is
 * discoverable before it's set up; one that isn't installed or signed in is
 * disabled, with the reason and the way to fix it underneath. The
 * protections line says what that engine actually enforces, no more
 * (`engineProtections`).
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

interface AgentEngineFieldProps {
  engines: EngineInfo[];
  value: AgentEngine;
  /** The engine the agent is on now (editing); it stays selectable whatever its state. */
  current?: AgentEngine;
  onChange: (engine: AgentEngine) => void;
  /** Install or sign in to an engine (the same terminal the chat's "Set up" opens). */
  onSetUp?: (engine: AgentEngine, step: 'install' | 'sign-in') => void;
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
  if (engines.length < 2) return null;
  const blocked = engines.flatMap((info) => {
    const need = engineUnavailable(info);
    return need && info.id !== current && info.id !== value ? [{ info, need }] : [];
  });
  const selected = engines.find((e) => e.id === value);
  return (
    <div className="agent-editor__label" role="group" aria-label="Runs on">
      Runs on
      <SegmentedControl
        value={value}
        options={engines.map((info) => {
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
      <p className="agent-editor__hint" data-testid="agent-engine-protections">
        {engineProtections(value, selected)}
      </p>
      {blocked.map(({ info, need }) => (
        <p key={info.id} className="agent-editor__hint">
          {reason(info, need)}{' '}
          {onSetUp && (
            <TextButton tabIndex={0} onClick={() => onSetUp(info.id, need)}>
              {need === 'install' ? `Set up ${info.label}` : `Sign in to ${info.label}`}
            </TextButton>
          )}
        </p>
      ))}
    </div>
  );
}

function reason(info: EngineInfo, need: 'install' | 'sign-in'): string {
  return need === 'install'
    ? `${info.label} isn't installed on this Mac.`
    : `${info.label} isn't signed in.`;
}
