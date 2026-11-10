/**
 * What's in flight across every agent, in one calm column. Reached from ⌘K
 * ("What's in flight") and, while anything waits on you, the "Needs you · N"
 * row at the top of the agent list. Grouped as Needs you, Working and Done
 * recently (with Paused and Scheduled next between), one line per agent:
 * "Hiring · Send an email · 2m ago". Under Needs you a row folds its cards
 * (answerable here) or a failed turn's next step behind a chevron, in the
 * review panel's words; with one or two agents waiting they start open, so
 * the action is right there, and sixteen are sixteen lines, not a wall.
 * "Open chat" opens the conversation; other rows open it (a reply, at that line).
 *
 * Everything comes from the store: statuses and check-ins from the registry,
 * cards and replies from each chat's recent lines. A chat that's open this
 * session is already live in the store; for the rest this reads the last
 * few lines, again whenever that agent's row changes. Nothing is inferred.
 *
 * Rooms: a card or reply said in a room says which room ("in Pricing
 * launch"), is answered here like any other, and its row opens the room. A
 * card waiting in a room is also read from the room's own thread, so it is
 * here even when the agent's own recent lines don't reach it.
 *
 * @module components/agents/AgentsTeamView
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRightIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { StatusPill } from '../primitives/StatusPill';
import { AgentKey } from './AgentKey';
import { AgentsBoard } from './AgentsBoard';
import { AgentWorkingLine } from './AgentWorkingLine';
import { AgentEngineBadge } from './AgentEngine';
import { ApprovalCard, ErrorLine } from './AgentChatItems';
import { AgentMark } from './AgentSwitcher';
import { AgentsPageHeader, type AgentsPageCompact } from './AgentsPageHeader';
import { useHeightReveal, useNewKeys } from './useAgentMotion';
import {
  answerApproval,
  CONTINUE_TEXT,
  promptAnswer,
  createCheckIn,
  failedTurn,
  failurePill,
  type StatusTone,
  formatWhen,
  getAgentMessages,
  lastUserMessage,
  needsAttention,
  needsYou,
  replyPreview,
  resendable,
  retryNote,
  sendAgentMessage,
  summarizeTeam,
  TEAM_ID,
  whenAt,
  type Agent,
  type AgentEngine,
  type AgentMessage,
  agentKeyState,
} from '../../lib/agents';
import { refreshAgents, upsertMessage, useAgentsSelector } from '../../lib/agentsStore';
import { getRoomMessages, roomKey, type Room } from '../../lib/agentRooms';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';
import { AgentsStayOnNote } from './AgentsStayOn';
import { AgentsQuota } from './AgentsQuota';
import { AgentsSpareNote } from './AgentsUsage';
import { kbd } from '../../lib/shortcuts';
import { cardsGroup, groupLine, newestCardAt } from '../../lib/agentRequests';
import { formatAgo } from '../../lib/formatAgo';
import { previewText } from '../../../packages/companion-protocol/src/preview';
import {
  progressLine,
  resumeTeamSetup,
  SETUP_TITLE,
  useResumableTeamSetup,
} from '../../lib/teamSetup';

/** Lines read per chat: enough for its latest reply. A chat with a card open reads a page. */
const RECENT_LINES = 20;
/** What a chat with a card open reads, to find its pending cards. */
const CARD_LINES = 400;

/**
 * The recent lines of every chat that isn't loaded in the store, refetched
 * when its row says something happened there.
 */
function useRecentLines(agents: Agent[], loaded: Record<string, AgentMessage[]>) {
  const [fetched, setFetched] = useState<Record<string, { key: string; lines: AgentMessage[] }>>(
    {}
  );
  const wanted = agents
    .filter((a) => !a.hidden && !loaded[a.id])
    .map((a) => ({
      id: a.id,
      key: `${a.lastActivityAt}:${a.pendingApprovals}:${a.failure?.kind ?? ''}`,
      cards: a.pendingApprovals > 0,
    }));
  const signature = wanted.map((w) => `${w.id}@${w.key}`).join(' ');

  useEffect(() => {
    let live = true;
    for (const w of wanted) {
      if (fetched[w.id]?.key === w.key) continue;
      getAgentMessages(w.id, w.cards ? CARD_LINES : RECENT_LINES)
        .then((lines) => {
          if (live) setFetched((current) => ({ ...current, [w.id]: { key: w.key, lines } }));
        })
        .catch(() => {
          /* that chat just doesn't contribute; its row still opens it */
        });
    }
    return () => {
      live = false;
    };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const merged: Record<string, AgentMessage[]> = {};
    for (const [id, entry] of Object.entries(fetched)) merged[id] = entry.lines;
    return { ...merged, ...loaded };
  }, [fetched, loaded]);
}

/**
 * Cards waiting in rooms, read from each room's own thread while one of its
 * members is waiting on you there; refetched when that member's row changes.
 */
function useRoomCards(agents: Agent[], rooms: Room[], loaded: Record<string, AgentMessage[]>) {
  const [fetched, setFetched] = useState<Record<string, { key: string; lines: AgentMessage[] }>>(
    {}
  );
  const wanted = rooms
    .map((room) => {
      const asking = agents.filter(
        (a) => !a.hidden && room.members.includes(a.id) && needsYou(a) && a.status.room === room.id
      );
      return {
        id: room.id,
        key: asking.map((a) => `${a.id}:${a.lastActivityAt}:${a.pendingApprovals}`).join(' '),
        live: Boolean(loaded[roomKey(room.id)]),
      };
    })
    .filter((w) => w.key);
  const signature = wanted.map((w) => `${w.id}@${w.key}`).join(' ');

  useEffect(() => {
    let live = true;
    for (const w of wanted) {
      if (w.live || fetched[w.id]?.key === w.key) continue;
      getRoomMessages(w.id, CARD_LINES)
        .then((lines) => {
          if (live) setFetched((current) => ({ ...current, [w.id]: { key: w.key, lines } }));
        })
        .catch(() => {
          /* that room just doesn't contribute; its member's own lines still do */
        });
    }
    return () => {
      live = false;
    };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  // A few rooms' lines at most: cheap enough to read on every render.
  const byAgent = new Map<string, AgentMessage[]>();
  for (const w of wanted) {
    const lines = loaded[roomKey(w.id)] ?? fetched[w.id]?.lines ?? [];
    for (const m of lines) {
      if (m.approval?.status !== 'pending' || !m.agentId) continue;
      byAgent.set(m.agentId, [...(byAgent.get(m.agentId) ?? []), { ...m, room: w.id }]);
    }
  }
  return byAgent;
}

function Section({
  title,
  count,
  hint,
  empty,
  quiet,
  lead,
  children,
}: {
  title: string;
  /** Needs you: the page's first and loudest heading. */
  lead?: boolean;
  /** How many are in it, said beside the heading (never for a section that lists a sample). */
  count?: number;
  /** A key that gets you there faster: on hover, not on the page (it read as a dev keymap). */
  hint?: string;
  empty: string;
  /** The rest of the team: a quieter heading. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const filled = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section
      className={`agents-team__section${quiet ? ' agents-team__section--quiet' : ''}${
        lead ? ' agents-team__section--first' : ''
      }`}
      aria-label={count !== undefined ? `${title}, ${count}` : title}
      data-filled={filled || undefined}
    >
      <h3 className="agents-team__heading" title={hint}>
        {title}
        {count !== undefined && count > 0 && (
          <span className="agents-team__count" aria-hidden="true">
            · {count}
          </span>
        )}
      </h3>
      {filled ? children : <p className="agents-team__empty">{empty}</p>}
    </section>
  );
}

interface RowProps {
  agent: Agent;
  /** Said in a room: its name, after the agent's ("in Pricing launch"). */
  place?: string;
  line: ReactNode;
  meta?: ReactNode;
  state?: 'working' | 'waiting' | 'failed' | 'limited';
  /** Mid-turn: its avatar looks around, and presses once when the turn ends. */
  working?: boolean;
  onOpen: () => void;
  /** A row that folds what's under it: its chevron, and whether it's open. */
  fold?: { expanded: boolean; controls: string };
  /** Its state as a pill before the line: the row's one coloured thing. */
  pill?: { tone: StatusTone; label: string };
  /** Joined its section while the view was open: it rises in once. */
  arrived?: boolean;
  /** Its key's size: Needs you's rows carry the larger one. */
  keySize?: 'lg' | 'md';
  /** Not read yet: the row's ink, as in the sidebar (and said to a screen reader). */
  unread?: boolean;
}

/**
 * One line per agent: "Hiring · Send an email · 2m ago". The name, then what
 * it's about (it gives way first), then the time or a mark at the right.
 */
function Row({
  agent,
  place,
  line,
  meta,
  state,
  working,
  onOpen,
  fold,
  pill,
  arrived,
  keySize = 'md',
  unread,
}: RowProps) {
  return (
    <button
      type="button"
      tabIndex={0}
      data-arrived={arrived || undefined}
      data-board-nav=""
      data-unread={unread || undefined}
      className="agents-team__row"
      onClick={onOpen}
      aria-expanded={fold?.expanded}
      aria-controls={fold?.expanded ? fold.controls : undefined}
    >
      <AgentKey
        id={agent.id}
        name={agent.name}
        color={agent.color}
        state={agentKeyState(agent, Boolean(working))}
        size={keySize}
      />
      <span className="agents-team__text">
        <span className="agents-team__name">
          <span className="agents-team__name-text">{agent.name}</span>
          {place && <span className="agents-team__place">in {place}</span>}
          <AgentEngineBadge engine={agent.engine} />
        </span>
        {pill && (
          <StatusPill tone={pill.tone} className="agents-team__pill">
            {pill.label}
          </StatusPill>
        )}
        {(line || !pill) && (
          <span
            className={`agents-team__line${pill ? ' agents-team__line--after-pill' : ''}`}
            data-state={pill ? undefined : state}
          >
            {line}
          </span>
        )}
      </span>
      {unread && <span className="sr-only">Unread.</span>}
      {meta && <span className="agents-team__meta">{meta}</span>}
      {fold && <ChevronRightIcon size={12} className="agents-team__chevron" />}
    </button>
  );
}

/**
 * The first agents needing you open with their cards in view, so the answer
 * is right there; the rest wait as one line each, in the order they asked,
 * and the next opens as one is answered. Five open cards were a screen and a
 * half: Working and Finished fell below the fold, and so did the queue.
 */
const OPEN_FIRST = 2;
/** Cards shown under an open row before "Show N more": the first is what it's waiting on. */
const CARDS_SHOWN = 2;
/** Routines listed under Coming up; the rest are in Routines. */
const COMING_UP_MAX = 3;

/**
 * A line without its agent's name at the front: under that agent's own row,
 * "Finance needs you in its browser: …" reads "Needs you in its browser: …".
 */
export function withoutName(line: string, name: string): string {
  if (!name || !line.startsWith(`${name} `)) return line;
  const rest = line.slice(name.length + 1);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Opens and closes its height with the chat's motion (see useHeightReveal). */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useHeightReveal(ref, open);
  return shown ? (
    <div ref={ref} className="agents-team__fold">
      {children}
    </div>
  ) : null;
}

/** How long an answered card shows what it resolved to before it folds away. */
const ANSWERED_HOLD_MS = 1200;
/** Then the fold's own motion; after it the card is forgotten. */
const FOLD_MS = 700;

/** A card answered here, kept on screen (resolved) for a beat so you see what you did. */
interface Held {
  agentId: string;
  message: AgentMessage;
  folding: boolean;
}

interface AgentsTeamViewProps {
  onOpenAgent: (agentId: string) => void;
  /** Open a chat at one of its lines. */
  onOpenMessage: (agentId: string, messageId: string, conversation?: string) => void;
  /** Sign the agent's engine back in. */
  onSignIn: (engine: AgentEngine) => void;
  /** Its engine isn't on this Mac: install it again. */
  onInstallEngine?: (engine: AgentEngine) => void;
  /** Below the compact breakpoint there's no sidebar; the header switches agents. */
  compact?: AgentsPageCompact;
  /** The board's empty socket: make a new agent. */
  onNewAgent?: () => void;
  /** Stop a working agent's turn (the view's owner confirms first). */
  onStop?: (agent: Agent) => void;
}

export function AgentsTeamView({
  onOpenAgent,
  onOpenMessage,
  onSignIn,
  onInstallEngine,
  compact,
  onNewAgent,
  onStop,
}: AgentsTeamViewProps) {
  const agents = useAgentsSelector((s) => s.agents);
  const rooms = useAgentsSelector((s) => s.rooms);
  const messages = useAgentsSelector((s) => s.messages);
  const roomCards = useRoomCards(agents, rooms, messages);
  const roomName = (id: string | undefined) =>
    id ? rooms.find((r) => r.id === id)?.name : undefined;
  /** Where a line was said: its room when it was said in one, else the agent's chat. */
  const openWhere = (
    agent: Agent,
    room: string | undefined,
    messageId?: string,
    conversation?: string
  ) => {
    if (room && roomName(room)) onOpenAgent(roomKey(room));
    else if (messageId) onOpenMessage(agent.id, messageId, conversation);
    else onOpenAgent(agent.id);
  };
  const { showToast } = useOptionalToast();
  const lines = useRecentLines(agents, messages);
  const team = useMemo(() => summarizeTeam(agents, lines), [agents, lines]);
  const columnRef = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Record<string, Held>>({});
  // Rows you opened or closed; the rest follow the count (see OPEN_FIRST).
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // Agents whose every card is shown, past the first CARDS_SHOWN.
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const toastError = (error: unknown) =>
    showToast(formatCommandError(asCommandError(error)), 'error');

  /** After answering, focus moves on to the next card's Allow, or the next row. */
  const focusNext = (from: HTMLElement | null) => {
    const column = columnRef.current;
    if (!column) return;
    const targets = Array.from(
      column.querySelectorAll<HTMLElement>('[data-allow]:not(:disabled), .agents-team__row')
    );
    const after = from
      ? targets.find((t) => from.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)
      : undefined;
    (after ?? targets[0])?.focus({ preventScroll: false });
  };

  const answer = async (
    agent: Agent,
    message: AgentMessage,
    allow: boolean,
    always?: boolean,
    note?: string,
    choice?: number
  ) => {
    const approval = message.approval;
    if (!approval) return;
    const card = columnRef.current?.querySelector<HTMLElement>(
      `[data-message-ids~="${CSS.escape(message.id)}"]`
    );
    try {
      await answerApproval(agent.id, approval.requestId, allow, always, note, choice);
    } catch (error) {
      toastError(error);
      return;
    }
    const resolved: AgentMessage = {
      ...message,
      approval: {
        ...approval,
        status: allow ? 'allowed' : 'denied',
        alwaysAllowed: always && allow ? true : approval.alwaysAllowed,
        note: allow ? undefined : note?.trim() || undefined,
        ...(approval.prompt && promptAnswer(approval.prompt, allow, choice)),
      },
    };
    setHeld((h) => ({
      ...h,
      [message.id]: { agentId: agent.id, message: resolved, folding: false },
    }));
    requestAnimationFrame(() => focusNext(card ?? null));
    timers.current.push(
      window.setTimeout(
        () =>
          setHeld((h) =>
            h[message.id] ? { ...h, [message.id]: { ...h[message.id], folding: true } } : h
          ),
        ANSWERED_HOLD_MS
      ),
      window.setTimeout(
        () =>
          setHeld((h) => {
            const { [message.id]: _gone, ...rest } = h;
            return rest;
          }),
        ANSWERED_HOLD_MS + FOLD_MS
      )
    );
  };

  const retry = async (agent: Agent, failure: AgentMessage) => {
    // Cut off part-way: Continue carries on in the same conversation, never
    // the request again (that could do the work twice), as in the chat.
    if (failure.failure?.kind === 'interrupted') {
      try {
        upsertMessage(await sendAgentMessage(agent.id, CONTINUE_TEXT, [], []));
      } catch (error) {
        toastError(error);
      }
      return;
    }
    const chat = lines[agent.id] ?? [];
    const source = lastUserMessage(chat, chat.indexOf(failure));
    if (!source) return;
    try {
      const ids = (source.mentions ?? []).map((m) => m.id);
      upsertMessage(await sendAgentMessage(agent.id, source.text, resendable(agent, source), ids));
    } catch (error) {
      toastError(error);
    }
  };

  const retryAt = async (agent: Agent, failure: AgentMessage, at: number) => {
    const chat = lines[agent.id] ?? [];
    const source = lastUserMessage(chat, chat.indexOf(failure));
    try {
      await createCheckIn(agent.id, whenAt(at), retryNote(source?.text ?? ''));
      await refreshAgents();
    } catch (error) {
      toastError(error);
    }
  };

  // "Setting up your team": one row for it, and its logins aren't listed
  // again agent by agent under Needs your OK.
  const setup = useResumableTeamSetup();
  const setupLogins = useMemo(
    () => new Set((setup?.steps ?? []).flatMap((s) => (s.logins ?? []).map((l) => l.requestId))),
    [setup]
  );
  const chief = agents.find((a) => a.isMain);

  // Needs you, with the cards waiting in rooms and those just answered here
  // still in their places.
  const groups = useMemo(() => {
    const byAgent = new Map(
      team.needsYou.flatMap((g) => {
        const approvals = g.approvals.filter(
          (m) => !m.approval || !setupLogins.has(m.approval.requestId)
        );
        // Only logins the checklist holds: the agent isn't listed here.
        if (approvals.length === 0 && g.approvals.length > 0 && !g.failure) return [];
        return [[g.agent.id, { ...g, approvals }] as [string, typeof g]];
      })
    );
    for (const [agentId, cards] of roomCards) {
      const group = byAgent.get(agentId);
      if (!group) continue;
      const known = new Set(group.approvals.map((m) => m.id));
      group.approvals = [...group.approvals, ...cards.filter((m) => !known.has(m.id))].sort(
        (a, b) => a.ts - b.ts
      );
    }
    for (const h of Object.values(held)) {
      const agent = agents.find((a) => a.id === h.agentId);
      if (!agent) continue;
      const group = byAgent.get(agent.id) ?? { agent, approvals: [], failure: null };
      group.approvals = [...group.approvals.filter((m) => m.id !== h.message.id), h.message].sort(
        (a, b) => a.ts - b.ts
      );
      byAgent.set(agent.id, group);
    }
    return [...byAgent.values()];
  }, [team.needsYou, held, agents, roomCards, setupLogins]);

  // Rows that join a section while this view is open rise in once; what was
  // there when it opened holds still. Replies load after the view mounts, so
  // their first fill is a load (`ready` once there are some), not arrivals.
  const isNewRow = useNewKeys(
    useMemo(
      () => [
        ...groups.map((g) => `needs:${g.agent.id}`),
        ...team.working.map((a) => `working:${a.id}`),
      ],
      [groups, team]
    )
  );
  const isNewReply = useNewKeys(
    useMemo(() => team.replies.map((r) => r.message.id), [team]),
    team.replies.length > 0
  );

  // Finished and not read yet: each agent's newest reply, by its result
  // card's title when it shared one. An agent still needing you or working
  // is said in its own section, never twice.
  const finished = useMemo(() => {
    const inNeeds = new Set(groups.map((g) => g.agent.id));
    return agents
      .filter(
        (a) =>
          !a.hidden &&
          a.unread > 0 &&
          !inNeeds.has(a.id) &&
          !needsAttention(a) &&
          a.status.state !== 'working'
      )
      .map((agent) => {
        const chat = lines[agent.id] ?? [];
        let reply: AgentMessage | undefined;
        for (let i = chat.length - 1; i >= 0; i--) {
          const m = chat[i];
          if (m.kind === 'agent' && (m.text.trim() || m.result)) {
            reply = m;
            break;
          }
        }
        return { agent, reply };
      })
      .sort(
        (a, b) =>
          (b.reply?.ts ?? b.agent.lastActivityAt ?? 0) -
          (a.reply?.ts ?? a.agent.lastActivityAt ?? 0)
      );
  }, [agents, groups, lines]);

  // Everyone the sections above don't name: the quiet grid.
  const rest = useMemo(() => {
    const named = new Set([
      ...groups.map((g) => g.agent.id),
      ...team.working.map((a) => a.id),
      ...finished.map((f) => f.agent.id),
      ...team.paused.map((p) => p.agent.id),
    ]);
    return agents.filter((a) => !a.hidden && !named.has(a.id));
  }, [agents, groups, team.working, team.paused, finished]);

  /**
   * Arrows move between the board's rows and keys (Tab still reaches every
   * button on a card). Never j/k: a letter is an agent's own key.
   */
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const from = e.target as HTMLElement;
    if (
      from.closest(
        'input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]'
      )
    )
      return;
    const column = columnRef.current;
    if (!column) return;
    const next = boardNavTarget(column, from, e.key);
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  };

  return (
    <section className="agent-chat agents-team" aria-label="What’s in flight">
      <AgentsPageHeader
        name="What’s in flight"
        icon="people"
        pageId={TEAM_ID}
        compact={compact}
        onOpenAgent={onOpenAgent}
      />

      <div
        className="agent-chat__scroll"
        tabIndex={0}
        role="region"
        aria-label="Everything in flight, by agent"
      >
        {/* Arrows between the buttons inside; each is its own control. */}
        <div
          className="agents-team__column"
          ref={columnRef}
          onKeyDown={onNavKey}
          role="none"
          aria-describedby="agents-team-keys"
        >
          <p id="agents-team-keys" className="sr-only">
            Arrow keys move between agents; Tab reaches each card’s answers.
          </p>
          {setup && chief && (
            <button
              type="button"
              tabIndex={0}
              data-board-nav=""
              className="agents-team__row agents-team__setup"
              data-testid="agents-team-setup"
              onClick={() => {
                resumeTeamSetup()
                  .then(() => onOpenAgent(chief.id))
                  .catch(toastError);
              }}
            >
              <AgentKey id={chief.id} name={chief.name} color={chief.color} size="md" />
              <span className="agents-team__text">
                <span className="agents-team__name">
                  <span className="agents-team__name-text">{SETUP_TITLE}</span>
                </span>
                <span className="agents-team__line">
                  {progressLine(setup)} · in {chief.name}’s chat
                </span>
              </span>
            </button>
          )}
          <Section
            title="Needs you"
            count={groups.filter((g) => needsAttention(g.agent)).length}
            hint={
              groups.length > 0
                ? `${kbd('mod', 'J')} opens the next agent that needs your OK`
                : undefined
            }
            empty="Nothing needs you"
            lead
          >
            {groups.map(({ agent, approvals, failure }, place) => {
              const kind = failedTurn(agent);
              const pending = approvals.some((m) => m.approval?.status === 'pending');
              // The room the card waits in: the card's own tag, else where the turn is.
              const room =
                approvals.find((m) => m.approval?.status === 'pending')?.room ??
                (needsYou(agent) ? agent.status.room : undefined);
              // The group folds with its last answered card, rather than vanish after it.
              const stays =
                pending ||
                Boolean(failure && kind) ||
                approvals.some((m) => held[m.id] && !held[m.id].folding) ||
                // Waiting on a card whose line hasn't loaded yet: the row alone.
                (needsYou(agent) && !approvals.some((m) => held[m.id]));
              // One line: what it's about, in the review panel's words, and when.
              const asked = cardsGroup(agent, approvals);
              const open = asked.pending + asked.older;
              const failed =
                !pending && kind
                  ? failurePill(kind, previewText(agent.preview), agent.engine)
                  : null;
              const waiting = pending || needsYou(agent);
              // Something to open under the row: its cards, or the failure's next step.
              const foldable = approvals.length > 0 || Boolean(failure && kind && !pending);
              const expanded = foldable && (opened[agent.id] ?? place < OPEN_FIRST);
              const said = failed
                ? failed.rest
                : open > 0
                  ? groupLine(asked)
                  : waiting
                    ? (previewText(agent.preview)?.replace(/^Needs your OK:\s*/, '') ?? '')
                    : 'Answered';
              // Its own failure's card says the sentence in full: the row needn't too.
              const line = withoutName(failed && expanded && failure ? '' : said, agent.name);
              // Under Needs you the heading already says it: a pill only for
              // what isn't a request (a turn that didn't finish).
              const pill = failed ? { tone: failed.tone, label: failed.label } : undefined;
              const at = newestCardAt(approvals) ?? (kind ? failure?.ts : undefined);
              const cardsId = `agents-team-cards-${agent.id}`;
              const shownCards = showAll[agent.id]
                ? approvals
                : approvals.filter((m, i) => i < CARDS_SHOWN || held[m.id]);
              const more = approvals.length - shownCards.length;
              return (
                <Fold key={agent.id} open={stays}>
                  <div
                    className="agents-team__group agents-team__ask"
                    data-arrived={isNewRow(`needs:${agent.id}`) || undefined}
                    data-expanded={expanded || undefined}
                  >
                    <div className="agents-team__head">
                      <Row
                        agent={agent}
                        place={roomName(room)}
                        line={line}
                        pill={pill}
                        state={
                          pending || needsYou(agent)
                            ? 'waiting'
                            : kind
                              ? kind.kind === 'usage_limit'
                                ? 'limited'
                                : 'failed'
                              : undefined
                        }
                        meta={at ? formatAgo(at) : <AgentMark agent={agent} />}
                        fold={foldable ? { expanded, controls: cardsId } : undefined}
                        onOpen={() =>
                          foldable
                            ? setOpened((o) => ({ ...o, [agent.id]: !expanded }))
                            : openWhere(agent, room)
                        }
                      />
                      <TextButton
                        tabIndex={0}
                        className="agents-team__open"
                        onClick={() => openWhere(agent, room)}
                        aria-label={`Open ${agent.name}’s chat`}
                      >
                        Open chat
                      </TextButton>
                    </div>
                    {expanded && (
                      <div id={cardsId} className="agents-team__cards">
                        {shownCards.map((m) => (
                          <Fold key={m.id} open={!held[m.id]?.folding}>
                            <ApprovalCard
                              message={m}
                              agentName={agent.name}
                              paused={agent.status.state === 'idle'}
                              compact
                              onAnswer={(_requestId, allow, always, note, choice) =>
                                answer(agent, m, allow, always, note, choice)
                              }
                              arrived={false}
                            />
                          </Fold>
                        ))}
                        {more > 0 && (
                          <TextButton
                            className="agents-team__more"
                            onClick={() => setShowAll((o) => ({ ...o, [agent.id]: true }))}
                          >
                            {`Show ${more} more`}
                          </TextButton>
                        )}
                        {failure && kind && !pending && (
                          <ErrorLine
                            message={failure}
                            engine={agent.engine}
                            onSignIn={() => onSignIn(agent.engine)}
                            onInstall={
                              onInstallEngine ? () => onInstallEngine(agent.engine) : undefined
                            }
                            onRetry={() => void retry(agent, failure)}
                            onRetryAt={(at) => void retryAt(agent, failure, at)}
                            retryScheduled={(agent.checkIns ?? []).some(
                              (c) =>
                                !c.repeat &&
                                kind.resetsAt !== undefined &&
                                Math.abs(c.nextAt - kind.resetsAt) < 120_000
                            )}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </Fold>
              );
            })}
          </Section>

          <Section
            title="Working now"
            count={team.working.length}
            empty="No one is working right now"
          >
            {team.working.map((agent) => (
              <div
                key={agent.id}
                className="agents-team__head"
                data-arrived={isNewRow(`working:${agent.id}`) || undefined}
              >
                <Row
                  agent={agent}
                  place={roomName(agent.status.room)}
                  line={<AgentWorkingLine agent={agent} />}
                  state="working"
                  working
                  onOpen={() => openWhere(agent, agent.status.room)}
                />
                {onStop && (
                  <TextButton
                    tabIndex={0}
                    className="agents-team__open"
                    onClick={() => onStop(agent)}
                    aria-label={`Stop ${agent.name}`}
                  >
                    Stop
                  </TextButton>
                )}
              </div>
            ))}
          </Section>

          <Section
            title="Finished recently"
            count={finished.length}
            empty="Nothing new since you last looked"
          >
            {finished.map(({ agent, reply }) => (
              <Row
                key={agent.id}
                agent={agent}
                place={roomName(reply?.room)}
                line={
                  reply?.result?.title ??
                  (reply ? replyPreview(reply.text) : (previewText(agent.preview) ?? ''))
                }
                unread
                meta={reply ? formatAgo(reply.ts) : undefined}
                arrived={reply ? isNewReply(reply.id) : false}
                onOpen={() =>
                  reply
                    ? openWhere(agent, reply.room, reply.id, reply.conversation)
                    : onOpenAgent(agent.id)
                }
              />
            ))}
          </Section>

          {/* A usage limit resets by itself: listed quietly, never under Needs you,
              with Retry at the reset right there. Only while someone is. */}
          {team.paused.length > 0 && (
            <Section title="Paused" count={team.paused.length} empty="" quiet>
              {team.paused.map(({ agent, failure }) => {
                const kind = failedTurn(agent);
                const paused = kind
                  ? failurePill(kind, previewText(agent.preview), agent.engine)
                  : null;
                return (
                  <div key={agent.id} className="agents-team__group">
                    <Row
                      agent={agent}
                      line={paused ? paused.rest : 'Paused'}
                      pill={paused ? { tone: paused.tone, label: paused.label } : undefined}
                      state="limited"
                      onOpen={() => onOpenAgent(agent.id)}
                    />
                    {failure && kind && (
                      <ErrorLine
                        message={failure}
                        engine={agent.engine}
                        onSignIn={() => onSignIn(agent.engine)}
                        onRetry={() => void retry(agent, failure)}
                        onRetryAt={(at) => void retryAt(agent, failure, at)}
                        retryScheduled={(agent.checkIns ?? []).some(
                          (c) =>
                            !c.repeat &&
                            kind.resetsAt !== undefined &&
                            Math.abs(c.nextAt - kind.resetsAt) < 120_000
                        )}
                      />
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          <Section title="Everyone else" count={rest.length} empty="" quiet>
            {(rest.length > 0 || onNewAgent) && (
              <AgentsBoard
                agents={rest}
                onOpenAgent={onOpenAgent}
                onNewAgent={onNewAgent}
                variant="quiet"
                label="Everyone else"
              />
            )}
          </Section>

          {team.scheduled.length > 0 && (
            <Section title="Coming up" empty="" quiet>
              {team.scheduled.slice(0, COMING_UP_MAX).map(({ agent, checkIn }) => (
                <Row
                  key={`${agent.id}-${checkIn.id}`}
                  agent={agent}
                  line={checkIn.note}
                  meta={formatWhen(checkIn.nextAt)}
                  onOpen={() => onOpenAgent(agent.id)}
                />
              ))}
            </Section>
          )}

          {/* What keeps them going, said once there is something to keep going. */}
          {(team.working.length > 0 || team.scheduled.length > 0) && <AgentsStayOnNote />}

          {/* The plan's usage, when an engine reported it: before the wall, not at it. */}
          <AgentsQuota place="team" />
          {/* A reset near, with capacity left on the account turns run on: worth knowing. */}
          <AgentsSpareNote />
        </div>
      </div>
    </section>
  );
}

/**
 * Where an arrow key goes from `from` on the board: Up/Down between rows,
 * and in the grid of keys Left/Right along a row and Up/Down to the key
 * nearest across in the row above or below; Home/End the first and last.
 * From a card's button, Up/Down go to the row before or after it.
 */
export function boardNavTarget(
  column: HTMLElement,
  from: HTMLElement,
  key: string
): HTMLElement | undefined {
  const items = Array.from(column.querySelectorAll<HTMLElement>('[data-board-nav]'));
  if (items.length === 0) return undefined;
  const current = from.closest<HTMLElement>('[data-board-nav]');
  const index = current ? items.indexOf(current) : -1;
  const inGrid = Boolean(current?.hasAttribute('data-grid'));
  if (key === 'Home') return items[0];
  if (key === 'End') return items[items.length - 1];
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (!inGrid) return undefined;
    const candidate = items[index + (key === 'ArrowRight' ? 1 : -1)];
    return candidate?.hasAttribute('data-grid') ? candidate : undefined;
  }
  const down = key === 'ArrowDown';
  if (!current) {
    return down
      ? items.find((i) => from.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)
      : [...items]
          .reverse()
          .find((i) => from.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING);
  }
  if (!inGrid) return items[index + (down ? 1 : -1)];
  // The key in the row above or below, nearest across.
  const box = current.getBoundingClientRect();
  const rows = items.filter((i) => {
    if (!i.hasAttribute('data-grid')) return false;
    const top = i.getBoundingClientRect().top;
    return down ? top > box.top + 2 : top < box.top - 2;
  });
  if (rows.length === 0) {
    // Off the grid's edge: the row before it, or what comes after.
    return down
      ? items.slice(index + 1).find((i) => !i.hasAttribute('data-grid'))
      : [...items.slice(0, index)].reverse().find((i) => !i.hasAttribute('data-grid'));
  }
  const tops = rows.map((i) => i.getBoundingClientRect().top);
  const edge = down ? Math.min(...tops) : Math.max(...tops);
  const centre = box.left + box.width / 2;
  const across = (i: HTMLElement) => {
    const r = i.getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - centre);
  };
  return rows
    .filter((i) => Math.abs(i.getBoundingClientRect().top - edge) < 2)
    .sort((a, b) => across(a) - across(b))[0];
}
