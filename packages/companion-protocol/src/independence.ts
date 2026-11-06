/**
 * How much the user's agents do on their own (`agents::independence`),
 * worded once for onboarding, Settings → Agents and the phone. One line each,
 * and one honest line for the chosen level about what still asks.
 */

import type { AgentIndependence } from './model';

/** Strictest first, as they're offered. */
export const INDEPENDENCE_LEVELS: readonly AgentIndependence[] = [
  'often',
  'judgement',
  'go_hard',
  'full_send',
];

/** What a Mac that never had one chosen (or sends none) runs at. */
export const DEFAULT_INDEPENDENCE: AgentIndependence = 'judgement';

export const INDEPENDENCE_QUESTION = 'How much should your agents do on their own?';

export const INDEPENDENCE_LABEL: Record<AgentIndependence, string> = {
  often: 'Check with me often',
  judgement: 'Use good judgement',
  go_hard: 'Go hard — get it done',
  full_send: 'Full send — let it rip',
};

/** One line each, what it changes. */
export const INDEPENDENCE_DETAIL: Record<AgentIndependence, string> = {
  often: 'They share a plan and wait for your go-ahead before bigger changes.',
  judgement: 'They finish the job and ask only when a choice is really yours.',
  go_hard: 'They try every way they have before asking you to do anything.',
  full_send: 'They post, send and publish what you asked for, then tell you.',
};

/** True below "Full send": the choice never changes what asks. */
export const INDEPENDENCE_ALWAYS_ASKS =
  'You’ll always be asked before anything that spends money, sends as you, or deletes.';

/** What still asks at each level: one honest line, shown under the choice. */
export const INDEPENDENCE_STILL_ASKS: Record<AgentIndependence, string> = {
  often: INDEPENDENCE_ALWAYS_ASKS,
  judgement: INDEPENDENCE_ALWAYS_ASKS,
  go_hard: INDEPENDENCE_ALWAYS_ASKS,
  full_send:
    'Still asks before spending money, passwords or keys, deleting things for good, pushing to main or production, or changing how your Mac starts.',
};

/** A level from a Mac, or the default when it sends none (an older Mac). */
export function independenceOf(level: AgentIndependence | null | undefined): AgentIndependence {
  return level && INDEPENDENCE_LEVELS.includes(level) ? level : DEFAULT_INDEPENDENCE;
}

/* ------------------------------------------------- one agent's own level */

/** The level in a few words, for a picker's "Same as team (Go hard)". */
export const INDEPENDENCE_SHORT: Record<AgentIndependence, string> = {
  often: 'Check with me often',
  judgement: 'Use good judgement',
  go_hard: 'Go hard',
  full_send: 'Full send',
};

/** The tiny label on an agent's row when its level differs from the team's. */
export const INDEPENDENCE_ROW_LABEL: Record<AgentIndependence, string> = {
  often: 'Checks often',
  judgement: 'Good judgement',
  go_hard: 'Go hard',
  full_send: 'Full send',
};

/** The heading over one agent's level picker. */
export const AGENT_INDEPENDENCE_TITLE = 'How much it does on its own';

/** The picker's first option: follow the team, naming the team's level. */
export function sameAsTeamLabel(team: AgentIndependence | null | undefined): string {
  return `Same as team (${INDEPENDENCE_SHORT[independenceOf(team)]})`;
}

/** What an agent runs at: its own level, or the team's. */
export function effectiveIndependence(
  agent: { independence?: AgentIndependence | null },
  team: AgentIndependence | null | undefined
): AgentIndependence {
  return agent.independence ?? independenceOf(team);
}

/** The row's label, only when the agent's own level differs from the team's. */
export function independenceRowLabel(
  agent: { independence?: AgentIndependence | null },
  team: AgentIndependence | null | undefined
): string | null {
  const own = agent.independence;
  if (!own || own === independenceOf(team)) return null;
  return INDEPENDENCE_ROW_LABEL[own];
}

/** How many agents have a level of their own. */
export function ownIndependenceCount(
  agents: readonly { independence?: AgentIndependence | null }[]
): number {
  return agents.filter((a) => !!a.independence).length;
}

/** Under the team's picker, when any agent has its own level. */
export const ownIndependenceLine = (n: number) => `Agents set on their own: ${n}`;
