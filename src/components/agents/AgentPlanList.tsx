/**
 * The body of a "Do these under your name?" card (`ask_plan`,
 * `agents/plan_grant.rs`): every action the agent will take as the user,
 * numbered, each with where it happens, and why. The card around it is the
 * ordinary approval card: one Allow covers each listed action (for an hour,
 * and for any agent it hands the work to); Deny covers none of them.
 *
 * @module components/agents/AgentPlanList
 */

import type { PlanCard } from '../../../packages/companion-protocol/src/model';

export function AgentPlanList({ plan }: { plan: PlanCard }) {
  return (
    <div className="agent-plan">
      <ol className="agent-plan__actions">
        {plan.actions.map((a, i) => (
          <li key={`${i}-${a.summary}`} className="agent-plan__action">
            <span className="agent-plan__number" aria-hidden="true">{`${i + 1}.`}</span>
            <span className="agent-plan__summary">{a.summary}</span>
            <span className="agent-plan__target">{a.target}</span>
            {a.text && <span className="agent-plan__text">“{a.text}”</span>}
          </li>
        ))}
      </ol>
      {plan.why && <p className="agent-plan__why">Why: {plan.why}</p>}
    </div>
  );
}
