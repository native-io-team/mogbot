/**
 * Blocks on the phone (`components/blocks`): who answers a choice, a
 * comparison's "Pick this" or a form, and whether it already has been.
 *
 * An answer is the user's own message, sent as any other (`send`), so the
 * Mac's independence and approvals apply unchanged. A set the agent posted
 * while answering outside text (`fromOutside`) never sends on a tap: the
 * words go into the composer, for the user to read and send themselves.
 *
 * Only a chat that provides `BlockReplies` can answer (the agent's own chat);
 * a room or the one-at-a-time view draws the blocks without answers.
 */

import { createContext, useContext } from 'react';
import type { AgentMessage } from '@shipstudio/companion-protocol';
import { readBlocks } from '@shipstudio/companion-protocol';

export interface BlockReplies {
  /** What the user said next after this message: null while unanswered. */
  answerOf: (messageId: string) => string | null;
  /** Send the words as the user (or stage them, from outside text). */
  reply: (agentId: string, text: string, stageOnly: boolean) => void;
}

export const BlockRepliesContext = createContext<BlockReplies | null>(null);

export const useBlockReplies = () => useContext(BlockRepliesContext);

/**
 * For each message carrying blocks, the user's next message after it, in one
 * pass from the newest end (`answerAfter`, for a whole chat). Sends still on
 * their way (`pending`, always the newest) count: the tap is the answer.
 */
export function blockAnswers(
  messages: readonly Pick<AgentMessage, 'id' | 'kind' | 'text' | 'blocks'>[],
  pending: readonly { text: string }[] = []
): Map<string, string> {
  const out = new Map<string, string>();
  // The oldest pending send is the first thing said after every message.
  let next: string | null = pending.length ? pending[0]!.text : null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'user') {
      next = m.text;
      continue;
    }
    if (next != null && m.blocks && readBlocks(m)) out.set(m.id, next);
  }
  return out;
}
