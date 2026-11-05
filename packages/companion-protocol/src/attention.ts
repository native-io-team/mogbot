/**
 * Who needs you, counted once. Every number that says so uses this: the
 * desk's "Needs your OK · N" row and the review bar in the Chief's chat, the
 * phone's Home bar ("N agents need you"), its Agents tab badge and its quick
 * action, and the Dock badge (`agents/notify.rs`, which mirrors this rule and
 * is held to the same cases, `attention-cases.json`). Two of them once said
 * 13 and 14 for the same moment, because one left the Chief out.
 *
 * An agent needs you when it isn't hidden and it has a request open, or its
 * last turn failed in a way only you can fix. The Chief counts like anyone.
 * A usage limit isn't one: it resets by itself and stays quiet.
 *
 * While "Setting up your team" is open (not complete, not put away) what it
 * holds is its own, counted there once: the logins it lists, and the
 * imported agents you haven't said hi to yet ("quiet").
 *
 * Only what the registry says, never what a chat happens to have loaded, so
 * every surface agrees whichever chats it has read.
 *
 * @module companion-protocol/attention
 */

import type { Agent, TeamSetupView } from './model';

/** What the rule reads of an agent: the registry row, desk or phone. */
export type AttentionAgent = Pick<Agent, 'id' | 'hidden' | 'pendingApprovals' | 'failure'> & {
  status: Pick<Agent['status'], 'state'>;
};

/** What the rule reads of the checklist. */
export type AttentionSetup = Pick<TeamSetupView, 'steps' | 'complete'> & { dismissed?: boolean };

/** What the checklist holds: logins per agent, and agents not met yet. */
export interface SetupHold {
  held: ReadonlyMap<string, number>;
  quiet: ReadonlySet<string>;
}

/** Nothing held: no checklist, or one that's done or put away. */
export const NO_HOLD: SetupHold = { held: new Map(), quiet: new Set() };

export function setupHold(view: AttentionSetup | null | undefined): SetupHold {
  if (!view || view.complete || view.dismissed) return NO_HOLD;
  const held = new Map<string, number>();
  const quiet = new Set<string>();
  for (const step of view.steps) {
    for (const login of step.logins ?? []) {
      held.set(login.agentId, (held.get(login.agentId) ?? 0) + 1);
    }
    for (const hello of step.agents ?? []) {
      if (hello.state === 'quiet') quiet.add(hello.agentId);
    }
  }
  return { held, quiet };
}

/** Whether one agent needs you, less what the checklist holds. */
export function agentNeedsYou(agent: AttentionAgent, hold: SetupHold = NO_HOLD): boolean {
  if (agent.hidden || hold.quiet.has(agent.id)) return false;
  const failed =
    agent.status.state === 'idle' && agent.failure != null && agent.failure.kind !== 'usage_limit';
  if (failed) return true;
  const pending = agent.pendingApprovals ?? 0;
  if (pending > (hold.held.get(agent.id) ?? 0)) return true;
  // Mid-turn on a card the registry hasn't counted yet. (On one the
  // checklist holds, it's the checklist's.)
  return agent.status.state === 'waiting' && pending === 0;
}

/** The agents that need you, in the order given. */
export function agentsNeedingYou<A extends AttentionAgent>(
  agents: readonly A[],
  setup?: AttentionSetup | null
): A[] {
  const hold = setupHold(setup);
  return agents.filter((a) => agentNeedsYou(a, hold));
}

/** How many agents need you: the one number every surface shows. */
export function needsYouCount(
  agents: readonly AttentionAgent[],
  setup?: AttentionSetup | null
): number {
  return agentsNeedingYou(agents, setup).length;
}
