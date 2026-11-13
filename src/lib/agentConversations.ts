/**
 * Several conversations with one agent: the invoke wrappers and the keys a
 * conversation's chat is kept under in the agents store (`agentsStore`).
 *
 * An agent's chat used to be one list, `messages[agentId]`. That list stays
 * as it was (every line, whatever its conversation), because the cards, the
 * sidebar's "Needs your OK" and What's in flight read it. A conversation's
 * own chat is kept beside it under `conversationKey(agentId, id)`, read from
 * the Mac one conversation at a time (`agents_messages` with `conversation`).
 *
 * @module lib/agentConversations
 */

import { invoke } from '@tauri-apps/api/core';
import {
  FIRST_CONVERSATION,
  conversationOf,
  type Conversations,
} from '../../packages/companion-protocol/src/conversations';
import type { Agent, AgentMessage } from './agents';

export {
  FIRST_CONVERSATION,
  CONVERSATION_TITLE_CHARS,
  conversationOf,
  conversationTitle,
  filterConversations,
  othersWaiting,
  routineConversationLine,
  routineMoveChoices,
  type ConversationView,
  type Conversations,
} from '../../packages/companion-protocol/src/conversations';

const SEP = '#conversation:';

/** Where one conversation's chat is kept in the store. */
export const conversationKey = (agentId: string, conversation: string) =>
  `${agentId}${SEP}${conversation}`;

/** The agent and conversation a store key names, or null for any other key. */
export function conversationOfKey(
  key: string | null | undefined
): { agentId: string; conversation: string } | null {
  if (!key) return null;
  const at = key.indexOf(SEP);
  if (at <= 0) return null;
  return { agentId: key.slice(0, at), conversation: key.slice(at + SEP.length) };
}

/**
 * The conversation a line belongs to. One sent by the Mac without saying
 * (written before it said, or by a path that doesn't) was written to the
 * conversation the agent's engine had loaded, which is what the Mac stamps.
 */
export function lineConversation(message: AgentMessage, agent: Agent | undefined): string {
  if (message.conversation) return conversationOf(message);
  return agent?.conversations?.loaded ?? FIRST_CONVERSATION;
}

/** The conversation the agent's engine has loaded: a turn in progress is in it. */
export const loadedConversation = (agent: Pick<Agent, 'conversations'>) =>
  agent.conversations?.loaded ?? FIRST_CONVERSATION;

export const getConversations = (agentId: string) =>
  invoke<Conversations>('agents_conversations', { agentId });
export const newConversation = (agentId: string) =>
  invoke<Conversations>('agents_conversation_new', { agentId });
export const selectConversation = (agentId: string, conversationId: string) =>
  invoke<Conversations>('agents_conversation_select', { agentId, conversationId });
export const renameConversation = (agentId: string, conversationId: string, title: string) =>
  invoke<Conversations>('agents_conversation_rename', { agentId, conversationId, title });
/**
 * "Rewind to here" (and Edit and resend, before its send): the conversation
 * carries on from just before the user's message; what came after is folded.
 */
export const rewindConversation = (agentId: string, conversationId: string, messageId: string) =>
  invoke<Conversations>('agents_conversation_rewind', { agentId, conversationId, messageId });
/** "Fork from here": a new conversation with everything before the message; `current` is it. */
export const forkConversation = (agentId: string, conversationId: string, messageId: string) =>
  invoke<Conversations>('agents_conversation_fork', { agentId, conversationId, messageId });
/** Move a routine to another of the agent's conversations: it fires there from its next run. */
export const moveRoutine = (agentId: string, routineId: string, conversationId: string) =>
  invoke<Conversations>('agents_conversation_routine', { agentId, routineId, conversationId });

/**
 * The card an agent's chat opens on when its row says "Needs your OK": the
 * newest one still waiting that the Mac counts (`store::count_pending`; a
 * "Save … as a skill?" offer waits on nothing), and the conversation it was
 * said in, which is where the Mac's page for it holds it. Null when none of
 * the lines read hold one.
 */
export function cardToOpen(
  messages: readonly AgentMessage[] | undefined
): { message: AgentMessage; conversation: string } | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = messages[i].approval;
    if (a?.status === 'pending' && !a.skill) {
      return { message: messages[i], conversation: conversationOf(messages[i]) };
    }
  }
  return null;
}
