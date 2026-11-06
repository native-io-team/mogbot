/**
 * The small pieces of rooms that sit outside the room itself: the stacked
 * avatars, the sidebar's "Rooms" section and its rows, and the one line an
 * agent's own chat shows for what it said in a room.
 *
 * @module components/agents/AgentRoomParts
 */

import { previewText } from '../../../packages/companion-protocol/src/preview';
import { memo } from 'react';
import { BellIcon, BellOffIcon, EditIcon, TrashIcon, CommentIcon } from '@/components/icons';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../primitives/ContextMenu';
import { TextButton } from '../primitives/TextButton';
import { PixelLoaderRings } from '../workspace/PixelLoaderRings';
import { AgentAvatar, agentInitials } from './AgentAvatar';
import { useAgentsSelector } from '../../lib/agentsStore';
import { needsYou, type Agent, type AgentMessage } from '../../lib/agents';
import { listNames, roomActivity, roomKey, roomMembers, type Room } from '../../lib/agentRooms';

/** Faces a room's stack shows before "+N". */
const ROOM_FACES = 3;

/**
 * Up to three members' badges side by side, overlapping a little, and "+2"
 * for the rest: the room's header and its empty state, where there is room
 * for faces.
 */
export function RoomAvatars({ members }: { members: Pick<Agent, 'id' | 'name' | 'color'>[] }) {
  const shown = members.slice(0, ROOM_FACES);
  const more = members.length - shown.length;
  return (
    <span className="agent-room-avatars" aria-hidden>
      {shown.map((m) => (
        <AgentAvatar key={m.id} id={m.id} name={m.name} color={m.color} size="mini" />
      ))}
      {more > 0 && <span className="agent-room-avatars__more">+{more}</span>}
    </span>
  );
}

/**
 * A room's own badge in the list: its initials on an outlined, neutral tile,
 * in an agent badge's footprint. Two rooms with the same members still look
 * different, and a room never passes for an agent (whose tile is filled).
 */
export function RoomMark({ name, selected = false }: { name: string; selected?: boolean }) {
  return (
    <span className={`agent-room-mark${selected ? ' agent-room-mark--selected' : ''}`} aria-hidden>
      {agentInitials(name)}
    </span>
  );
}

export interface RoomActions {
  onEditRoom: (room: Room) => void;
  onToggleRoomMuted: (room: Room) => void;
  onDeleteRoom: (room: Room) => void;
}

/** What the row's second line says: who needs you, who's answering, or the newest line. */
function roomSubtitle(room: Room, members: Agent[]): { text: string; state?: string } {
  const asking = members.find((m) => needsYou(m) && m.status.room === room.id);
  if (asking) return { text: `${asking.name} needs your OK`, state: 'waiting' };
  const { working, waiting } = roomActivity(room, members);
  if (working.length === 1) return { text: `${working[0].name} is replying…`, state: 'working' };
  if (working.length > 1) return { text: `${working.length} are replying…`, state: 'working' };
  if (waiting.length > 0) return { text: `${waiting[0].name} will reply next`, state: 'working' };
  return { text: previewText(room.preview) || listNames(members.map((m) => m.name)) };
}

export const RoomRow = memo(function RoomRow({
  room,
  members,
  current,
  onSelect,
  actions,
}: {
  room: Room;
  members: Agent[];
  current: boolean;
  onSelect: (key: string) => void;
  actions: RoomActions;
}) {
  const line = roomSubtitle(room, members);
  const { working } = roomActivity(room, members);
  const asking = members.some((m) => needsYou(m) && m.status.room === room.id);
  // A quiet room is one line, as a channel is: its newest words only while
  // they're unread, or while something is happening there.
  const showLine = Boolean(line.state) || (room.unread > 0 && !current);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          className={`agents-list__row agents-list__row--room${current ? ' is-current' : ''}`}
          data-quiet={showLine ? undefined : true}
          data-agent-id={roomKey(room.id)}
          aria-current={current ? 'true' : undefined}
          onClick={() => onSelect(roomKey(room.id))}
        >
          <RoomMark name={room.name} selected={current} />
          <span className="agents-list__text">
            <span className="agents-list__name">
              <span className="agents-list__name-text">{room.name}</span>
              {room.muted && (
                <BellOffIcon size={10} className="agents-list__pin" aria-label="Muted" />
              )}
            </span>
            {showLine && (
              <span className="agents-list__preview" data-state={line.state}>
                {line.text}
              </span>
            )}
          </span>
          <span className="agents-list__status">
            {asking ? (
              <span className="sidebar-row-dot dot-attention" aria-label="Needs your OK" />
            ) : working.length > 0 ? (
              <PixelLoaderRings size="sm" label={`Replying in ${room.name}`} />
            ) : room.unread > 0 && !current ? (
              <span className="sidebar-row-dot dot-unread" aria-label="Unread" />
            ) : null}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`Actions for ${room.name}`}>
        <RoomActionItems room={room} {...actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** A room's own menu items: the same in the row's right-click and the header's … menu. */
export function RoomActionItems({
  room,
  onEditRoom,
  onToggleRoomMuted,
  onDeleteRoom,
}: { room: Room } & RoomActions) {
  return (
    <>
      <ContextMenuItem onSelect={() => onEditRoom(room)}>
        <EditIcon size={12} /> Members and name…
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onToggleRoomMuted(room)}>
        {room.muted ? <BellIcon size={12} /> : <BellOffIcon size={12} />}{' '}
        {room.muted ? 'Unmute' : 'Mute'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => onDeleteRoom(room)}>
        <TrashIcon size={12} /> Delete room…
      </ContextMenuItem>
    </>
  );
}

/**
 * In an agent's own chat, what it said in a room is one quiet line that
 * opens the room: the room's thread is where it reads in full.
 */
/**
 * Where a turn answers when it is in a room: on the working line of the
 * agent's own chat, so its reply there isn't taken for one to you.
 */
export function RoomWorkingPlace({
  roomId,
  onOpenRoom,
}: {
  roomId: string;
  onOpenRoom: (key: string) => void;
}) {
  const room = useAgentsSelector((s) => s.rooms.find((r) => r.id === roomId));
  if (!room) return <>Replying in a room</>;
  return (
    <>
      Replying in{' '}
      <TextButton
        tabIndex={-1}
        className="agent-note__link"
        onClick={() => onOpenRoom(roomKey(room.id))}
      >
        {room.name}
      </TextButton>
    </>
  );
}

export const RoomFoldLine = memo(function RoomFoldLine({
  roomId,
  messages,
  arrived,
  onOpenRoom,
}: {
  roomId: string;
  messages: AgentMessage[];
  arrived?: boolean;
  onOpenRoom: (key: string) => void;
}) {
  const room = useAgentsSelector((s) => s.rooms.find((r) => r.id === roomId));
  const failed = messages[messages.length - 1]?.kind === 'error';
  const replies = messages.filter((m) => m.kind === 'agent').length;
  const what = failed
    ? 'Didn’t finish'
    : replies === 1
      ? 'Replied'
      : replies > 1
        ? `${replies} replies`
        : 'Worked';
  return (
    <div
      className="agent-note agent-room-fold"
      data-arrived={arrived || undefined}
      data-message-ids={messages.map((m) => m.id).join(' ')}
    >
      <CommentIcon size={12} className="agent-room-fold__icon" aria-hidden />
      {room ? (
        <>
          {what} in{' '}
          <TextButton
            tabIndex={-1}
            className="agent-note__link"
            onClick={() => onOpenRoom(roomKey(room.id))}
          >
            {room.name}
          </TextButton>
        </>
      ) : (
        <>{what} in a room</>
      )}
    </div>
  );
});

/** The rooms an agent list shows, with each one's members resolved. */
export function useRoomRows(agentsById: Map<string, Agent>) {
  const rooms = useAgentsSelector((s) => s.rooms);
  return rooms.map((room) => ({ room, members: roomMembers(room, agentsById) }));
}
