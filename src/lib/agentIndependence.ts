/**
 * How much agents do on their own (`agents::independence`): one choice for
 * the whole team, asked in onboarding and kept in Settings → Agents, ⌘K and
 * on the phone. Each agent may have its own level instead (`agents/policy.rs`),
 * set from its editor, the phone's agent sheet or by asking the Chief.
 * Worded once for the desk and the phone by the companion protocol's
 * `independence.ts`.
 *
 * It changes what agents are told on their next turn and which cards are
 * answered for the user; at "Unleashed" (`full_send`) only a short floor still asks.
 *
 * @module lib/agentIndependence
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentIndependence } from './agents';
import { setPolicy } from './agentPolicy';

export type { AgentIndependence } from './agents';
export {
  AGENT_INDEPENDENCE_TITLE,
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_ENDS,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_QUESTION,
  INDEPENDENCE_ROW_LABEL,
  INDEPENDENCE_SHORT,
  INDEPENDENCE_STILL_ASKS,
  INDEPENDENCE_TITLE,
  effectiveIndependence,
  independenceDetail,
  independenceOf,
  independenceRowLabel,
  independenceStep,
  independenceValueText,
  ownIndependenceCount,
  ownIndependenceLine,
  sameAsTeamLabel,
} from '../../packages/companion-protocol/src/independence';

export const getIndependence = () => invoke<AgentIndependence>('agents_independence');

/** Saved for every agent; the overview carries it, so the store picks it up. */
export const setIndependence = (level: AgentIndependence) =>
  invoke<AgentIndependence>('agents_set_independence', { level });

/**
 * One agent's own level, or `team` to follow the team's. The user choosing
 * it here applies at once, with a line in that agent's chat.
 */
export const setAgentIndependence = (agentId: string, level: AgentIndependence | 'team') =>
  setPolicy({ kind: 'agent', agentId }, { independence: level });
