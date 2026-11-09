/**
 * "All your Claude Code accounts are out until 4:00 PM. Carry on with Codex
 * until then?" (`agents/crossover.rs`): asked once, the first time every
 * account of an agent's engine is out and the other engine has room.
 *
 * Three answers, neutral like every answer (the strong one is never the
 * accent): **Wait** (outlined), **Just this time** (outlined, this outage
 * only) and **Always** (strong: the team's choice from now on, changeable
 * in Settings → Agents → Usage). They go to the Mac as Deny, Allow, and
 * Allow with always, so an older client's Allow / Deny still means Just
 * this time / Wait. Answered, it is one line.
 *
 * @module components/agents/AgentCrossoverCard
 */

import { useState } from 'react';
import { ClaudeIcon, CodexIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { AgentCard } from './AgentCard';
import { useCardGuard } from './useCardGuard';
import type { AgentMessage } from '../../lib/agents';
import {
  CROSSOVER_ALWAYS,
  CROSSOVER_ONCE,
  CROSSOVER_WAIT,
  crossoverOutcome,
} from '../../../packages/companion-protocol/src/crossover';

export function CrossoverCard({
  message,
  onAnswer,
  arrived,
}: {
  message: AgentMessage;
  onAnswer: (requestId: string, allow: boolean, always?: boolean) => Promise<void>;
  arrived?: boolean;
}) {
  const approval = message.approval;
  const pending = approval?.status === 'pending';
  const [openedPending] = useState(pending);
  const [busy, setBusy] = useState(false);
  const { guard, keyProps } = useCardGuard(pending);
  const ask = approval?.crossover;
  if (!approval || !ask) return null;
  const Icon = ask.to === 'codex' ? CodexIcon : ClaudeIcon;
  const answer = async (allow: boolean, always = false) => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, allow, always);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        className="agent-approval agent-crossover"
        data={{ status: approval.status }}
        icon={<Icon size={14} />}
        title={approval.title}
        actions={
          pending ? (
            <>
              <Button
                tabIndex={0}
                variant="secondary"
                className="agent-approval__deny"
                disabled={busy}
                onClick={() => void answer(false)}
              >
                {CROSSOVER_WAIT}
              </Button>
              <Button
                tabIndex={0}
                variant="secondary"
                disabled={busy}
                {...keyProps}
                onClick={guard(() => void answer(true))}
              >
                {CROSSOVER_ONCE}
              </Button>
              <Button
                tabIndex={0}
                variant="strong"
                data-allow
                disabled={busy}
                {...keyProps}
                onClick={guard(() => void answer(true, true))}
              >
                {CROSSOVER_ALWAYS}
              </Button>
            </>
          ) : undefined
        }
        outcome={
          pending
            ? undefined
            : approval.status === 'expired'
              ? approval.setAside
              : (crossoverOutcome(ask, approval.status, approval.choice) ?? undefined)
        }
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
      >
        {approval.summary && (
          <p className="agent-approval__detail agent-approval__detail--prose">{approval.summary}</p>
        )}
      </AgentCard>
    </div>
  );
}
