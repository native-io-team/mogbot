/**
 * "Step in" (`lib/agentStepIn`, desktop `agents/step_in.rs`): an agent in its
 * own browser needs you for one step it can't pass.
 *
 * - **The card**: "<Agent> needs you in its browser: <reason>", the site, a
 *   muted line that its tab opens on this Mac and it never sees what you
 *   type; Not now (outlined) and Step in (neutral strong, never the accent).
 * - **While you're in it**: the card says so with Show window, and one bar
 *   above the composer, "You're in <Agent>'s browser · Hand back", with the
 *   site and when it hands back by itself. ⌘K "Hand <Agent> its browser back".
 * - **Closed**: one line (Handed back, Not now, or why it ended by itself).
 *
 * @module components/agents/AgentStepIn
 */

import { useCallback, useState } from 'react';
import { GlobeIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { AgentCard, ConversationBar } from './AgentCard';
import { useCardGuard } from './useCardGuard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useCommands } from '../../commands/useCommands';
import type { Agent, AgentMessage } from '../../lib/agents';
import {
  activeStepIn,
  handBackAgentBrowser,
  showStepInWindow,
  STEP_IN_NOTE,
  stepInBarDetail,
  stepInBarTitle,
  stepIntoAgentBrowser,
  stepInOutcome,
} from '../../lib/agentStepIn';

/** Run a step-in action, saying what went wrong in a toast. */
function useStepInAction() {
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        showToast(formatCommandError(asCommandError(err)), 'error');
      } finally {
        setBusy(false);
      }
    },
    [showToast]
  );
  return { busy, run };
}

export function StepInCard({
  message,
  onAnswer,
  arrived,
}: {
  message: AgentMessage;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
  arrived?: boolean;
}) {
  const approval = message.approval;
  const pending = approval?.status === 'pending';
  const [openedPending] = useState(pending);
  const { guard, keyProps } = useCardGuard(pending);
  const { busy, run } = useStepInAction();
  if (!approval?.stepIn) return null;
  const card = approval.stepIn;
  const inNow = pending && !!card.inSince;
  const agentId = message.agentId;
  const requestId = approval.requestId;
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        className="agent-approval agent-step-in"
        data={{ status: approval.status, in: inNow || undefined }}
        icon={<GlobeIcon size={14} />}
        title={approval.title}
        source={card.pageTitle ? `${card.site} · ${card.pageTitle}` : card.site}
        note={
          !pending
            ? undefined
            : inNow
              ? 'You’re in its browser now. Hand back when you’re done.'
              : STEP_IN_NOTE
        }
        actions={
          !pending ? undefined : inNow ? (
            <>
              <Button
                tabIndex={0}
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => showStepInWindow(agentId))}
              >
                Show window
              </Button>
              <Button
                tabIndex={0}
                variant="strong"
                disabled={busy}
                onClick={() => void run(() => handBackAgentBrowser(agentId, requestId))}
              >
                Hand back
              </Button>
            </>
          ) : (
            <>
              <Button
                tabIndex={0}
                variant="secondary"
                className="agent-approval__deny"
                disabled={busy}
                onClick={() => void run(() => onAnswer(requestId, false))}
              >
                Not now
              </Button>
              <Button
                tabIndex={0}
                variant="strong"
                data-allow
                disabled={busy}
                {...keyProps}
                onClick={guard(() => void run(() => stepIntoAgentBrowser(agentId, requestId)))}
              >
                Step in
              </Button>
            </>
          )
        }
        outcome={pending ? undefined : stepInOutcome(approval)}
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
      />
    </div>
  );
}

/**
 * The bar above the composer while you're in this agent's browser, and the
 * ⌘K command that hands it back.
 */
export function StepInBar({
  agent,
  messages,
  now = Date.now(),
}: {
  agent: Agent;
  messages: readonly AgentMessage[];
  /** For the "hands back by itself in N min" line; tests pin it. */
  now?: number;
}) {
  const active = activeStepIn(messages);
  const { busy, run } = useStepInAction();
  const requestId = active?.requestId;
  const handBack = useCallback(() => {
    if (requestId) void run(() => handBackAgentBrowser(agent.id, requestId));
  }, [agent.id, requestId, run]);
  useCommands(
    () =>
      requestId
        ? [
            {
              id: `agents.stepIn.handBack.${agent.id}`,
              title: `Hand ${agent.name} its browser back`,
              icon: <GlobeIcon size={14} />,
              category: 'action' as const,
              keywords: ['agents', 'browser', 'step in', 'give back', 'resume', 'done'],
              run: handBack,
            },
          ]
        : [],
    [agent.id, agent.name, requestId, handBack]
  );
  if (!active?.stepIn) return null;
  return (
    <ConversationBar
      state="active"
      icon={<GlobeIcon size={12} />}
      data-testid="agent-step-in-bar"
      title={stepInBarTitle(agent.name)}
      detail={stepInBarDetail(active.stepIn, now)}
      actions={
        <>
          <TextButton
            tabIndex={0}
            disabled={busy}
            onClick={() => void run(() => showStepInWindow(agent.id))}
          >
            Show window
          </TextButton>
          <Button size="compact" variant="secondary" disabled={busy} onClick={handBack}>
            Hand back
          </Button>
        </>
      }
    />
  );
}
