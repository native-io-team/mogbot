/**
 * `agents_conversations` and friends (`agents/conversations.rs`), in the
 * shape `Conversations` the Mac serializes. The base gives every agent its
 * one conversation, as an agent that never had a second one has; the
 * `agents-conversations*` scenarios give one agent several.
 */

import type { Conversations, ConversationView } from '../../lib/agentConversations';

/** An agent that only ever had its first conversation. */
export function onlyFirst(args: Record<string, unknown>): Conversations {
  return {
    agentId: String(args.agentId),
    current: 'first',
    items: [
      {
        id: 'first',
        title: '',
        named: false,
        createdAt: 0,
        lastActivityAt: 0,
        current: true,
        loaded: true,
        waiting: 0,
      },
    ],
    routines: {},
  };
}

const HOUR = 3_600_000;

/** Several conversations with one agent: one on screen, one waiting on you, one working. */
export function several(
  agentId: string,
  now: number,
  current = 'c-launch',
  loaded = 'c-launch'
): Conversations {
  const item = (
    id: string,
    title: string,
    ago: number,
    extra: Partial<ConversationView> = {}
  ): ConversationView => ({
    id,
    title,
    named: false,
    createdAt: now - ago - HOUR,
    lastActivityAt: now - ago,
    current: id === current,
    loaded: id === loaded,
    waiting: 0,
    ...extra,
  });
  return {
    agentId,
    current,
    items: [
      item('c-launch', 'Plan the November launch email', 4 * 60_000, {
        preview: 'Here’s the outline, three sections…',
      }),
      item('c-invoices', 'Chase the two overdue invoices', 2 * HOUR, {
        preview: 'Needs your OK: Send email to billing@acme.co',
        waiting: 1,
      }),
      item('first', 'Set up the weekly metrics report', 3 * 24 * HOUR, {
        named: true,
        preview: 'Done. It runs every Monday at 9.',
      }),
      item('c-hiring', 'Draft the job post for a designer', 6 * 24 * HOUR, {
        preview: 'Sent you a draft.',
      }),
    ],
    routines: { 'ci-weekly': 'first' },
  };
}
