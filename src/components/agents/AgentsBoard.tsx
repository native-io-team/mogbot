/**
 * The team as a board of keys (docs/internal/agent-keys.md): every agent you
 * have, at full size on a plate, in the state it's in, with its name and a
 * line under it: the state's word in its colour (Live green, Needs your OK
 * amber, Working in ink, as on the site), then what it's on. Pressing one
 * opens its chat, as its bound key does from anywhere; the empty socket at
 * the end makes a new agent. An agent that joins while the board is up drops
 * into its socket (`seat`).
 *
 * @module components/agents/AgentsBoard
 */

import { useState } from 'react';
import {
  KEY_STATE_LABEL,
  keyAccessibleName,
  type KeyState,
} from '../../../packages/companion-protocol/src/agentKeys';
import { previewText } from '../../../packages/companion-protocol/src/preview';
import { workingRowLine } from '../../../packages/companion-protocol/src/work';
import { agentKeyState, plainActivity, type Agent } from '../../lib/agents';
import { AgentKey } from './AgentKey';

interface AgentsBoardProps {
  agents: Agent[];
  onOpenAgent: (agentId: string) => void;
  /** The empty socket: make a new agent. Absent, no socket. */
  onNewAgent?: () => void;
}

/** The words after the state: what it's on, or (idle) its last line. */
export function boardDetail(agent: Agent, state: KeyState): string | null {
  switch (state) {
    case 'working':
      return workingRowLine(
        plainActivity(agent.status.activity),
        agent.status.work,
        agent.status.since,
        Date.now()
      ).text;
    case 'live':
      return 'You’re driving it';
    case 'idle':
      return previewText(agent.preview);
    default:
      return null;
  }
}

/**
 * The agents that joined while the board was up (they drop into their
 * socket). Nothing seats on the first render, so opening the board is still.
 * State adjusted during render, React's pattern for deriving from the last
 * props.
 */
function useSeated(ids: string[]): ReadonlySet<string> {
  const key = ids.join(' ');
  const [seen, setSeen] = useState<{ key: string; seated: ReadonlySet<string> }>({
    key,
    seated: new Set(),
  });
  if (seen.key !== key) {
    const before = new Set(seen.key.split(' '));
    const seated = new Set(seen.seated);
    for (const id of ids) if (!before.has(id)) seated.add(id);
    setSeen({ key, seated });
    return seated;
  }
  return seen.seated;
}

export function AgentsBoard({ agents, onOpenAgent, onNewAgent }: AgentsBoardProps) {
  const shown = agents.filter((a) => !a.hidden);
  const seated = useSeated(shown.map((a) => a.id));
  return (
    <section className="agents-board" aria-label="Your team">
      <div className="agents-board__plate">
        {shown.map((agent) => {
          const state = agentKeyState(agent);
          // Idle says no word, only what it last said (the site's board).
          const word = state === 'idle' ? null : KEY_STATE_LABEL[state];
          let detail = boardDetail(agent, state);
          // "Working · Working on the pricing" says it twice: the word leads
          // the line instead ("Working on the pricing").
          const runOn = Boolean(word && detail?.startsWith(`${word} `));
          if (runOn && detail) detail = detail.slice(word!.length);
          return (
            <button
              key={agent.id}
              type="button"
              className="agents-board__key"
              onClick={() => onOpenAgent(agent.id)}
              aria-label={keyAccessibleName(agent.name, state)}
              data-agent-id={agent.id}
            >
              <AgentKey
                id={agent.id}
                name={agent.name}
                color={agent.color}
                state={state}
                size="xl"
                seat={seated.has(agent.id)}
              />
              <span className="agents-board__name">{agent.name}</span>
              <span className="agents-board__state" data-state={state}>
                {word && <b className="agents-board__word">{word}</b>}
                {word && detail && !runOn && <span className="agents-board__sep"> · </span>}
                {detail && <span className="agents-board__detail">{detail}</span>}
              </span>
            </button>
          );
        })}
        {onNewAgent && (
          <button
            type="button"
            className="agents-board__key"
            onClick={() => onNewAgent()}
            aria-label="New agent"
          >
            <AgentKey name="New agent" state="new" size="xl" />
            <span className="agents-board__name">New agent</span>
            <span className="agents-board__state">Empty socket</span>
          </button>
        )}
      </div>
    </section>
  );
}
