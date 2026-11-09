/**
 * The one polite live region a chat has: says each settled message that
 * arrives while the chat is open, once (`lib/chatAnnouncer`). The history
 * loaded with the chat, your own messages and a reply mid-stream stay quiet.
 *
 * @module components/agents/ChatAnnouncer
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentMessage } from '../../lib/agents';
import { nextAnnouncement } from '../../lib/chatAnnouncer';

export function ChatAnnouncer({
  chatId,
  messages,
  agentName,
}: {
  /** A different chat starts over: its history is never read out. */
  chatId: string;
  messages: readonly AgentMessage[] | undefined;
  agentName: string;
}) {
  const seen = useRef<{ chatId: string; ids: Set<string> } | null>(null);
  // Tagged with its chat, so another chat's last line is never shown here.
  const [said, setSaid] = useState<{ chatId: string; text: string } | null>(null);

  useEffect(() => {
    if (!messages) return;
    if (!seen.current || seen.current.chatId !== chatId) {
      // What was there when the chat opened is history, not news.
      seen.current = { chatId, ids: new Set(messages.map((m) => m.id)) };
      return;
    }
    const next = nextAnnouncement(messages, seen.current.ids, agentName);
    if (next) setSaid({ chatId, text: next });
  }, [chatId, messages, agentName]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {said?.chatId === chatId ? said.text : ''}
    </div>
  );
}
