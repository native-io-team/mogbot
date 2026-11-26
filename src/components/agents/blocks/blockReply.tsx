/**
 * How a block answers: the chat it is in says how the user's words go back.
 * `send` is the composer's own send (the user's message, through the usual
 * path, so independence and approvals are unchanged); `stage` puts words in
 * the composer for the user to read and send themselves. `answerOf` is what
 * the user said after a message, if anything: an answered block shows its
 * answer and sends nothing again.
 *
 * `card` is the message the block is on: the answer carries it, so only that
 * card shows it, not other cards still open beside it.
 *
 * In a room the answer goes to the member that asked: `from` is its id, and
 * `answerOf` only counts your lines to it. Outside a chat that provides one
 * (a search result, the team page) blocks still draw, and their answers are
 * off.
 *
 * @module components/agents/blocks/blockReply
 */

import { createContext, useContext } from 'react';

export interface BlockReply {
  send: (text: string, from: string, card: string) => void;
  stage: (text: string, from: string) => void;
  answerOf: (messageId: string, from: string) => string | null;
}

export const BlockReplyContext = createContext<BlockReply | null>(null);

export const useBlockReply = () => useContext(BlockReplyContext);

/** How one block's answer goes, given its message. */
export interface Answering {
  /** Null when this chat takes no answers. */
  reply: ((text: string) => void) | null;
  /** The words go into the composer instead of sending (outside text). */
  staged: boolean;
  /** What the user already said after it, if anything. */
  answer: string | null;
}
