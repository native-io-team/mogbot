/**
 * How much agents do on their own (`agents::independence`): one choice for
 * the whole team, asked in onboarding and kept in Settings → Agents, ⌘K and
 * on the phone. Worded once for the desk and the phone by the companion
 * protocol's `independence.ts`.
 *
 * It changes what agents are told on their next turn and which cards are
 * answered for the user; at "Full send" only a short floor still asks.
 *
 * @module lib/agentIndependence
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentIndependence } from './agents';

export type { AgentIndependence } from './agents';
export {
  DEFAULT_INDEPENDENCE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_QUESTION,
  INDEPENDENCE_STILL_ASKS,
  independenceOf,
} from '../../packages/companion-protocol/src/independence';

export const getIndependence = () => invoke<AgentIndependence>('agents_independence');

/** Saved for every agent; the overview carries it, so the store picks it up. */
export const setIndependence = (level: AgentIndependence) =>
  invoke<AgentIndependence>('agents_set_independence', { level });
