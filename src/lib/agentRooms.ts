/**
 * Rooms — group conversations with two to six agents. Types mirroring
 * `src-tauri/src/agents/rooms.rs`, the invoke wrappers, and the pure rules
 * the room view and composer share.
 *
 * A room is one visible thread; each member keeps its own session and
 * memory. A message goes to the members you @mention, everyone for
 * @everyone, or the room's lead; with none of those the composer asks
 * "Who should answer?" rather than guessing.
 *
 * @module lib/agentRooms
 */

import { invoke } from '@tauri-apps/api/core';
import type { Agent, AgentMessage, AgentRef, OutgoingAttachment, ResultRef } from './agents';
import { mentionedAgents } from './agents';

export const MIN_ROOM_MEMBERS = 2;
export const MAX_ROOM_MEMBERS = 6;

/** What a room is, in one line: the sidebar's tooltip and the start of the editor's lead. */
export const ROOM_WHAT = 'Talk to several agents at once, in one conversation.';

/** Mirrors `rooms::RoomView`. */
export interface Room {
  id: string;
  name: string;
  /** Agent ids, in the order they were added. */
  members: string[];
  /** Who answers when nobody is mentioned; absent: you're asked. */
  lead?: string;
  muted: boolean;
  createdAt: number;
  lastActivityAt: number;
  preview?: string;
  unread: number;
  /** What the room is for, in a line; absent in rooms made without one. */
  purpose?: string;
  /** The agent that made it (the Chief's `create_room`); absent: you did. */
  createdBy?: string;
  /** Agent turns the newest message set off so far, and the most it can. */
  turnsUsed: number;
  turnCap: number;
  /** Members asked here who haven't started (busy elsewhere, or waiting for a slot). */
  waiting: string[];
}

export interface RoomSent {
  message: AgentMessage;
  asked: AgentRef[];
}

export interface RoomChange {
  name?: string;
  members?: string[];
  /** `null` clears the lead. */
  lead?: string | null;
  muted?: boolean;
  /** An empty string clears it. */
  purpose?: string;
}

/** The registry changed: read `agents_rooms` again. */
export const ROOMS_EVENT = 'agents://rooms';

/** A room's place in the selection and the message store: never an agent id. */
export const ROOM_PREFIX = 'room:';
export const roomKey = (id: string) => `${ROOM_PREFIX}${id}`;
export const roomIdOf = (key: string | null | undefined): string | null =>
  key?.startsWith(ROOM_PREFIX) ? key.slice(ROOM_PREFIX.length) : null;

export const getRooms = () => invoke<Room[]>('agents_rooms');
export const createRoom = (members: string[], name?: string) =>
  invoke<Room>('agents_room_create', { members, name: name?.trim() || undefined });
export const updateRoom = (roomId: string, change: RoomChange) =>
  invoke<Room>('agents_room_update', { roomId, change });
export const deleteRoom = (roomId: string) => invoke<void>('agents_room_delete', { roomId });
export const getRoomMessages = (roomId: string, limit?: number, before?: string) =>
  invoke<AgentMessage[]>('agents_room_messages', { roomId, limit, before });
export const sendRoomMessage = (
  roomId: string,
  text: string,
  mentions: string[],
  everyone: boolean,
  attachments: OutgoingAttachment[] = []
) =>
  invoke<RoomSent>('agents_room_send', {
    roomId,
    text,
    mentions: mentions.length ? mentions : undefined,
    everyone: everyone || undefined,
    attachments: attachments.length ? attachments : undefined,
  });
export const focusRoom = (roomId: string | null) => invoke<void>('agents_room_focus', { roomId });
export const stopRoom = (roomId: string) => invoke<number>('agents_room_stop', { roomId });

/** The members still on the team, in the room's order. */
export function roomMembers(room: Pick<Room, 'members'>, agentsById: Map<string, Agent>): Agent[] {
  return room.members.flatMap((id) => {
    const agent = agentsById.get(id);
    return agent ? [agent] : [];
  });
}

/** The id the composer's mention menu uses for @everyone. Never an agent's. */
export const EVERYONE_ID = '@everyone';

/**
 * @everyone as a row in the mention menu. Only the fields the menu and the
 * matcher read are meaningful.
 */
export function everyoneEntry(memberCount: number): Agent {
  return {
    id: EVERYONE_ID,
    name: 'everyone',
    role: `All ${memberCount} in this room`,
    color: 'white',
  } as Agent;
}

/** Who a message in a room is for, as the composer reads it. */
export type Addressed =
  | { kind: 'named'; ids: string[] }
  | { kind: 'everyone' }
  | { kind: 'lead'; id: string }
  /** Nobody named and no lead: ask who should answer before sending. */
  | { kind: 'ask' };

export function addressed(text: string, members: Agent[], lead?: string): Addressed {
  // @everyone first: an agent named so before the name was reserved
  // (`store::validate_name`) doesn't take every member's message for itself.
  const found = mentionedAgents(text, [everyoneEntry(members.length), ...members]);
  if (found.some((a) => a.id === EVERYONE_ID)) return { kind: 'everyone' };
  const ids = members.filter((m) => found.includes(m)).map((m) => m.id);
  if (ids.length > 0) return { kind: 'named', ids };
  if (lead && members.some((m) => m.id === lead)) return { kind: 'lead', id: lead };
  return { kind: 'ask' };
}

/** "Finance", "Finance and Ops", "Finance, Ops and Design". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Under a message you sent: who it was for. "To everyone" when it asked every
 * member the room has (any size, @everyone or each by name), otherwise
 * "To Finance and Ops".
 */
export function askedLine(asked: AgentRef[], memberIds: string[]): string {
  const ids = new Set(asked.map((a) => a.id));
  const everyone = memberIds.length >= MIN_ROOM_MEMBERS && memberIds.every((id) => ids.has(id));
  return everyone ? 'To everyone' : `To ${listNames(asked.map((a) => a.name))}`;
}

/**
 * The composer's foot line: who will answer what you're typing. Shown so
 * nobody is surprised by who replies (or how many turns it can cost).
 */
export function addressLine(to: Addressed, members: Agent[]): string | null {
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  switch (to.kind) {
    case 'everyone':
      return `To everyone · ${members.length} replies`;
    case 'named':
      return `To ${listNames(to.ids.map(name))}`;
    case 'lead':
      return `To ${name(to.id)} · @ someone else, or @everyone`;
    case 'ask':
      return null;
  }
}

/** A room's members as they are now: who is answering here, and who will. */
export interface RoomActivity {
  /** Answering in this room right now. */
  working: Agent[];
  /** Asked here, still finishing something else or waiting for a slot. */
  waiting: Agent[];
}

export function roomActivity(room: Room, members: Agent[]): RoomActivity {
  const working = members.filter((a) => a.status.state !== 'idle' && a.status.room === room.id);
  const waiting = members.filter((a) => room.waiting.includes(a.id) && !working.includes(a));
  return { working, waiting };
}

/** The line under the room's working rows: how much of this message's budget is spent. */
export function turnsLine(room: Pick<Room, 'turnsUsed' | 'turnCap'>): string {
  return `${room.turnsUsed} of ${room.turnCap} replies for this message`;
}

/** Rooms in the sidebar: newest first. */
export function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * A name for a room before it's named, as the backend writes it: "Finance &
 * Ops", "Finance, Ops & Design", then "Finance & 3 others" rather than a
 * sentence of names.
 */
export function defaultRoomName(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'Room';
  if (names.length > 3) return `${names[0]} & ${names.length - 1} others`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/**
 * "Ask for changes" on a member's result in a room: a room message can't
 * revise one, so the member's own chat opens with the request staged in its
 * composer. Held here until that chat takes it.
 */
const handedRevisions = new Map<string, ResultRef>();

export function handRevisionTo(agentId: string, ref: ResultRef): void {
  handedRevisions.set(agentId, ref);
}

/** The revision a room handed this agent's chat, once. */
export function takeHandedRevision(agentId: string): ResultRef | null {
  const ref = handedRevisions.get(agentId) ?? null;
  handedRevisions.delete(agentId);
  return ref;
}
