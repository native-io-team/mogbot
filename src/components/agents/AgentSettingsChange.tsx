/**
 * The body of a "Change … settings?" card (`propose_settings_change`,
 * `agents/policy_card.rs`): each set of agents changed the same way, and how,
 * in plain sentences; why the agent proposed it; and, when it adds a rule,
 * that a rule is words rather than something the app stops. A change to how
 * an agent looks shows the agent as it would look, beside its name. The card
 * around it is the ordinary approval card: Allow applies it, Deny applies
 * nothing.
 *
 * @module components/agents/AgentSettingsChange
 */

import { RULES_NOTE, type SettingsProposal } from '../../lib/agentPolicy';
import {
  isAvatarFace,
  isAvatarShape,
  lookFor,
} from '../../../packages/companion-protocol/src/avatar';
import { agentIn, useAgentsList } from '../../lib/agentsStore';
import { AgentAvatar } from './AgentAvatar';

export function AgentSettingsChange({ proposal }: { proposal: SettingsProposal }) {
  const agents = useAgentsList();
  const look = proposal.look;
  return (
    <div className="agent-settings-change">
      {proposal.groups.map((g) => {
        // One agent whose look changes: show it as it would be.
        const agent = look && g.agentIds?.length === 1 ? agentIn(agents, g.agentIds[0]) : undefined;
        const now = agent && lookFor(agent);
        return (
          <section key={g.who} className="agent-settings-change__group" aria-label={g.who}>
            <span className="agent-settings-change__who">
              {look && agent && now && (
                <AgentAvatar
                  id={agent.id}
                  name={agent.name}
                  color={look.color ?? agent.color}
                  look={{
                    shape: isAvatarShape(look.shape) ? look.shape : now.shape,
                    face: isAvatarFace(look.face) ? look.face : now.face,
                  }}
                  size="md"
                />
              )}
              {g.who}
            </span>
            <ul className="agent-settings-change__lines">
              {g.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        );
      })}
      {proposal.why && <p className="agent-settings-change__why">Why: {proposal.why}</p>}
      {proposal.hasRules && <p className="agent-settings-change__note">{RULES_NOTE}</p>}
    </div>
  );
}
