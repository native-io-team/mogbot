/**
 * Home's order, calm: the Chief of Staff first, always; then one bar for
 * whatever waits on you (never a section listing every agent); then pinned
 * agents; then the rest, what needs you before what doesn't, most recent
 * first. Agents still being set up after an import are quiet: their logins
 * and hellos are the setup checklist's, in the Chief's chat, as on the desk.
 */

import type { Agent, TeamSetupView } from '@shipstudio/companion-protocol';
import { needsAttention } from './agents';
import { shows } from './teamSetup';

export type HomeBar =
  /** Only setup is waiting: "A few things to finish setting up your team" → the Chief's chat. */
  | { kind: 'setup' }
  /** "N agents need you" → the grouped sheet (which also points at setup when it's open). */
  | { kind: 'needs'; agents: Agent[]; setup: boolean };

export interface Home {
  chief: Agent | null;
  bar: HomeBar | null;
  pinned: Agent[];
  rest: Agent[];
  hidden: Agent[];
  /** Agents being set up: their rows say so quietly. */
  quiet: Set<string>;
}

/**
 * Agents the checklist covers that haven't been met yet (the desk's
 * `quietAgentIds`): their requests and failures are the checklist's.
 */
export function quietAgentIds(v: TeamSetupView | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!shows(v) || v.complete) return ids;
  for (const a of v.steps.find((s) => s.id === 'hello')?.agents ?? []) {
    if (a.state === 'quiet') ids.add(a.agentId);
  }
  return ids;
}

const recent = (a: Agent, b: Agent) => b.lastActivityAt - a.lastActivityAt;

export function buildHome(agents: Agent[], setup: TeamSetupView | null | undefined): Home {
  const quiet = quietAgentIds(setup);
  const setupOpen = shows(setup) && !setup.complete;
  const visible = agents.filter((a) => !a.hidden);
  const hidden = agents.filter((a) => a.hidden).sort(recent);
  const chief = visible.find((a) => a.isMain) ?? null;
  const others = visible.filter((a) => a !== chief);
  const loud = (a: Agent) => needsAttention(a) && !quiet.has(a.id);
  const waiting = others.filter(loud).sort(recent);
  const pinned = others.filter((a) => a.pinned).sort(recent);
  const rest = others
    .filter((a) => !a.pinned)
    .sort((a, b) => Number(loud(b)) - Number(loud(a)) || recent(a, b));
  const bar: HomeBar | null = waiting.length
    ? { kind: 'needs', agents: waiting, setup: setupOpen }
    : setupOpen
      ? { kind: 'setup' }
      : null;
  return { chief, bar, pinned, rest, hidden, quiet };
}

/** The bar's two lines. */
export function barWords(bar: HomeBar, chiefName: string, progress?: string): [string, string] {
  if (bar.kind === 'setup') {
    return [
      'A few things to finish setting up your team',
      `${progress ? `${progress} · ` : ''}in ${chiefName}’s chat`,
    ];
  }
  const n = bar.agents.length;
  const title = n === 1 ? `${bar.agents[0].name} needs you` : `${n} agents need you`;
  const more = n > 2 ? ` and ${n - 2} more` : '';
  const who =
    n === 1
      ? 'Open to see what for'
      : `${bar.agents
          .slice(0, 2)
          .map((a) => a.name)
          .join(', ')}${more}`;
  return [title, bar.setup ? `${who} · and setting up your team` : who];
}
