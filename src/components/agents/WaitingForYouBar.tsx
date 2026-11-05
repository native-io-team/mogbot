/**
 * "Waiting for you": the bar a chat shows while its agent's turn is stopped
 * on a card the user's level doesn't answer. It names the card in one line,
 * so a blocked agent never looks like a busy one. The sidebar row, the
 * review bar, the Dock badge and the notification say the same from their
 * own counts (`pendingApprovals`, `status.state === 'waiting'`).
 *
 * @module components/agents/WaitingForYouBar
 */

import type { Agent, AgentMessage, Approval } from '../../lib/agents';
import { Button } from '../primitives/Button';
import { ConversationBar } from './AgentCard';

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
}: {
  agent: Pick<Agent, 'status' | 'name'>;
  messages: readonly AgentMessage[] | undefined;
}) {
  const message = waitingMessage(agent, messages);
  const card = message?.approval;
  if (!message || !card) return null;
  // The card is in this chat, but often scrolled away: the bar never says
  // "below" (it sits under the card) and brings it to the middle instead.
  const show = () => {
    const target = document.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(message.id)}"]`
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return (
    <ConversationBar
      state="waiting"
      role="alert"
      data-testid="agent-waiting-bar"
      title="Waiting for you"
      detail={`${agent.name} is stopped until you answer: ${card.title}.`}
      actions={
        <Button variant="secondary" size="compact" onClick={show}>
          Show
        </Button>
      }
    />
  );
}
