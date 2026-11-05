/**
 * Another agent's request, answered where you are. When the Chief says "Lead
 * Gen is waiting for your OK", the way to answer it is right there: a quiet
 * "Review Lead Gen's request" chip at the foot of the chat that opens the
 * same card in place. Answering it here answers it there (one request id,
 * one answer), so the card in Lead Gen's own chat resolves too.
 *
 * In the Chief's chat it offers every agent with a card open; in any other
 * chat, only the agents this one has worked with. This is the one way
 * another agent's request shows in a chat: a session's question that reached
 * this chat (it goes to every chat the work touched) is left out of the
 * conversation and offered here instead (`AgentChat`), so the Chief's chat
 * never shows one request as a card and the next as a chip.
 *
 * @module components/agents/AgentInlineRequests
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRightIcon } from '@/components/icons';
import { ApprovalCard } from './AgentChatItems';
import {
  answerApproval,
  needsYou,
  promptAnswer,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';
import { loadMessages, useAgentsSelector } from '../../lib/agentsStore';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

interface AgentInlineRequestsProps {
  /** The chat this sits in. */
  agent: Agent;
  agentsById: Map<string, Agent>;
  /** Agents this chat has messaged or heard from. */
  peerIds: Set<string>;
  /** Agents whose requests reached this chat (a session's question): offered here too. */
  askers?: Set<string>;
  /** Request ids whose cards are already in this chat. */
  shownRequestIds: Set<string>;
}

export function AgentInlineRequests({
  agent,
  agentsById,
  peerIds,
  askers,
  shownRequestIds,
}: AgentInlineRequestsProps) {
  // Opened here: kept on screen after its last card is answered, so you see
  // what you did rather than have it vanish under the pointer.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const asking = useMemo(
    () =>
      [...agentsById.values()].filter(
        (a) =>
          a.id !== agent.id &&
          !a.hidden &&
          (agent.isMain || peerIds.has(a.id) || askers?.has(a.id)) &&
          (needsYou(a) || opened.has(a.id))
      ),
    [agentsById, agent.id, agent.isMain, peerIds, askers, opened]
  );
  if (asking.length === 0) return null;
  return (
    <div className="agent-requests" aria-label="Requests from other agents">
      {asking.map((a) => (
        <RequestGroup
          key={a.id}
          asker={a}
          open={opened.has(a.id)}
          shownRequestIds={shownRequestIds}
          onToggle={() =>
            setOpened((current) => {
              const next = new Set(current);
              if (next.has(a.id)) next.delete(a.id);
              else next.add(a.id);
              return next;
            })
          }
        />
      ))}
    </div>
  );
}

function RequestGroup({
  asker,
  open,
  shownRequestIds,
  onToggle,
}: {
  asker: Agent;
  open: boolean;
  shownRequestIds: Set<string>;
  onToggle: () => void;
}) {
  const { showToast } = useOptionalToast();
  const lines = useAgentsSelector((s) => s.messages[asker.id]);
  // The cards are in its chat: read it once, so the chip is only offered
  // when there's a card here that this chat doesn't already show.
  useEffect(() => {
    if (!lines) void loadMessages(asker.id);
  }, [lines, asker.id]);
  // Cards answered here stay, showing what they resolved to, until the chat is left.
  const [answered, setAnswered] = useState<Map<string, AgentMessage>>(() => new Map());
  const cards = useMemo(
    () =>
      (lines ?? [])
        .filter(
          (m) =>
            m.kind === 'approval' &&
            m.approval &&
            !shownRequestIds.has(m.approval.requestId) &&
            (m.approval.status === 'pending' || answered.has(m.id))
        )
        .map((m) => answered.get(m.id) ?? m),
    [lines, shownRequestIds, answered]
  );
  // Mid-turn on a card counts as one even before the registry's count catches up.
  const count = Math.max(asker.pendingApprovals ?? 0, needsYou(asker) ? 1 : 0);
  // Not read yet, or every pending card it has is already in this chat: nothing to add.
  if (!lines || (cards.length === 0 && !open)) return null;
  const label =
    count > 1 ? `Review ${asker.name}’s ${count} requests` : `Review ${asker.name}’s request`;
  return (
    <div className="agent-requests__group" data-color={asker.color}>
      <button
        type="button"
        tabIndex={0}
        className="agent-requests__chip"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="sidebar-row-dot dot-attention" aria-hidden="true" />
        {count > 0 || !open ? label : `${asker.name}’s requests`}
        <ChevronRightIcon size={10} className="agent-requests__chevron" />
      </button>
      {open &&
        cards.map((m) => (
          <ApprovalCard
            key={m.id}
            message={m}
            agentName={asker.name}
            paused={asker.status.state === 'idle'}
            compact
            arrived={false}
            onAnswer={async (requestId, allow, always, note, choice) => {
              try {
                await answerApproval(asker.id, requestId, allow, always, note, choice);
                const approval = m.approval!;
                const resolved: AgentMessage = {
                  ...m,
                  approval: {
                    ...approval,
                    status: allow ? 'allowed' : 'denied',
                    alwaysAllowed: always && allow ? true : approval.alwaysAllowed,
                    note: allow ? undefined : note?.trim() || undefined,
                    ...(approval.prompt && promptAnswer(approval.prompt, allow, choice)),
                  },
                };
                setAnswered((current) => new Map(current).set(m.id, resolved));
              } catch (error) {
                showToast(formatCommandError(asCommandError(error)), 'error');
              }
            }}
          />
        ))}
      {open && cards.length === 0 && needsYou(asker) && (
        <p className="agent-requests__loading">Its request is in its own chat.</p>
      )}
    </div>
  );
}
