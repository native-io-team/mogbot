/**
 * "Step in" (`lib/agentStepIn`, desktop `agents/step_in.rs`): an agent in its
 * own browser needs you for one step it can't pass.
 *
 * - **The card**: "<Agent> needs you in its browser: <reason>", the site, a
 *   muted line that its tab opens on this Mac and it never sees what you
 *   type; Not now (outlined) and Step in (neutral strong, never the accent).
 * - **While you're in it**: one bar above the composer, "You're in <Agent>'s
 *   browser", with the site, when it hands back by itself, Show window and
 *   Hand back. ⌘K "Hand <Agent> its browser back". In its own chat the card
 *   only says so and points at the bar (the same two buttons twice, with
 *   opposite weights, read as two different things); drawn anywhere else
 *   (the team view, another chat's requests) it keeps them.
 *   From the phone, both name the phone instead and drop Show window (its
 *   window stays parked); Hand back here ends it on the phone too.
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
  stepInNowNote,
  stepInBarDetail,
  stepInBarTitle,
  stepIntoAgentBrowser,
  stepInOutcome,
  stepInSource,
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
  barShown = false,
}: {
  message: AgentMessage;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
  arrived?: boolean;
  /** The Step in bar is showing (its own agent's chat): Show window and Hand back live there. */
  barShown?: boolean;
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
        source={stepInSource(card)}
        note={!pending ? undefined : inNow ? stepInNowNote(card.onPhone, barShown) : STEP_IN_NOTE}
        actions={
          !pending || (inNow && barShown) ? undefined : inNow ? (
            <>
              {!card.onPhone && (
                <Button
                  tabIndex={0}
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run(() => showStepInWindow(agentId))}
                >
                  Show window
                </Button>
              )}
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

const activeStepInId = (messages: readonly AgentMessage[]) => activeStepIn(messages)?.requestId;

/**
 * The bar above the composer while you're in this agent's browser, and the
 * ⌘K command that hands it back.
 */
export function StepInBar({
  agent,
  messages,
  now,
}: {
  agent: Agent;
  messages: readonly AgentMessage[];
  /** For the "hands back by itself in N min" line; tests pin it. */
  now?: number;
}) {
  const active = activeStepIn(messages);
  // Read before any hook, so nothing after them touches `active`.
  const detail = active?.stepIn ? stepInBarDetail(active.stepIn, now) : null;
  const onPhone = active?.stepIn?.onPhone;
  // Its own read, not `active`'s field: the compiler counts `active` as
  // possibly changed by the calls above and would drop `handBack`'s memo.
  const requestId = activeStepInId(messages);
  const { busy, run } = useStepInAction();
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
  if (!detail) return null;
  return (
    <ConversationBar
      state="active"
      icon={<GlobeIcon size={12} />}
      data-testid="agent-step-in-bar"
      title={stepInBarTitle(agent.name, onPhone)}
      detail={detail}
      actions={
        <>
          {!onPhone && (
            <TextButton
              tabIndex={0}
              disabled={busy}
              onClick={() => void run(() => showStepInWindow(agent.id))}
            >
              Show window
            </TextButton>
          )}
          <Button size="compact" variant="secondary" disabled={busy} onClick={handBack}>
            Hand back
          </Button>
        </>
      }
    />
  );
}
