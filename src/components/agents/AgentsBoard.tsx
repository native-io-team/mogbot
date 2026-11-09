/**
 * The team as a board of keys (docs/internal/agent-keys.md): every agent you
 * have, at full size on a plate, in the state it's in, with its name and the
 * state in words under it. Pressing one opens its chat, as its bound key
 * does from anywhere; the empty socket at the end makes a new agent.
 *
 * @module components/agents/AgentsBoard
 */

import { KEY_STATE_LABEL } from '../../../packages/companion-protocol/src/agentKeys';
import { agentKeyState, type Agent } from '../../lib/agents';
import { AgentKey } from './AgentKey';

interface AgentsBoardProps {
  agents: Agent[];
  onOpenAgent: (agentId: string) => void;
  /** The empty socket: make a new agent. Absent, no socket. */
  onNewAgent?: () => void;
}

export function AgentsBoard({ agents, onOpenAgent, onNewAgent }: AgentsBoardProps) {
  const shown = agents.filter((a) => !a.hidden);
  return (
    <section className="agents-board" aria-label="Your team">
      <div className="agents-board__plate">
        {shown.map((agent) => {
          const state = agentKeyState(agent);
          return (
            <button
              key={agent.id}
              type="button"
              className="agents-board__key"
              onClick={() => onOpenAgent(agent.id)}
              aria-label={`${agent.name}, ${KEY_STATE_LABEL[state]}`}
              data-agent-id={agent.id}
            >
              <AgentKey
                id={agent.id}
                name={agent.name}
                color={agent.color}
                state={state}
                size="xl"
              />
              <span className="agents-board__name">{agent.name}</span>
              <span className="agents-board__state" data-state={state}>
                {KEY_STATE_LABEL[state]}
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
            <span className="agents-board__state">Add one</span>
          </button>
        )}
      </div>
    </section>
  );
}
