/**
 * How much the user's agents do on their own (`agents::independence`),
 * worded once for onboarding, Settings → Agents and the phone: a four-stop
 * slider from "Careful" to "Unleashed", one line for the chosen stop, and one
 * line under it that is true at every stop.
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

/**
 * The slider's title, its two ends and its four stops. The stored ids stay
 * `often` / `judgement` / `go_hard` / `full_send` (older Macs, saved files);
 * only these words are shown. Each line is checked against what the level
 * really answers (`agents::autoallow`, `agents::go_hard`).
 */
export const INDEPENDENCE_TITLE = 'How much it does on its own';

export const INDEPENDENCE_ENDS = { low: 'Asks a lot', high: 'Just does it' } as const;

export const INDEPENDENCE_LABEL: Record<AgentIndependence, string> = {
  often: 'Careful',
  judgement: 'Steady',
  go_hard: 'Bold',
  full_send: 'Unleashed',
};

/** One line each, what it does and what it asks for: shown for the chosen stop. */
export const INDEPENDENCE_DETAIL: Record<AgentIndependence, string> = {
  often: 'Reads and looks around; asks before bigger changes.',
  judgement: 'Reads and edits; asks before running changes or anything leaving this Mac.',
  go_hard: 'Does local work on this Mac; asks before anything leaves it.',
  full_send:
    'Sends, posts and pushes too; only stops for money, logins, deleting for good or going live.',
};

/** Always under the slider: true at every stop. */
export const INDEPENDENCE_ALWAYS_ASKS =
  'Always asks before spending money, using your passwords, or deleting for good.';

/** What still asks at each level: the same line at every stop. */
export const INDEPENDENCE_STILL_ASKS: Record<AgentIndependence, string> = {
  often: INDEPENDENCE_ALWAYS_ASKS,
  judgement: INDEPENDENCE_ALWAYS_ASKS,
  go_hard: INDEPENDENCE_ALWAYS_ASKS,
  full_send: INDEPENDENCE_ALWAYS_ASKS,
};

/** The stop `delta` steps from `level`, held at the ends (a slider doesn't wrap). */
export function independenceStep(level: AgentIndependence, delta: number): AgentIndependence {
  const i = Math.max(0, INDEPENDENCE_LEVELS.indexOf(level));
  const next = Math.min(INDEPENDENCE_LEVELS.length - 1, Math.max(0, i + delta));
  return INDEPENDENCE_LEVELS[next];
}

/** What a screen reader says for a stop: its name, then its line. */
export function independenceValueText(level: AgentIndependence): string {
  return `${INDEPENDENCE_LABEL[level]}. ${INDEPENDENCE_DETAIL[level]}`;
}

/** A level from a Mac, or the default when it sends none (an older Mac). */
export function independenceOf(level: AgentIndependence | null | undefined): AgentIndependence {
  return level && INDEPENDENCE_LEVELS.includes(level) ? level : DEFAULT_INDEPENDENCE;
}

/* ------------------------------------------------- one agent's own level */

/** The level in a word, for a picker's "Same as team (Bold)". */
export const INDEPENDENCE_SHORT: Record<AgentIndependence, string> = INDEPENDENCE_LABEL;

/** The tiny label on an agent's row when its level differs from the team's. */
export const INDEPENDENCE_ROW_LABEL: Record<AgentIndependence, string> = INDEPENDENCE_LABEL;

/** The heading over one agent's level: the slider's own title. */
export const AGENT_INDEPENDENCE_TITLE = INDEPENDENCE_TITLE;

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
