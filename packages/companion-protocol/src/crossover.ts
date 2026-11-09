/**
 * Carrying on with the other engine when every account of an agent's own
 * is out (`agents/crossover.rs`), worded once for the desk and the phone:
 * the team's choice per engine, the card that asks the first time, and the
 * account row's "Claude Code out · on Codex until 4:00 PM".
 *
 * Pure, and only what the Mac serves: the choice, and each agent's `away`
 * (which engine it carries on with, and when its own said it is back).
 */

import type { AgentEngine } from './model';
import { resetPhrase } from './quota';

/** Mirrors `crossover::Mode`. */
export type CrossoverMode = 'ask' | 'carry' | 'wait';

export const CROSSOVER_MODES: CrossoverMode[] = ['ask', 'carry', 'wait'];

/** Mirrors `crossover::Away`, on an agent. */
export interface CrossoverAway {
  /** The engine its turns run on meanwhile. */
  engine: AgentEngine;
  sessionId?: string;
  since: number;
  /** When its own engine said it is back. */
  until?: number;
  fresh?: boolean;
}

/** Mirrors `crossover::Ask`, on an approval card. */
export interface CrossoverAsk {
  from: AgentEngine;
  to: AgentEngine;
  until?: number;
  /** A yes runs the turn again there; false when part of it already ran. */
  resume: boolean;
}

/** Mirrors `crossover::View` (`agents_crossover`). */
export interface CrossoverView {
  claude: CrossoverMode;
  codex: CrossoverMode;
  away: { agentId: string; name: string; home: AgentEngine; on: AgentEngine; until?: number }[];
}

const LABEL: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

export const otherEngine = (e: AgentEngine): AgentEngine => (e === 'claude' ? 'codex' : 'claude');

/** The three answers, in the order the card shows them (the strong one last). */
export const CROSSOVER_WAIT = 'Wait';
export const CROSSOVER_ONCE = 'Just this time';
export const CROSSOVER_ALWAYS = 'Always';

/** "When every Claude Code account is out". */
export const crossoverHeading = (home: AgentEngine) => `When every ${LABEL[home]} account is out`;

/** The choice's options for one engine. */
export function crossoverOptions(home: AgentEngine): { value: CrossoverMode; label: string }[] {
  return [
    { value: 'ask', label: 'Ask first' },
    { value: 'carry', label: `Carry on with ${LABEL[otherEngine(home)]}` },
    { value: 'wait', label: 'Wait for the reset' },
  ];
}

/** One muted line under the choice. */
export function crossoverDetail(home: AgentEngine, mode: CrossoverMode): string {
  const from = LABEL[home];
  const to = LABEL[otherEngine(home)];
  switch (mode) {
    case 'ask':
      return `The first time it happens, one card asks whether to carry on with ${to}.`;
    case 'carry':
      return `Turns move to ${to} until ${from} has room again, then go back, with a line each way. Never for an agent set to one account.`;
    case 'wait':
      return `Agents stop on the usage-limit line until a ${from} account resets.`;
  }
}

/** The card's answered line. */
export function crossoverOutcome(
  ask: CrossoverAsk,
  status: 'allowed' | 'denied' | 'pending' | 'expired',
  choice?: string
): string | null {
  const to = LABEL[ask.to];
  const from = LABEL[ask.from];
  if (status === 'denied') return `Waiting · back when ${from} resets`;
  if (status !== 'allowed') return null;
  if (choice === CROSSOVER_ALWAYS) return `Always · carrying on with ${to} whenever ${from} is out`;
  return ask.resume
    ? `Just this time · carrying on with ${to}`
    : `Just this time · your next message runs on ${to}`;
}

/** The engine whose agents are away, and until when: the earliest reset said. */
export interface AwayState {
  home: AgentEngine;
  on: AgentEngine;
  until?: number;
  /** How many agents are carrying on there. */
  count: number;
}

export function awayStateOf(
  home: AgentEngine,
  agents: { engine: AgentEngine; away?: CrossoverAway | null }[],
  now = Date.now()
): AwayState | null {
  const away = agents.filter((a) => a.engine === home && a.away);
  if (away.length === 0) return null;
  const until = away
    .map((a) => a.away?.until)
    .filter((t): t is number => typeof t === 'number' && t > now)
    .sort((a, b) => a - b)[0];
  return { home, on: away[0].away!.engine, until, count: away.length };
}

/** "on Codex until 4:00 PM", "on Codex". */
export function awayRoom(state: AwayState, now = Date.now()): string {
  const to = LABEL[state.on];
  return state.until ? `on ${to} until ${resetPhrase(state.until, now)}` : `on ${to}`;
}

/** "Claude Code out · on Codex until 4:00 PM": the account row and Usage. */
export function awayLine(state: AwayState, now = Date.now()): string {
  return `${LABEL[state.home]} out · ${awayRoom(state, now)}`;
}
