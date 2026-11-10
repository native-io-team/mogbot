/**
 * Several conversations with one agent, on the phone (docs/mobile.md,
 * "Conversations"). Pure rules, tested without React or a socket:
 *
 * - an agent's own chat in the store (`chats[agentId]`) stays every line it
 *   has, whatever the conversation: the Needs tab, the agent rows and the
 *   request screens read its cards there;
 * - one conversation's chat is kept beside it under
 *   `conversationKey(agentId, id)`, read a page at a time with
 *   `agents.messages`'s `conversation`, so paging, upserts and the outbox
 *   work unchanged;
 * - a Mac that doesn't serve `agents.conversations` has one conversation:
 *   the chat is `chats[agentId]`, as before.
 */

import {
  conversationOf,
  type AgentMessage,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';

const SEP = '#conversation:';

/** The store key for one conversation's chat. */
export const conversationKey = (agentId: string, conversation: string) =>
  `${agentId}${SEP}${conversation}`;

/** The agent and conversation a store key names, or null for any other key. */
export function conversationOfKey(key: string): { agentId: string; conversation: string } | null {
  const at = key.indexOf(SEP);
  if (at <= 0) return null;
  return { agentId: key.slice(0, at), conversation: key.slice(at + SEP.length) };
}

/** The agent a store key belongs to: a conversation's key gives its agent, any other key itself. */
export const agentOfKey = (key: string) => conversationOfKey(key)?.agentId ?? key;

/** The conversation chat a line also belongs in; none for a room's line. */
export function conversationKeyOf(m: AgentMessage): string | null {
  if (m.room || !m.agentId) return null;
  return conversationKey(m.agentId, conversationOf(m));
}

/** The Mac keeps several conversations per agent, and says so. */
export function conversationsOffered(welcome: WelcomeFrame | null | undefined): boolean {
  return !!welcome?.methods?.includes('agents.conversations');
}

/**
 * Where an agent's chat reads from: its viewed conversation's key on a Mac
 * that has them (null until it is known which), else the agent's own chat.
 */
export function chatKeyFor(
  agentId: string,
  viewing: string | undefined,
  offered: boolean
): string | null {
  if (!offered) return agentId;
  return viewing ? conversationKey(agentId, viewing) : null;
}
