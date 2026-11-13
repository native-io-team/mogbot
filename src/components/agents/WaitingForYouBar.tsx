/**
 * "<Agent> needs your OK" (the words the sidebar pill and the requests bar use): the bar a chat shows while its agent's turn
 * is held on a card the user's level doesn't answer, so a blocked agent
 * never looks like a busy one. It says the state and nothing more: the card
 * already asks its question, and a bar never repeats it (docs/agents.md,
 * "Lines, cards and bars"). Review brings the card into view. The sidebar
 * row, the requests bar, the Dock badge and the notification say the same
 * from their own counts (`pendingApprovals`, `status.state === 'waiting'`).
 *
 * @module components/agents/WaitingForYouBar
 */

import { useEffect, useState } from 'react';
import type { Agent, AgentMessage, Approval } from '../../lib/agents';
import { Button } from '../primitives/Button';
import { ConversationBar } from './AgentCard';
import { scrollMotion } from '../../lib/motion';

/**
 * The newest open card the turn is stopped on: a permission or the app's
 * own confirmation. Sign-ins, secure inputs, a session's question and an
 * import's cards don't stop a turn, so they're not it. `null` when the agent
 * isn't waiting.
 */
export function waitingOn(
  agent: Pick<Agent, 'status'>,
  messages: readonly AgentMessage[] | undefined
): Approval | null {
  return waitingMessage(agent, messages)?.approval ?? null;
}

/** The message carrying that card, so the bar can bring it into view. */
function waitingMessage(
  agent: Pick<Agent, 'status'>,
  messages: readonly AgentMessage[] | undefined
): AgentMessage | null {
  if (agent.status.state !== 'waiting' || !messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = messages[i].approval;
    if (!a || a.status !== 'pending') continue;
    if (a.login || a.secret || a.prompt || a.connector) continue;
    return messages[i];
  }
  return null;
}

export function WaitingForYouBar({
  agent,
  messages,
  onReview,
}: {
  agent: Pick<Agent, 'status' | 'name'>;
  messages: readonly AgentMessage[] | undefined;
  /**
   * Opens the chat on the card wherever it is: in another of the agent's
   * conversations, or above the lines mounted so far, where no element for
   * it exists and Review used to do nothing at all (issue #22).
   */
  onReview?: (message: AgentMessage) => void;
}) {
  const message = waitingMessage(agent, messages);
  const card = message?.approval;
  const messageId = message?.id ?? null;
  const cardVisible = useCardVisible(messageId);
  if (!message || !card) return null;
  // The card is right there in the open chat: the bar would only repeat it.
  if (cardVisible) return null;
  // The card is in this chat, but often scrolled away: the bar never says
  // "below" (it sits under the card) and brings it to the middle instead.
  const show = () => {
    if (onReview) {
      onReview(message);
      return;
    }
    const target = document.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(message.id)}"]`
    );
    target?.scrollIntoView({ block: 'center', behavior: scrollMotion() });
  };
  return (
    <ConversationBar
      state="waiting"
      role="alert"
      data-testid="agent-waiting-bar"
      title={`${agent.name} needs your OK`}
      actions={
        <Button variant="secondary" size="compact" onClick={show}>
          Review
        </Button>
      }
    />
  );
}

/**
 * Whether the message carrying the card is on screen in the open chat right
 * now. The bar is for a card that's scrolled away (or in another chat, where
 * no such element exists); with it in view the bar says nothing twice.
 */
function useCardVisible(messageId: string | null): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!messageId || typeof IntersectionObserver === 'undefined') return;
    let observer: IntersectionObserver | null = null;
    let raf = 0;
    let tries = 0;
    const attach = () => {
      const target = document.querySelector<HTMLElement>(
        `[data-message-ids~="${CSS.escape(messageId)}"]`
      );
      if (!target) {
        // The row may mount a frame after the bar; try briefly, then give up
        // (another chat, or a virtualised-away row: the bar stays).
        if (tries++ < 10) raf = requestAnimationFrame(attach);
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          setVisible(!!last?.isIntersecting && last.intersectionRatio >= 0.6);
        },
        { threshold: [0, 0.6, 1] }
      );
      observer.observe(target);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [messageId]);
  return visible;
}
