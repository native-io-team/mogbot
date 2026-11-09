/**
 * What a screen reader hears when something new lands in a chat.
 *
 * The history itself is not a live region: a reply streams in word by word,
 * and announcing every word (or re-reading the whole bubble on each one) is
 * noise. Instead one quiet line is announced per *settled* message that
 * arrives while the chat is open — never the history loaded with it, never a
 * message you sent yourself, never the streaming draft.
 *
 * @module lib/chatAnnouncer
 */

import type { AgentMessage } from './agents';

/** Long replies are cut: the user can read the rest in the history. */
export const ANNOUNCE_MAX_CHARS = 160;

function clip(text: string): string {
  const flat = text
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > ANNOUNCE_MAX_CHARS
    ? `${flat.slice(0, ANNOUNCE_MAX_CHARS).trimEnd()}…`
    : flat;
}

/**
 * The line for one newly arrived message, or null when it should pass
 * silently (your own messages, quiet notes, session marks).
 */
export function announcementFor(
  message: Pick<AgentMessage, 'kind' | 'text' | 'approval' | 'peer'>,
  agentName: string
): string | null {
  switch (message.kind) {
    case 'agent': {
      const text = clip(message.text);
      return text ? `${agentName}: ${text}` : null;
    }
    case 'from_agent': {
      const text = clip(message.text);
      const from = message.peer?.name ?? 'Another agent';
      return text ? `${from} to ${agentName}: ${text}` : null;
    }
    case 'approval': {
      if (message.approval?.status !== 'pending') return null;
      return `${agentName} is asking: ${clip(message.approval.title)}`;
    }
    case 'error': {
      const text = clip(message.text);
      return text ? `${agentName} stopped: ${text}` : `${agentName} stopped`;
    }
    case 'check_in': {
      const text = clip(message.text);
      return text ? `${agentName} checked in: ${text}` : null;
    }
    default:
      return null;
  }
}

/**
 * Of `messages`, the newest one that wasn't in `seen` and is worth saying.
 * `seen` is updated in place with every id passed in.
 */
export function nextAnnouncement(
  messages: readonly Pick<AgentMessage, 'id' | 'kind' | 'text' | 'approval' | 'peer'>[],
  seen: Set<string>,
  agentName: string
): string | null {
  let line: string | null = null;
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    line = announcementFor(m, agentName) ?? line;
  }
  return line;
}
