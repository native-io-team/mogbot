/**
 * The agent list, shown in the home sidebar in place of the projects while
 * Agents mode is on. It is built from the sidebar's own parts — the
 * full-bleed row with a hairline under it, the badge, the status slot and the
 * shared status dots — so it reads as the same sidebar, not a second app.
 *
 * There is one group, so there is no group header: the Projects | Agents
 * toggle above it says where you are. The foot, outside the scroller, on the
 * rows' grid: New agent as the neutral key with New room as its second half
 * (`AgentsSidebarActions`), then Usage, then Routines (`RoutinesRow`) sharing
 * the last row with the phone, remote and Settings icons. The sidebar's top field searches
 * conversations here; while it has a query the results take the list's place.
 *
 * Drag a row to put the list in your own order (then it stays there); ⌘K
 * "Sort agents by recent activity" goes back to the order by attention.
 *
 * Right-click a row (or Shift+F10 on it) for Pin, Mark as unread, Mute notifications, Edit, Hide
 * and Delete; the conversation header's … menu has the same items for the
 * open agent.
 *
 * @module components/agents/AgentsSidebar
 */

import { formatAge } from '../../lib/formatAgo';
import {
  memo,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  AddIcon,
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  CollaboratorsIcon,
  FolderPlusIcon,
  PinIcon,
  RoutineIcon,
} from '@/components/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import {
  AgentGroupSection,
  MoveToGroupItems,
  NewGroupField,
  useAgentPointerDrag,
} from './AgentGroupParts';
import {
  inYourOrder,
  moveAgent,
  PINNED_KEY,
  sectionAgents,
  setGroupMode,
  startNamingGroup,
  toggleCollapsed,
  useAgentGroups,
  type AgentGroup,
} from '../../lib/agentGroups';

/** The Rooms section's fold, kept with the groups' folds. */
const ROOMS_KEY = 'rooms';
import { Button } from '../primitives/Button';
import { FooterRowIcon } from '../workspace/FooterRowIcon';
import { IconButton } from '../primitives/IconButton';
import { Tooltip } from '../primitives/Tooltip';
import { AgentKey } from './AgentKey';
import { WorkingElapsed } from './AgentWorkingLine';
import { AgentEngineBadge } from './AgentEngine';
import { AgentLevelBadge } from './AgentLevelPicker';
import { AgentActionItems, type AgentActions } from './AgentActions';
import { AgentsSearchResults } from './AgentsSearchResults';
import { AgentMark } from './AgentSwitcher';
import { RoomRow, type RoomActions } from './AgentRoomParts';
import { ROOM_WHAT, sortRooms, type Room } from '../../lib/agentRooms';
import { useFlipReorder, useNewKeys } from './useAgentMotion';
import { useSteadyList } from './useAttentionOrder';
import { useLiveAgent } from '../../lib/agentsStore';
import {
  agentKeyState,
  needsYou,
  usageLimited,
  roleWithoutPath,
  folderName,
  type Agent,
  type SearchHit,
} from '../../lib/agents';
import { kbd } from '../../lib/shortcuts';
import { markLaunchAfterPaint } from '../../lib/launchMarks';

interface AgentsSidebarProps {
  agents: Agent[];
  /** Stable across renders, so an event re-renders only the row it changed. */
  actions: AgentActions;
  selectedId: string | null;
  showHidden: boolean;
  onToggleShowHidden: () => void;
  onSelect: (agentId: string) => void;
  /** The top field's query; while there is one, its results replace the list. */
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onOpenHit: (hit: SearchHit) => void;
  /** An agent picked by name from the results: opens it and puts search away. */
  onOpenAgent: (agentId: string) => void;
  /** The hit last opened, marked as the row is. */
  currentHit?: string | null;
  /** Group conversations, each with its members as they are now. */
  rooms: { room: Room; members: Agent[] }[];
  roomActions: RoomActions;
  /** First run: the hint under the Chief's row starts a first agent. */
  onNew?: () => void;
}

/**
 * What the key and the row's ink say, in words for a screen reader: ", working",
 * ", paused", ", unread". The line itself says needs-your-OK and the time.
 */
function rowStateWords(agent: Agent, unread: boolean): string {
  const words: string[] = [];
  if (agent.takeover && !needsYou(agent)) words.push('live');
  else if (agent.status.state === 'working' && !needsYou(agent)) words.push('working');
  else if (usageLimited(agent) || agent.paused) words.push('paused');
  if (unread) words.push('unread');
  return words.length ? `, ${words.join(', ')}` : '';
}

/** Its name and role as a tooltip; the name alone when it has no role and the row cuts it short. */
function tooltipIfTruncated(event: PointerEvent<HTMLElement>) {
  const row = event.currentTarget;
  const text = row.querySelector<HTMLElement>('.agents-list__name-text');
  const name = text?.textContent ?? '';
  const role = row.dataset.role ?? '';
  // The role isn't on the row (a few letters of it was noise): it's the
  // tooltip's second half, and the chat header says it in full.
  if (role) {
    row.setAttribute('data-tooltip-content', `${name} · ${role}`);
  } else if (text && text.scrollWidth > text.clientWidth) {
    row.setAttribute('data-tooltip-content', name);
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

/**
 * Needs you, beside the sidebar toggle (it opens What's in flight, whose
 * first section is Needs you): the one place the sidebar
 * counts what waits on you. Each waiting row says so once more in its pill;
 * nothing else in the list repeats it (docs/agents.md, "Needs you: one place
 * per surface").
 */
export function InFlightBell({
  count,
  current,
  onOpen,
}: {
  /** Agents waiting on you (a card, or a turn that didn't finish). */
  count: number;
  /** What's in flight is the view on screen. */
  current: boolean;
  onOpen: () => void;
}) {
  // "Needs you": what the bell counts (the phone's place for it is Catch up). The view
  // it opens leads with its Needs you section (What's in flight is the rest).
  const label = count > 0 ? `Needs you · ${count}` : 'Needs you · nothing right now';
  return (
    <span className="agents-inflight-anchor agents-inflight">
      <IconButton
        variant="ghost"
        tabIndex={0}
        className={`workspace-sidebar-home${current ? ' is-active' : ''}`}
        icon={<BellIcon size={12} />}
        onClick={onOpen}
        aria-current={current ? 'page' : undefined}
        title={count > 0 ? `${label} · ${kbd('mod', 'J')} jumps to the next one` : label}
        aria-label={label}
      />
      {count > 0 && (
        <span className="agents-inflight__count" aria-hidden="true">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </span>
  );
}

/**
 * Catch up: one row under the search panel's border that never scrolls, the
 * height and hairline of a conversation row, so it lines up with the list.
 * A neutral tile where an agent's key sits, the waiting count on its corner.
 * One line, as every row is (25 Nov): who is waiting is in its tooltip.
 */
export function CatchUpRow({
  count,
  waiting,
  open,
  onOpen,
}: {
  count: number;
  /** The agents waiting on you, in list order: their names make the tooltip. */
  waiting: readonly { name: string }[];
  open: boolean;
  onOpen: () => void;
}) {
  const shown = waiting.slice(0, 2).map((a) => a.name);
  const more = waiting.length - shown.length;
  const who = more > 0 ? `${shown.join(', ')}, +${more}` : shown.join(', ');
  return (
    <button
      type="button"
      tabIndex={0}
      className={`agents-list__row agents-catchup-row${open ? ' is-current' : ''}`}
      aria-current={open ? 'page' : undefined}
      aria-label={count > 0 ? `Catch up, ${count} need you: ${who}` : 'Catch up, all clear'}
      title={who || undefined}
      onClick={onOpen}
    >
      <span className="agents-catchup-row__tile" aria-hidden="true">
        <CollaboratorsIcon size={14} />
        {count > 0 && (
          <span className="agents-catchup-row__count">{count > 99 ? '99+' : count}</span>
        )}
      </span>
      <span className="agents-list__text">
        <span className="agents-list__name">
          <span className="agents-list__name-text">Catch up</span>
        </span>
      </span>
    </button>
  );
}

export function AgentsSidebar({
  agents,
  selectedId,
  showHidden,
  onToggleShowHidden,
  onSelect,
  query,
  searchRef,
  onOpenHit,
  onOpenAgent,
  currentHit,
  actions,
  rooms,
  roomActions,
  onNew,
}: AgentsSidebarProps) {
  const hasAgents = agents.length > 0;
  useEffect(() => {
    if (hasAgents) markLaunchAfterPaint('agents-list');
  }, [hasAgents]);
  // Optional sections: by project, or the folders you make (none until the first).
  const grouping = useAgentGroups();
  const searching = query.trim().length > 0;
  // By attention (waiting on you, working, recent), held still while the
  // list is in use so a row never moves under the pointer, and re-sorted at
  // most every few seconds.
  const listRef = useRef<HTMLDivElement>(null);
  const { agents: byAttention } = useSteadyList(agents, listRef, false);
  // Your own order, once you've dragged a row: it holds, and new agents join at the end.
  const yours = grouping.sort === 'yours';
  const sorted = useMemo(
    () => (yours ? inYourOrder(agents, grouping.order) : byAttention),
    [yours, agents, grouping.order, byAttention]
  );
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

  // An agent made while the list is up (by you or the Chief) rises in once;
  // the list as it first loads holds still.
  const isNew = useNewKeys(
    useMemo(() => agents.map((a) => a.id), [agents]),
    agents.length > 0
  );

  // The one row in the Tab order: the open one (an agent or a room), else the first.
  const openRoom = rooms.some((r) => `room:${r.room.id}` === selectedId);
  const tabStop = openRoom || shown.some((a) => a.id === selectedId) ? selectedId : shown[0]?.id;

  // Rooms fold as a group does (the fold is kept with the groups'). Folded,
  // the open room and any that is waiting on you or unread still show, so
  // folding never hides something new.
  const roomsFolded = grouping.collapsed.includes(ROOMS_KEY);
  const roomRows = sortRooms(rooms.map((r) => r.room))
    .map((room) => ({
      room,
      members: rooms.find((r) => r.room.id === room.id)?.members ?? [],
    }))
    .filter(
      ({ room, members }) =>
        !roomsFolded ||
        selectedId === `room:${room.id}` ||
        room.unread > 0 ||
        members.some((m) => needsYou(m) && m.status.room === room.id)
    );

  const custom = grouping.mode === 'custom';
  // The rows' order as shown, for a drop to be placed in.
  const shownKey = shown
    .filter((a) => !a.isMain)
    .map((a) => a.id)
    .join(' ');
  const onReorder = useCallback(
    (moved: string, target: string, after: boolean) =>
      moveAgent(shownKey.split(' ').filter(Boolean), moved, target, after),
    [shownKey]
  );
  const row = (agent: Agent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      current={agent.id === selectedId}
      tabStop={agent.id === tabStop}
      arrived={isNew(agent.id)}
      onSelect={onSelect}
      actions={actions}
      groups={agent.isMain ? undefined : grouping.groups}
      group={grouping.assign[agent.id]}
      onReorder={onReorder}
    />
  );
  const team = visible.filter((a) => !a.isMain);
  const sections =
    grouping.mode === 'off'
      ? null
      : sectionAgents(team, grouping, (path) => folderName(path) || path);

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
          {/* The Chief first, always (as on the phone); then what waits on you.
              How many wait is said once, on the bell (`InFlightBell`); each
              waiting row says it once more, in its own pill. */}
          {visible.filter((a) => a.isMain).map(row)}
          {sections
            ? sections
                .filter((section) => custom || section.agents.length > 0)
                .map((section) => (
                  <AgentGroupSection
                    key={section.key}
                    section={section}
                    collapsed={grouping.collapsed.includes(section.key)}
                    droppable={custom && section.key !== PINNED_KEY}
                    pinned={grouping.pinned}
                  >
                    {section.agents.map(row)}
                  </AgentGroupSection>
                ))
            : team.map(row)}
          {custom && grouping.naming && <NewGroupField />}
          {/* Rooms right after the agents, before the hidden ones (as on the
              phone), so they're seen without scrolling past the hidden list. */}
          {rooms.length > 0 && (
            <div className="agents-list__group" role="group" aria-label="Rooms">
              {/* The groups' own header: a chevron, the name on the names'
                  column, how many on the right. */}
              <button
                type="button"
                tabIndex={0}
                className="agents-list__group-toggle"
                aria-expanded={!roomsFolded}
                onClick={() => toggleCollapsed(ROOMS_KEY)}
              >
                <ChevronRightIcon size={10} className="agents-list__hidden-chevron" />
                <span className="agents-list__group-title">Rooms</span>
                <span className="agents-list__group-count">{rooms.length}</span>
              </button>
              {roomRows.map(({ room, members }) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  members={members}
                  current={selectedId === `room:${room.id}`}
                  tabStop={selectedId === `room:${room.id}`}
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
          {/* First run: only the Chief. Say where the team starts. */}
          {onNew && agents.length === 1 && agents[0].isMain && (
            <div className="agents-list__first-run">
              <p className="agents-list__first-run-title">Your team starts here</p>
              <p className="agents-list__first-run-copy">
                Ask the Chief for a first agent, or make one yourself.
              </p>
              <Button variant="strong" onClick={onNew}>
                New agent
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The create actions, first in the foot, under the list they add to: one
 * split button, New agent with New room as its icon half (the room half only
 * once there are two agents to talk to). Neutral `default`, never the accent;
 * its icon and label sit on the agent rows' key and name columns. Collapsed,
 * the two stack as icons. Outside the list's scroller, so ten agents or
 * project groups never push them away (round 4, #10).
 */
export function AgentsSidebarActions({
  agentCount,
  collapsed = false,
  onNew,
  onNewRoom,
}: {
  agentCount: number;
  collapsed?: boolean;
  onNew: () => void;
  onNewRoom: () => void;
}) {
  // A room needs two agents to talk to.
  const room = agentCount >= 2;
  const newAgentTip = `New agent (${kbd('mod', 'N')})`;
  return (
    <div
      className={`agents-foot__new${!collapsed ? ' button-group--split' : ''}`}
      role="group"
      aria-label="Start something new"
    >
      {collapsed ? (
        <Tooltip content={newAgentTip}>
          <IconButton
            variant="default"
            className="agents-list__new"
            icon={<AddIcon size={14} />}
            onClick={onNew}
            aria-label="New agent"
          />
        </Tooltip>
      ) : (
        <Button
          variant="default"
          width="fill"
          className="agents-list__new"
          leftIcon={<AddIcon size={14} />}
          onClick={onNew}
          aria-label="New agent"
          title={newAgentTip}
        >
          <span className="agents-foot__new-label">New agent</span>
        </Button>
      )}
      {/* Folders, in plain sight: one click opens the name field in the
          list (agents are then dragged in, or filed from their menu). */}
      <Tooltip content="New folder, to sort your agents">
        <IconButton
          variant={collapsed ? 'ghost' : 'default'}
          className="agents-list__new-folder"
          icon={<FolderPlusIcon size={14} />}
          onClick={() => {
            setGroupMode('custom');
            startNamingGroup();
          }}
          aria-label="New folder"
        />
      </Tooltip>
      {room && (
        <Tooltip content={`New room. ${ROOM_WHAT}`}>
          <IconButton
            variant={collapsed ? 'ghost' : 'default'}
            className="agents-list__new-room"
            icon={<CollaboratorsIcon size={14} />}
            onClick={onNewRoom}
            aria-label="New room"
          />
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Routines, every agent's in one list: a page, so it sits in the foot's last
 * row, beside the phone, remote and Settings icons, in the footer rows' own
 * shape, and wears the selected fill while it's open.
 */
export function RoutinesRow({
  open,
  collapsed,
  onOpen,
}: {
  open: boolean;
  collapsed: boolean;
  onOpen: () => void;
}) {
  return (
    <Button
      variant="ghost"
      width="fill"
      className={`remote-indicator agents-list__routines${collapsed ? ' remote-indicator--compact' : ''}`}
      aria-current={open ? 'page' : undefined}
      aria-label="Routines"
      title={collapsed ? 'Routines' : undefined}
      onClick={onOpen}
      leftIcon={<FooterRowIcon icon={<RoutineIcon size={14} />} status="off" />}
    >
      {!collapsed && <span className="remote-indicator__line">Routines</span>}
    </Button>
  );
}

/** One agent's row, memoised: a status event re-renders the row it changed, not all of them. */
const AgentRow = memo(function AgentRow({
  agent: listed,
  current,
  tabStop,
  arrived,
  onSelect,
  actions,
  groups,
  group,
  onReorder,
}: {
  agent: Agent;
  current: boolean;
  tabStop: boolean;
  /** Joined the list while it was up: it rises in once. */
  arrived: boolean;
  onSelect: (agentId: string) => void;
  actions: AgentActions;
  /** The folders, for the row's menu (not the Chief's: it stays at the top). */
  groups?: AgentGroup[];
  /** The folder it's in. */
  group?: string;
  /** Another row dropped on this one: put it just before (or after) this. */
  onReorder: (moved: string, target: string, after: boolean) => void;
}) {
  // Its turn's progress, live: the list it came from changes only when the team's layout does.
  const agent = useLiveAgent(listed);
  // The Chief stays first: it neither moves nor takes a row above it.
  const movable = !agent.isMain;
  const drag = useAgentPointerDrag({ agentId: agent.id, enabled: movable, group, onReorder });
  // Read already when it's the one open; a muted agent never shows unread.
  const unread = !current && !agent.muted && agent.unread > 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
        <button
          type="button"
          tabIndex={tabStop ? 0 : -1}
          className={`agents-list__row${current ? ' is-current' : ''}`}
          data-agent-id={agent.id}
          data-role={roleWithoutPath(agent.role ?? '') || undefined}
          data-hidden={agent.hidden || undefined}
          data-arrived={arrived || undefined}
          data-unread={unread || undefined}
          data-muted={agent.muted || undefined}
          aria-current={current ? 'true' : undefined}
          onPointerEnter={tooltipIfTruncated}
          onClick={() => onSelect(agent.id)}
          data-movable={movable || undefined}
          {...drag}
        >
          <AgentKey
            id={agent.id}
            name={agent.name}
            color={agent.color}
            state={agentKeyState(agent)}
            size="md"
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
              <AgentLevelBadge agent={agent} />
            </span>
          </span>
          {/* The key says working, free or needs you, and unread is the row's
              ink, so the right edge stays clean. Said in words for a screen
              reader (the elapsed time is already in the line). Only the
              collapsed rail, with no line to read, keeps a mark on the badge. */}
          <span className="sr-only">{rowStateWords(agent, unread)}</span>
          {/* When it last moved, and a blue dot under it while unread. A
              working row keeps its clock in the line instead. */}
          <span className="agents-list__meta" aria-hidden="true">
            {agent.status.state === 'working' ? (
              <WorkingElapsed agent={agent} />
            ) : (
              agent.lastActivityAt > 0 && (
                <span className="agents-list__time">{formatAge(agent.lastActivityAt)}</span>
              )
            )}
            {unread && <span className="agents-list__unread" />}
          </span>
          <span className="agents-list__status">
            <span className="agents-list__rail-mark">
              <AgentMark agent={unread ? agent : { ...agent, unread: 0 }} />
            </span>
          </span>
          {/* The rail's amber dot: this one needs you (the key alone said it with a glow). */}
          {needsYou(agent) && <span className="agents-list__rail-needs" aria-hidden="true" />}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${agent.name}`}>
        <AgentActionItems agent={agent} kind="context" {...actions} />
        {groups && (
          <>
            <ContextMenuSeparator />
            <MoveToGroupItems agentId={agent.id} groups={groups} current={group} />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
