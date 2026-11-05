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
  type RefObject,
} from 'react';
import {
  AddIcon,
  BellOffIcon,
  ChevronRightIcon,
  CollaboratorsIcon,
  DownloadIcon,
  PinIcon,
} from '@/components/icons';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../primitives/ContextMenu';
import { Button } from '../primitives/Button';
import { AgentAvatar } from './AgentAvatar';
import { AgentEngineBadge } from './AgentEngine';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { AgentsSearchResults } from './AgentsSearchResults';
import { ImportNudge, useImportNudge } from './ImportNudge';
import { useImportGate } from './ImportConnectorPanel';
import { talkIsLive } from '../../lib/agents';
import { AgentMark } from './AgentSwitcher';
import { RoomRow, type RoomActions } from './AgentRoomParts';
import { sortRooms, type Room } from '../../lib/agentRooms';
import { useFlipReorder } from './useAgentMotion';
import { useAgentsSelector } from '../../lib/agentsStore';
import {
  engineIsReady,
  failedTurn,
  failureLine,
  needsYou,
  plainActivity,
  sortAgents,
  type Agent,
  type SearchHit,
} from '../../lib/agents';
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
  /** Opens Import agents (paste from Grok Bot or any assistant). */
  onImport: () => void;
  /** The top field's query; while there is one, its results replace the list. */
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
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

function subtitle(agent: Agent): string {
  // A request outranks driving: the row's words and its amber dot agree.
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.takeover) return `You’re driving ${agent.name}`;
  if (agent.status.state === 'working') return plainActivity(agent.status.activity) ?? 'Working…';
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, agent.preview);
  return agent.preview ?? agent.role ?? '';
}

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
  onImport,
  query,
  searchRef,
  onOpenHit,
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
  // Bringing agents over is for someone whose agents can run: never while
  // nothing can (signed out, nothing installed), when it would compete with
  // the one thing they have to do.
  const engineWorks = useAgentsSelector((s) =>
    s.engines.length > 0
      ? s.engines.some((e) => engineIsReady(e.id, s.engines, s.engineReady))
      : s.engineReady
  );
  const nudge = useImportNudge(
    agents.length,
    agents.some((a) => a.isMain && a.sessionId !== null)
  );
  const importing = talkIsLive(useImportGate().talk);
  // An import already going needs no pitch for one.
  const showNudge = nudge.visible && engineWorks && !importing;
  const { visible, hidden } = useMemo(() => {
    const sorted = sortAgents(agents);
    return {
      visible: sorted.filter((a) => !a.hidden || a.id === selectedId),
      hidden: sorted.filter((a) => a.hidden && a.id !== selectedId),
    };
  }, [agents, selectedId]);
  // An agent that just did something slides to the top instead of jumping.
  const listRef = useRef<HTMLDivElement>(null);
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
        />
      ) : (
        <>
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
          {visible.map(row)}
          {hidden.length > 0 && (
            <button
              type="button"
              tabIndex={0}
              className="agents-list__hidden-toggle"
              aria-expanded={showHidden}
              onClick={onToggleShowHidden}
            >
              <ChevronRightIcon size={10} className="agents-list__hidden-chevron" />
              Hidden ({hidden.length})
            </button>
          )}
          {showHidden && hidden.map(row)}
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
          {showNudge && <ImportNudge onImport={onImport} onDismiss={nudge.dismiss} />}
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
            {/* Here for good once the note above is gone: people decide to
                bring their agents over after they've tried it. While the note
                shows, it is the way in, and a second button would only echo it. */}
            {engineWorks && !nudge.visible && (
              <Button
                variant="ghost"
                width="fill"
                className="workspace-sidebar-add-project agents-list__import"
                onClick={onImport}
              >
                <DownloadIcon size={16} />
                <span>Import agents</span>
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
          <AgentAvatar name={agent.name} color={agent.color} selected={current} />
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
              {subtitle(agent)}
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
