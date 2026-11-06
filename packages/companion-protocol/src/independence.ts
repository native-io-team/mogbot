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
