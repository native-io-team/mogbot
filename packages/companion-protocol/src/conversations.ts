/**
 * Several conversations with one agent (`agents/conversations.rs`, docs/agents.md,
 * "Several conversations"). Each has its own engine session and its own chat;
 * the agent's instructions and memory are shared by all of them. Shared by the
 * desk and the phone so both say the same thing.
 */

import type { ContextFill } from './model';
import type { ForkedFrom, Rewind } from './rewind';
import { conversationAutoTitle } from './conversationTitle';

export { conversationAutoTitle, CONVERSATION_AUTO_TITLE_CHARS } from './conversationTitle';

/** The first conversation's id: the chat every agent already had. */
export const FIRST_CONVERSATION = 'first';
/** Longest title the user may type, as the Mac holds it (`conversations::TITLE_CHARS`). */
export const CONVERSATION_TITLE_CHARS = 60;

/** One conversation as the switcher shows it (`conversations::ConversationView`). */
export interface ConversationView {
  id: string;
  /** From its first message until the user renames it; empty before that. */
  title: string;
  /** The user named it. */
  named: boolean;
  createdAt: number;
  lastActivityAt: number;
  preview?: string;
  /** The one the user is in. */
  current: boolean;
  /** Its session is the agent's loaded one: a turn in progress is its. */
  loaded: boolean;
  /** Cards in it waiting on the user. */
  waiting: number;
  /** How full it is, as its engine last said. */
  context?: ContextFill;
  /** Where the user went back to: the lines each folded, oldest first. Absent from older Macs. */
  rewinds?: Rewind[];
  /** A fork: where it came from. */
  forkedFrom?: ForkedFrom;
}

/** `agents_conversations` / `agents.conversations`. */
export interface Conversations {
  agentId: string;
  current: string;
  /** Newest activity first. */
  items: ConversationView[];
  /** Routine id → the conversation it runs in, for routines not in the first. */
  routines: Record<string, string>;
}

/** The conversation a line was said in: absent on lines from before there were several. */
export function conversationOf(message: { conversation?: string | null }): string {
  return message.conversation || FIRST_CONVERSATION;
}

/**
 * What a conversation is called: its title, or the plain words for one with
 * nothing said yet. An automatic title is tidied (`conversationAutoTitle`), in
 * case the Mac is on a build that sent the whole first line; a name the user
 * typed is shown as typed.
 */
export function conversationTitle(
  c: (Pick<ConversationView, 'title' | 'id'> & { named?: boolean }) | undefined
): string {
  const title = c?.named ? c.title.trim() : conversationAutoTitle(c?.title ?? '');
  if (title) return title;
  return c?.id === FIRST_CONVERSATION ? 'First conversation' : 'New conversation';
}

/** The switcher's search: by title or its last line, words in any order, any case. */
export function filterConversations(
  items: readonly ConversationView[],
  query: string
): ConversationView[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((c) => {
    const hay = `${conversationTitle(c)} ${c.preview ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The line under a routine saying which conversation it runs in, when the
 * agent has more than one; null otherwise (one conversation says nothing).
 */
export function routineConversationLine(
  list: Conversations | null | undefined,
  routineId: string
): string | null {
  if (!list || list.items.length < 2) return null;
  const id = list.routines[routineId] ?? FIRST_CONVERSATION;
  const c = list.items.find((i) => i.id === id);
  return c ? `In “${conversationTitle(c)}”` : null;
}

/** Most conversations offered when moving a routine: the latest ones. */
export const ROUTINE_MOVE_CHOICES = 6;

/**
 * The conversations a routine could move to (`agents.conversationRoutine`):
 * every one but its own, most recent first, at most `ROUTINE_MOVE_CHOICES`.
 * None while the agent has only one.
 */
export function routineMoveChoices(
  list: Conversations | null | undefined,
  routineId: string
): { id: string; title: string }[] {
  if (!list || list.items.length < 2) return [];
  const own = list.routines[routineId] ?? FIRST_CONVERSATION;
  return list.items
    .filter((c) => c.id !== own)
    .slice(0, ROUTINE_MOVE_CHOICES)
    .map((c) => ({ id: c.id, title: conversationTitle(c) }));
}

/**
 * What the switcher's button says beside the title: how many other
 * conversations wait on the user, if any ("2 others need you").
 */
export function othersWaiting(list: Conversations | null | undefined, viewing: string): number {
  if (!list) return 0;
  return list.items.filter((c) => c.id !== viewing && c.waiting > 0).length;
}
