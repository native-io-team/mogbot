/**
 * The body of a "Change … settings?" card (`propose_settings_change`,
 * `agents/policy_card.rs`): each set of agents changed the same way, and how,
 * in plain sentences; why the agent proposed it; and, when it adds a rule,
 * that a rule is words rather than something the app stops. The card around
 * it is the ordinary approval card: Allow applies it, Deny applies nothing.
 *
 * @module components/agents/AgentSettingsChange
 */

import { RULES_NOTE, type SettingsProposal } from '../../lib/agentPolicy';

export function AgentSettingsChange({ proposal }: { proposal: SettingsProposal }) {
  return (
    <div className="agent-settings-change">
      {proposal.groups.map((g) => (
        <section key={g.who} className="agent-settings-change__group" aria-label={g.who}>
          <span className="agent-settings-change__who">{g.who}</span>
          <ul className="agent-settings-change__lines">
            {g.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      ))}
      {proposal.why && <p className="agent-settings-change__why">Why: {proposal.why}</p>}
      {proposal.hasRules && <p className="agent-settings-change__note">{RULES_NOTE}</p>}
    </div>
  );
}
