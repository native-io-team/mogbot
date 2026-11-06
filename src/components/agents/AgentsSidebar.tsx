/**
 * The agent list, shown in the home sidebar in place of the projects while
 * Agents mode is on. It is built from the sidebar's own parts — the
 * full-bleed row with a hairline under it, the badge, the status slot and the
 * shared status dots — so it reads as the same sidebar, not a second app.
 *
 * There is one group, so there is no group header: the Projects | Agents
 * toggle above it says where you are. "New agent" closes the list, where
 * "Open project" closes the project list. The sidebar's top field searches
 * conversations here; while it has a query the results take the list's place.
 *
 * Right-click a row (or Shift+F10 on it) for Pin, Mark as unread, Mute notifications, Edit, Hide
 * and Delete; the conversation header's … menu has the same items for the
 * open agent.
 *
 * @module components/agents/AgentsSidebar
 */

import {
  memo,
  useMemo,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  AddIcon,
  BellOffIcon,
  ChevronRightIcon,
  CollaboratorsIcon,
  PinIcon,
} from '@/components/icons';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../primitives/ContextMenu';
import { Button } from '../primitives/Button';
import { AgentAvatar } from './AgentAvatar';
import { AgentWorkingLine } from './AgentWorkingLine';
import { AgentEngineBadge } from './AgentEngine';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { AgentsSearchResults } from './AgentsSearchResults';
import { AgentMark } from './AgentSwitcher';
import { RoomRow, type RoomActions } from './AgentRoomParts';
import { sortRooms, type Room } from '../../lib/agentRooms';
import { useFlipReorder } from './useAgentMotion';
import { useAttentionOrder } from './useAttentionOrder';
import { useAgentsSelector } from '../../lib/agentsStore';
import {
  failedTurn,
  failureLine,
  needsYou,
  type Agent,
  type AgentMessage,
  type SearchHit,
} from '../../lib/agents';
import { groupLine, groupRequests } from '../../lib/agentRequests';
import { secretTitle } from '../../lib/agentSecrets';
import { kbd } from '../../lib/shortcuts';

interface AgentsSidebarProps {
  agents: Agent[];
  /** Stable across renders, so an event re-renders only the row it changed. */
  actions: AgentActions;
  selectedId: string | null;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onSelect: (agentId: string) => void;
  onNew: () => void;
  /** The top field's query; while there is one, its results replace the list. */
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
  /** An agent picked by name from the results: opens it and puts search away. */
  onOpenAgent: (agentId: string) => void;
  /** The hit last opened, marked as the row is. */
  currentHit?: string | null;
  /** Agents waiting on you (a card, or a turn that didn't finish). */
  needsYouCount: number;
  /** What's in flight is the view on screen. */
  inFlightOpen: boolean;
  onOpenInFlight: () => void;
  /** Group conversations, each with its members as they are now. */
  rooms: { room: Room; members: Agent[] }[];
  roomActions: RoomActions;
  onNewRoom: () => void;
}

function subtitle(agent: Agent): ReactNode {
  // A request outranks driving: the row's words and its amber dot agree.
  // With a dozen agents waiting the label alone repeats down the list; what
  // it's asking (`askingLine`, beside this) or how many it holds is what
  // tells one waiting row from the next.
  if (needsYou(agent)) {
    const n = agent.pendingApprovals ?? 0;
    return n > 1 ? `Needs your OK · ${n}` : 'Needs your OK';
  }
  if (agent.takeover) return `You’re driving ${agent.name}`;
  // The step it's on and how long it's been at it, not "Working…".
  if (agent.status.state === 'working') return <AgentWorkingLine agent={agent} />;
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, agent.preview);
  return agent.preview ?? agent.role ?? '';
}

/**
 * What a waiting agent is asking, from its loaded lines only: the one
 * request's own words ("Push to GitHub"), or its logins by name ("3 logins:
 * Slack bot token…"). Null when its chat isn't loaded or the count says more
 * than the words would (as the requests panel words it: `groupLine`).
 */
function askingLine(agent: Agent, lines: readonly AgentMessage[] | undefined): string | null {
  if (!lines) return null;
  const group = groupRequests([agent], { [agent.id]: [...lines] }, NONE_SHOWN).groups[0];
  if (!group || group.older > 0 || group.pending === 0) return null;
  if (group.pending > 1 && group.logins !== group.pending) return null;
  // One login says its name alone ("CRM API key"), not "1 login: CRM API key".
  if (group.pending === 1 && group.logins === 1) {
    const a = group.cards.find((m) => m.approval?.status === 'pending')?.approval;
    if (a?.login) return a.login.title;
    if (a?.secret) return secretTitle(a.secret.name);
  }
  return groupLine(group);
}
const NONE_SHOWN: ReadonlySet<string> = new Set();

/** The row's second line takes the colour of its state. */
function lineState(agent: Agent): string | undefined {
  if (needsYou(agent)) return 'waiting';
  if (agent.takeover) return 'working';
  if (agent.status.state === 'working') return 'working';
  const failure = failedTurn(agent);
  if (failure) return failure.kind === 'usage_limit' ? 'limited' : 'failed';
  return undefined;
}

/** The full name as a tooltip only when the row cuts it short. */
function tooltipIfTruncated(event: PointerEvent<HTMLElement>) {
  const row = event.currentTarget;
  const text = row.querySelector<HTMLElement>('.agents-list__name-text');
  if (text && text.scrollWidth > text.clientWidth) {
    row.setAttribute('data-tooltip-content', text.textContent ?? '');
  } else {
    row.removeAttribute('data-tooltip-content');
  }
}

/**
 * The list is one Tab stop (the current row's); up and down move between
 * rows, Home and End to the ends. Shift+F10 or the context-menu key opens a
 * row's menu, as a right-click does.
 */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
    '[data-agent-id]'
  );
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    if (!row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom,
      })
    );
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-agent-id]'));
  const index = row ? rows.indexOf(row) : -1;
  if (index === -1) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? rows[0]
      : event.key === 'End'
        ? rows[rows.length - 1]
        : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
  next?.focus();
}

export function AgentsSidebar({
  agents,
  selectedId,
  showHidden,
  onToggleShowHidden,
  onSelect,
  onNew,
  query,
  searchRef,
  onOpenHit,
  onOpenAgent,
  currentHit,
  actions,
  needsYouCount,
  inFlightOpen,
  onOpenInFlight,
  rooms,
  roomActions,
  onNewRoom,
}: AgentsSidebarProps) {
  const searching = query.trim().length > 0;
  // By attention (waiting on you, working, recent), held still while the
  // list is in use so a row never moves under the pointer.
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useAttentionOrder(agents, listRef);
  const { visible, hidden } = useMemo(
    () => ({
      visible: sorted.filter((a) => !a.hidden || a.id === selectedId),
      hidden: sorted.filter((a) => a.hidden && a.id !== selectedId),
    }),
    [sorted, selectedId]
  );
  // An agent that just did something slides into place instead of jumping.
  const shown = showHidden ? [...visible, ...hidden] : visible;
  useFlipReorder(listRef, '[data-agent-id]', shown.map((a) => a.id).join(' '));

  // The one row in the Tab order: the open one, else the first.
  const tabStop = shown.some((a) => a.id === selectedId) ? selectedId : shown[0]?.id;

  const row = (agent: Agent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      current={agent.id === selectedId}
      tabStop={agent.id === tabStop}
      onSelect={onSelect}
      actions={actions}
    />
  );

  return (
    <div
      className="agents-list"
      role="navigation"
      aria-label="Agents"
      ref={listRef}
      onKeyDown={onListKeyDown}
    >
      {searching ? (
        <AgentsSearchResults
          query={query}
          field={searchRef}
          onOpen={onOpenHit}
          currentId={currentHit}
          onOpenAgent={onOpenAgent}
        />
      ) : (
        <>
          {/* The Chief first, always (as on the phone); then what waits on you. */}
          {visible.filter((a) => a.isMain).map(row)}
          {/* What's in flight, said where you look: only while something waits on you. */}
          {needsYouCount > 0 && (
            <button
              type="button"
              tabIndex={0}
              className={`agents-list__needs-you${inFlightOpen ? ' is-current' : ''}`}
              aria-current={inFlightOpen ? 'page' : undefined}
              onClick={onOpenInFlight}
              title={`Open What’s in flight · ${kbd('mod', 'J')} jumps to the next one`}
            >
              <span className="agents-list__needs-you-mark" aria-hidden="true">
                <span className="sidebar-row-dot dot-attention" />
              </span>
              <span className="agents-list__needs-you-label">Needs your OK · {needsYouCount}</span>
              <ChevronRightIcon size={10} className="agents-list__needs-you-chevron" />
            </button>
          )}
          {visible.filter((a) => !a.isMain).map(row)}
          {/* Rooms right after the agents, before the hidden ones (as on the
              phone), so they're seen without scrolling past the hidden list. */}
          {rooms.length > 0 && (
            <div className="agents-list__section" role="group" aria-label="Rooms">
              <div className="agents-list__section-title">Rooms</div>
              {sortRooms(rooms.map((r) => r.room)).map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  members={rooms.find((r) => r.room.id === room.id)?.members ?? []}
                  current={selectedId === `room:${room.id}`}
                  onSelect={onSelect}
                  actions={roomActions}
                />
              ))}
            </div>
          )}
          {hidden.length > 0 && (
            <button
              type="button"
              tabIndex={0}
              className="agents-list__hidden-toggle"
              aria-expanded={showHidden}
              onClick={onToggleShowHidden}
            >
              <ChevronRightIcon size={10} className="agents-list__hidden-chevron" />
              Hidden · {hidden.length}
            </button>
          )}
          {showHidden && hidden.map(row)}
          <div className="workspace-sidebar-active-actions">
            <Button
              variant="ghost"
              width="fill"
              className="workspace-sidebar-add-project agents-list__new"
              onClick={onNew}
              title={`New agent (${kbd('mod', 'N')})`}
            >
              <AddIcon size={16} />
              <span>New agent</span>
            </Button>
            {/* A room needs two agents to talk to. */}
            {agents.length >= 2 && (
              <Button
                variant="ghost"
                width="fill"
                className="workspace-sidebar-add-project agents-list__new-room"
                onClick={onNewRoom}
              >
                <CollaboratorsIcon size={16} />
                <span>New room</span>
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One agent's row, memoised: a status event re-renders the row it changed, not all of them. */
const AgentRow = memo(function AgentRow({
  agent,
  current,
  tabStop,
  onSelect,
  actions,
}: {
  agent: Agent;
  current: boolean;
  tabStop: boolean;
  onSelect: (agentId: string) => void;
  actions: AgentActions;
}) {
  // Its loaded lines, only while it's waiting: the row says what it's asking.
  const lines = useAgentsSelector((s) => (needsYou(agent) ? s.messages[agent.id] : undefined));
  const asking = needsYou(agent) ? askingLine(agent, lines) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
        <button
          type="button"
          tabIndex={tabStop ? 0 : -1}
          className={`agents-list__row${current ? ' is-current' : ''}`}
          data-agent-id={agent.id}
          data-hidden={agent.hidden || undefined}
          aria-current={current ? 'true' : undefined}
          onPointerEnter={tooltipIfTruncated}
          onClick={() => onSelect(agent.id)}
        >
          <AgentAvatar
            id={agent.id}
            name={agent.name}
            color={agent.color}
            selected={current}
            working={agent.status.state === 'working' && !agent.takeover}
          />
          <span className="agents-list__text">
            <span className="agents-list__name">
              <span className="agents-list__name-text">{agent.name}</span>
              {/* Marks, not controls: small, faint, and not a target (the menu toggles them). */}
              {agent.pinned && (
                <PinIcon size={10} className="agents-list__pin" aria-label="Pinned" />
              )}
              {agent.muted && (
                <BellOffIcon size={10} className="agents-list__pin" aria-label="Muted" />
              )}
              <AgentEngineBadge engine={agent.engine} />
            </span>
            <span className="agents-list__preview" data-state={lineState(agent)}>
              {asking ? (
                <>
                  Needs your OK
                  {/* What it's asking reads as words, not as more amber. */}
                  <span className="agents-list__asking"> · {asking}</span>
                </>
              ) : (
                subtitle(agent)
              )}
            </span>
          </span>
          <span className="agents-list__status">
            {/* Read already when it's the one open: no unread dot for it. */}
            <AgentMark agent={current ? { ...agent, unread: 0 } : agent} />
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${agent.name}`}>
        <AgentActionItems agent={agent} kind="context" {...actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
});
