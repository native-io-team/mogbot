/**
 * Other agents' requests, answered where you are. One bar above the
 * composer says who is waiting and on how much ("16 agents need your OK ·
 * 41 logins to add"); Review opens one panel rising from it, the agents in
 * name order, each opening to its own cards, answerable in place. Answering
 * here answers it there (one request id, one answer), so the card in that
 * agent's own chat resolves too; "Open chat" goes to it.
 *
 * Open, the panel and the bar are one surface: the panel has no header of
 * its own (the bar under it already says who and how many), the bar's Done
 * is the one way to close it (Escape and a click elsewhere too), and the
 * cards inside sit on it flat rather than as cards within a card.
 *
 * It replaced a chip per agent at the foot of the conversation, which after
 * an import stacked sixteen deep and followed every message. A bar is the
 * state of this conversation until it ends (docs/agents.md, "Lines, cards and
 * bars"): one place, one height, and the conversation never moves for it.
 * With one or two agents the bar names them, and the panel opens them both.
 *
 * In the Chief's chat it offers every agent with a card open; in any other
 * chat, only the agents this one has worked with. A session's question that
 * reached this chat (it goes to every chat the work touched) is left out of
 * the conversation and offered here instead (`AgentChat`).
 *
 * It reads the cards already in each agent's chat, so requests that were
 * waiting before this existed show here as they are.
 *
 * After an import, requests from the agents still waiting to be set up
 * belong to "Setting up your team" (`setup`): they're left out of this bar,
 * and when they are all there is, the bar gives way to the checklist's own
 * (its Continue opens the checklist). Mixed with other agents' requests, the
 * panel says how many more are in the checklist and opens it.
 *
 * @module components/agents/AgentRequests
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { ChevronRightIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { AgentKey } from './AgentKey';
import { ConversationBar } from './AgentCard';
import { ApprovalCard } from './AgentChatItems';
import {
  agentColorway,
  answerApproval,
  needsYou,
  promptAnswer,
  type Agent,
  type AgentMessage,
} from '../../lib/agents';
import {
  allowAllCards,
  allowAllLine,
  groupLine,
  groupRequests,
  requestsDetail,
  requestsTitle,
  type RequestGroup,
} from '../../lib/agentRequests';
import { loadMessages, useAgentsSelector } from '../../lib/agentsStore';
import { useTeamSetup } from '../../lib/teamSetup';
import { needsYouCount as countNeedsYou } from '../../../packages/companion-protocol/src/attention';
import { useClickOutside } from '../../hooks/useClickOutside';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useOpenModal } from '../../contexts/ModalContext';

interface AgentRequestsBarProps {
  /** The chat this sits in. */
  agent: Agent;
  /** Agents this chat has messaged or heard from. */
  peerIds: Set<string>;
  /** Agents whose requests reached this chat (a session's question): offered here too. */
  askers?: Set<string>;
  /** Request ids whose cards are already in this chat. */
  shownRequestIds: Set<string>;
  /** Open another agent's chat. */
  onOpenAgent: (agentId: string) => void;
  /**
   * "Setting up your team" is live: these agents' requests are its own, and
   * `onOpen` brings the checklist into view.
   */
  setup?: { agentIds: ReadonlySet<string>; onOpen: () => void };
}

/** With this many agents or fewer, the panel opens with every one expanded. */
const OPEN_ALL_UP_TO = 2;

const sameAgents = (a: Agent[], b: Agent[]) =>
  a.length === b.length && a.every((agent, i) => agent === b[i]);

const TOGGLE = '.agent-requests-panel__toggle';

export function AgentRequestsBar({
  agent,
  peerIds,
  askers,
  shownRequestIds,
  onOpenAgent,
  setup,
}: AgentRequestsBarProps) {
  const { showToast } = useOptionalToast();
  const openModal = useOpenModal();
  const [open, setOpen] = useState(false);
  // Cards on screen while the panel is open: kept after they're answered, so
  // you see what you did rather than have it vanish under the pointer.
  const [keep, setKeep] = useState<Set<string>>(() => new Set());
  const [keepAgents, setKeepAgents] = useState<Set<string>>(() => new Set());
  // Answered here, before the store's line catches up.
  const [answered, setAnswered] = useState<Map<string, AgentMessage>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // "Allow all" asked, waiting on its confirm line: whose cards, and which.
  const [confirming, setConfirming] = useState<{
    agentId?: string;
    targets: { asker: Agent; message: AgentMessage }[];
  } | null>(null);
  const [allowingAll, setAllowingAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Read from the store here, so the chat around it doesn't re-render for
  // every other agent's status; this re-renders only when who's asking changes.
  const asking = useAgentsSelector(
    (s) =>
      s.agents.filter(
        (a) =>
          a.id !== agent.id &&
          !a.hidden &&
          (agent.isMain || peerIds.has(a.id) || askers?.has(a.id)) &&
          (needsYou(a) || keepAgents.has(a.id))
      ),
    sameAgents
  );
  const messages = useAgentsSelector((s) => s.messages);
  // In the Chief's chat the number is the team's, the one every other surface
  // shows (the Chief included); elsewhere the bar counts only this chat's peers.
  const setupView = useTeamSetup();
  const team = useAgentsSelector((s) =>
    agent.isMain ? countNeedsYou(s.agents, setupView) : undefined
  );
  // Their cards are in their own chats: read each once.
  const unloaded = asking
    .filter((a) => !messages[a.id])
    .map((a) => a.id)
    .join(' ');
  useEffect(() => {
    for (const id of unloaded.split(' ').filter(Boolean)) void loadMessages(id);
  }, [unloaded]);

  const lines = useMemo(() => {
    if (answered.size === 0) return messages;
    const out: Record<string, AgentMessage[] | undefined> = {};
    for (const a of asking) {
      out[a.id] = messages[a.id]?.map((m) => answered.get(m.id) ?? m);
    }
    return out;
  }, [messages, answered, asking]);
  // Agents still being set up after an import: their requests are the
  // checklist's, counted here only to point at it.
  const setupIds = setup?.agentIds;
  const [summary, inSetup] = useMemo(() => {
    const own = setupIds ? asking.filter((a) => !setupIds.has(a.id)) : asking;
    const theirs = setupIds ? asking.filter((a) => setupIds.has(a.id)) : [];
    return [
      groupRequests(own, lines, shownRequestIds, keep),
      theirs.length > 0 ? groupRequests(theirs, lines, shownRequestIds).requests : 0,
    ] as const;
  }, [asking, setupIds, lines, shownRequestIds, keep]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setConfirming(null);
    setKeep(new Set());
    setKeepAgents(new Set());
    setAnswered(new Map());
    if (restoreFocus) reviewRef.current?.focus();
  }, []);

  const openedByPointer = useRef(false);
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    if (open) {
      close(true);
      return;
    }
    // Two agents open at once; more start folded, so the whole list is in
    // view first and you pick who to answer.
    const groups = summary.groups;
    setExpanded(new Set(groups.length <= OPEN_ALL_UP_TO ? groups.map((g) => g.agent.id) : []));
    // What shows now is kept until the panel closes, so a card answered here
    // (a login saved, too) stays to say what it resolved to.
    setKeep(new Set(groups.flatMap((g) => g.cards.map((m) => m.id))));
    setKeepAgents(new Set(groups.map((g) => g.agent.id)));
    openedByPointer.current = e.detail > 0;
    setOpen(true);
  };

  // A click anywhere else closes it without pulling focus back (you've put
  // it where you clicked). A card's own menus are portalled; they're inside.
  useClickOutside(rootRef, () => close(false), open, '.ss-dropdown__menu, .ss-context-menu');

  // Focus moves into the panel when it opens: from the keyboard, to the first
  // agent; from a click, to the panel itself, so nothing looks chosen yet.
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    if (openedByPointer.current) panelRef.current?.focus();
    else rootRef.current?.querySelector<HTMLElement>(TOGGLE)?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    const target = e.target as HTMLElement;
    if (!target.matches(TOGGLE)) return;
    const toggles = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(TOGGLE) ?? []);
    const i = toggles.indexOf(target);
    const to =
      e.key === 'ArrowDown'
        ? toggles[i + 1]
        : e.key === 'ArrowUp'
          ? toggles[i - 1]
          : e.key === 'Home'
            ? toggles[0]
            : e.key === 'End'
              ? toggles[toggles.length - 1]
              : undefined;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  };

  /** After answering, focus moves to the next Allow, else the next agent. */
  const focusNext = (from: Element | null) => {
    const root = rootRef.current;
    if (!root) return;
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>(`[data-allow]:not(:disabled), ${TOGGLE}`)
    );
    const after = from
      ? targets.find((t) => from.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)
      : undefined;
    (after ?? reviewRef.current)?.focus({ preventScroll: false });
  };

  const answer = async (
    asker: Agent,
    m: AgentMessage,
    allow: boolean,
    always?: boolean,
    note?: string,
    choice?: number
  ) => {
    const approval = m.approval!;
    const card = rootRef.current?.querySelector(`[data-message-ids~="${CSS.escape(m.id)}"]`);
    try {
      await answerApproval(asker.id, approval.requestId, allow, always, note, choice);
    } catch (error) {
      showToast(formatCommandError(asCommandError(error)), 'error');
      return;
    }
    markAnswered(m, allow, always, note, choice);
    requestAnimationFrame(() => focusNext(card ?? null));
  };

  const markAnswered = (
    m: AgentMessage,
    allow: boolean,
    always?: boolean,
    note?: string,
    choice?: number
  ) => {
    const approval = m.approval!;
    setAnswered((current) =>
      new Map(current).set(m.id, {
        ...m,
        approval: {
          ...approval,
          status: allow ? 'allowed' : 'denied',
          alwaysAllowed: always && allow ? true : approval.alwaysAllowed,
          note: allow ? undefined : note?.trim() || undefined,
          ...(approval.prompt && promptAnswer(approval.prompt, allow, choice)),
        },
      })
    );
  };

  /** "Allow all" (every agent's, or one agent's): its confirm line first. */
  const askAllowAll = (groups: RequestGroup[], agentId?: string) => {
    const targets = groups.flatMap((g) =>
      allowAllCards(g.cards).map((message) => ({ asker: g.agent, message }))
    );
    if (targets.length > 0) setConfirming({ agentId, targets });
  };

  /** Answer each card on the confirm line with Allow, one after another. */
  const allowAll = async () => {
    if (!confirming) return;
    setAllowingAll(true);
    let failed = 0;
    for (const { asker, message } of confirming.targets) {
      try {
        await answerApproval(asker.id, message.approval!.requestId, true);
        markAnswered(message, true);
      } catch {
        failed += 1;
      }
    }
    setAllowingAll(false);
    setConfirming(null);
    if (failed > 0) {
      showToast(
        failed === 1
          ? "One request couldn't be allowed. It's still waiting."
          : `${failed} requests couldn't be allowed. They're still waiting.`,
        'error'
      );
    }
    requestAnimationFrame(() => reviewRef.current?.focus());
  };
  const allowable = allowAllCards(summary.groups.flatMap((g) => g.cards)).length;

  if (!open && summary.requests === 0) return null;
  return (
    <div
      className="agent-requests"
      ref={rootRef}
      data-open={open || undefined}
      onKeyDown={open ? onKeyDown : undefined}
    >
      {open && (
        <section
          id={panelId}
          ref={panelRef}
          tabIndex={-1}
          className="agent-requests-panel"
          role="region"
          aria-label="Requests from other agents"
        >
          <div className="agent-requests-panel__list">
            {summary.groups.map((group) => (
              <Group
                key={group.agent.id}
                group={group}
                expanded={expanded.has(group.agent.id)}
                onToggle={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.agent.id)) next.delete(group.agent.id);
                    else next.add(group.agent.id);
                    return next;
                  })
                }
                onOpenChat={() => {
                  close(false);
                  onOpenAgent(group.agent.id);
                }}
                onAllowAll={
                  !confirming && allowAllCards(group.cards).length > 1
                    ? () => askAllowAll([group], group.agent.id)
                    : undefined
                }
                onAnswer={(m, allow, always, note, choice) =>
                  answer(group.agent, m, allow, always, note, choice)
                }
              />
            ))}
            {setup && inSetup > 0 && (
              <p className="agent-requests-panel__older" data-testid="agent-requests-in-setup">
                {inSetup === 1
                  ? 'One more is from the agents you imported.'
                  : 'A few more are from the agents you imported.'}{' '}
                <TextButton
                  tabIndex={0}
                  onClick={() => {
                    close(false);
                    setup.onOpen();
                  }}
                >
                  Open setting up your team
                </TextButton>
              </p>
            )}
          </div>
          {/* Allow all's confirm line sits right above the bar whose button asked it. */}
          {confirming && (
            <div
              className="agent-requests-panel__confirm"
              role="group"
              aria-label="Allow all"
              data-testid="agent-requests-allow-all-confirm"
            >
              <p className="agent-requests-panel__confirm-line">
                {confirming.agentId
                  ? `${confirming.targets[0].asker.name}: ${allowAllLine(confirming.targets.map((t) => t.message))}`
                  : allowAllLine(confirming.targets.map((t) => t.message))}
              </p>
              <Button
                tabIndex={0}
                size="compact"
                variant="ghost"
                disabled={allowingAll}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
              <Button
                tabIndex={0}
                size="compact"
                variant="strong"
                disabled={allowingAll}
                onClick={() => void allowAll()}
              >
                Allow all
              </Button>
            </div>
          )}
        </section>
      )}
      <ConversationBar
        state={summary.requests > 0 ? 'waiting' : 'info'}
        data-testid="agent-requests-bar"
        title={requestsTitle(summary, team)}
        detail={requestsDetail(summary)}
        actions={
          <>
            {open && allowable > 1 && !confirming && (
              <Button
                tabIndex={0}
                size="compact"
                variant="ghost"
                data-testid="agent-requests-allow-all"
                onClick={() => askAllowAll(summary.groups)}
              >
                Allow all
              </Button>
            )}
            {!open && summary.logins > 1 && (
              <Button
                tabIndex={0}
                size="compact"
                variant="ghost"
                className="agent-requests__logins"
                data-testid="agent-requests-logins"
                onClick={() => {
                  close(false);
                  openModal('teamLogins');
                }}
              >
                Logins by app
              </Button>
            )}
            <Button
              ref={reviewRef}
              tabIndex={0}
              size="compact"
              variant="secondary"
              className="agent-requests__review"
              aria-expanded={open}
              aria-controls={open ? panelId : undefined}
              onClick={toggle}
            >
              {open ? 'Done' : 'Review'}
            </Button>
          </>
        }
      />
    </div>
  );
}

function Group({
  group,
  expanded,
  onToggle,
  onOpenChat,
  onAllowAll,
  onAnswer,
}: {
  group: RequestGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpenChat: () => void;
  /** "Allow all" for this agent's cards, when it has more than one. */
  onAllowAll?: () => void;
  onAnswer: (
    m: AgentMessage,
    allow: boolean,
    always?: boolean,
    note?: string,
    choice?: number
  ) => Promise<void>;
}) {
  const { agent, cards, older } = group;
  const cardsId = useId();
  const waiting = group.pending + older > 0;
  return (
    <div
      className="agent-requests-panel__group"
      data-color={agent.color}
      data-colorway={agentColorway(agent)}
    >
      <div className="agent-requests-panel__row">
        <button
          type="button"
          tabIndex={0}
          className="agent-requests-panel__toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? cardsId : undefined}
          onClick={onToggle}
        >
          <AgentKey id={agent.id} name={agent.name} color={agent.color} size="md" />
          <span className="agent-requests-panel__text">
            <span className="agent-requests-panel__name">{agent.name}</span>
            <span className="agent-requests-panel__line" data-state={waiting ? 'waiting' : 'done'}>
              {groupLine(group)}
            </span>
          </span>
          <ChevronRightIcon size={12} className="agent-requests-panel__chevron" />
        </button>
        {onAllowAll && (
          <TextButton
            tabIndex={0}
            className="agent-requests-panel__open"
            data-testid="agent-requests-group-allow-all"
            onClick={onAllowAll}
          >
            Allow all
          </TextButton>
        )}
        <TextButton tabIndex={0} className="agent-requests-panel__open" onClick={onOpenChat}>
          Open chat
        </TextButton>
      </div>
      {expanded && (
        <div id={cardsId} className="agent-requests-panel__cards">
          {cards.map((m) => (
            <ApprovalCard
              key={m.id}
              message={m}
              agentName={agent.name}
              paused={agent.status.state === 'idle'}
              compact
              arrived={false}
              onAnswer={(_requestId, allow, always, note, choice) =>
                onAnswer(m, allow, always, note, choice)
              }
            />
          ))}
          {older > 0 && (
            <p className="agent-requests-panel__older">
              {older === 1
                ? '1 more is further back in its chat.'
                : `${older} more are further back in its chat.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
