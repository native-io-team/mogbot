/**
 * Rooms on the phone: group conversations of 2–6 agents (docs/mobile.md,
 * "Rooms"). Pure rules, so they're tested without React or a socket:
 *
 * - a room's thread is a chat in the store under `room:<id>`, beside the
 *   agents' own chats, so paging, upserts and the outbox work unchanged;
 * - a line said in a room reaches both the room and (when it names an
 *   agent) that agent's own chat, where it folds into one "In <room>" line;
 * - who a message goes to mirrors the Mac's routing (`rooms::resolve`):
 *   the members named, everyone, else the lead, else ask "Who should answer?".
 */

import {
  MAC_FEATURES,
  type Agent,
  type AgentMessage,
  type AgentRef,
  type RoomView,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';
import { formatClock, workingLine } from './agents';
import type { PendingSend } from './sync';
import { timeLabel, type Item } from './timeline';

const PREFIX = 'room:';

/** The store key for a room's thread. */
export const roomKey = (id: string) => `${PREFIX}${id}`;
export const isRoomKey = (key: string) => key.startsWith(PREFIX);
export const roomIdOf = (key: string) => (isRoomKey(key) ? key.slice(PREFIX.length) : null);

/** Every chat a line belongs in: its room's thread, and its agent's own chat. */
export function chatKeysOf(m: AgentMessage): string[] {
  if (!m.room) return [m.agentId];
  return m.agentId ? [roomKey(m.room), m.agentId] : [roomKey(m.room)];
}

/** Where a line's pending send lives: the room's key for a user line said in a room. */
export const pendingKeyOf = (m: AgentMessage) =>
  m.room && !m.agentId ? roomKey(m.room) : m.agentId;

/** The Mac does rooms, and says so. An older Mac's phone shows none. */
export function roomsOffered(welcome: WelcomeFrame | null | undefined): boolean {
  return (
    !!welcome?.features?.includes(MAC_FEATURES.rooms) &&
    welcome.methods.includes('rooms.list') &&
    welcome.methods.includes('rooms.send')
  );
}

/** The room's members as the overview knows them, in the room's order. */
export function membersOf(room: Pick<RoomView, 'members'>, agents: Agent[]): Agent[] {
  return room.members.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
}

/**
 * Who a message would go to: the members named (in the room's order), all
 * of them for @everyone, else the lead. `'ask'`: nobody, so ask first.
 */
export function answerers(
  room: Pick<RoomView, 'members' | 'lead'>,
  mentions: string[],
  everyone: boolean
): string[] | 'ask' {
  if (everyone) return room.members.slice();
  const named = room.members.filter((m) => mentions.includes(m));
  if (named.length) return named;
  if (room.lead && room.members.includes(room.lead)) return [room.lead];
  return 'ask';
}

/** `@everyone` typed in the text (whole word, any case). */
export const mentionsEveryone = (text: string) => /(^|\s)@everyone\b/i.test(text);

/** The pseudo-member the composer offers for @everyone. */
export const EVERYONE: AgentRef = { id: '*', name: 'everyone' };

/**
 * What the composer offers after `@`: the room's members (and @everyone)
 * whose name starts with what's typed. Never anyone outside the room.
 */
export function roomSuggestions(members: Agent[], query: string | null): AgentRef[] {
  if (query == null) return [];
  const q = query.toLowerCase();
  const list: AgentRef[] = members.map((a) => ({ id: a.id, name: a.name }));
  if (members.length > 1) list.push(EVERYONE);
  return list.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 7);
}

/** "to Finance · Ops", or "to everyone" when the whole room was asked. */
export function toLine(asked: AgentRef[] | undefined, memberCount: number): string | null {
  if (!asked?.length) return null;
  if (memberCount > 2 && asked.length === memberCount) return 'to everyone';
  return `to ${asked.map((a) => a.name).join(' · ')}`;
}

/** "Finance, Ops & Chief of Staff": the room's people, as the row's second line falls back to. */
export function memberNames(members: Pick<Agent, 'name'>[]): string {
  const names = members.map((m) => m.name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** Members whose turn in progress answers in this room. */
export const workingHere = (members: Agent[], roomId: string) =>
  members.filter((a) => a.status.state !== 'idle' && a.status.room === roomId);

/** A member's approval card in this room still waiting on you. */
export const pendingHere = (messages: AgentMessage[]) =>
  messages.some((m) => m.approval?.status === 'pending' && !!m.agentId);

/**
 * The room's row, in one line: who needs you, who's replying, else the
 * newest thing said (as the Mac wrote it: "Ops: Filed.").
 */
export function roomLine(room: RoomView, members: Agent[], messages?: AgentMessage[]): string {
  if (messages && pendingHere(messages)) return 'Needs your OK';
  const working = workingHere(members, room.id);
  if (working.length === 1) return `${working[0].name} is replying`;
  if (working.length > 1) return `${working.length} replying`;
  return room.preview ?? memberNames(members);
}

/** Rooms in the list's order: most recently active first. */
export const sortRooms = (rooms: RoomView[]) =>
  rooms.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt);

/** What the turn cap looks like while a round is going: "3 of 8 replies". */
export const turnsLine = (room: Pick<RoomView, 'turnsUsed' | 'turnCap'>) =>
  `${room.turnsUsed} of ${room.turnCap} replies for this message`;

/** One row of a room's list: an `Item`, or who is replying right now. */
export type RoomItem =
  | (Extract<Item, { kind: 'message' }> & { speaker: boolean })
  | Exclude<Item, { kind: 'message' } | { kind: 'working' } | { kind: 'draft' } | { kind: 'room' }>
  | { kind: 'draft'; key: string; text: string; agentId: string }
  | { kind: 'working'; key: string; label: string; agentId: string };

const RUN_MS = 5 * 60_000;
const speakerOf = (m: AgentMessage) => (m.kind === 'user' ? '' : m.agentId || 'room');

/**
 * A room as its list draws it, newest first: each replying member's draft
 * (or working line), your unconfirmed sends, then the thread. A member's
 * first line in a run carries its name (`speaker`), since several speak here.
 */
export function roomItems(
  roomId: string,
  members: Agent[],
  messages: AgentMessage[],
  pending: PendingSend[],
  drafts: Record<string, { id: string; text: string }>,
  now = Date.now()
): RoomItem[] {
  const out: RoomItem[] = [];
  const shown = new Set<string>();
  for (const a of workingHere(members, roomId)) {
    const d = drafts[a.id];
    if (d) {
      shown.add(d.id);
      out.push({ kind: 'draft', key: d.id, text: d.text, agentId: a.id });
    } else {
      out.push({ kind: 'working', key: `working:${a.id}`, label: workingLine(a), agentId: a.id });
    }
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    out.push({ kind: 'pending', key: `pending:${pending[i].clientId}`, pending: pending[i] });
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const prev = messages[i - 1];
    const label = timeLabel(m.ts, prev?.ts, now);
    if (!shown.has(m.id)) {
      const same = !!prev && speakerOf(prev) === speakerOf(m) && m.ts - prev.ts <= RUN_MS;
      const grouped = !label && same;
      const speaker = !!m.agentId && m.kind !== 'note' && !grouped;
      out.push({ kind: 'message', key: m.id, message: m, grouped, speaker });
    }
    if (label) out.push({ kind: 'day', key: `day:${m.id}`, label });
  }
  return out;
}

/** The newest line of a run folded into an agent's own chat, and how many it stands for. */
export interface RoomFold {
  roomId: string;
  count: number;
  last: AgentMessage;
}

/**
 * An agent's own chat with what it said in rooms folded: each run of lines
 * from one room becomes one "In <room>" line. A card still waiting on you
 * stays whole, so it can be answered from either chat.
 */
export function foldRoomLines(messages: AgentMessage[]): (AgentMessage | RoomFold)[] {
  const out: (AgentMessage | RoomFold)[] = [];
  for (const m of messages) {
    if (!m.room || m.approval?.status === 'pending') {
      out.push(m);
      continue;
    }
    const top = out[out.length - 1];
    if (top && 'count' in top && top.roomId === m.room) {
      out[out.length - 1] = { roomId: m.room, count: top.count + 1, last: m };
    } else {
      out.push({ roomId: m.room, count: 1, last: m });
    }
  }
  return out;
}

/** "In Month end · 3 messages · 4:12 PM": the folded line's words. */
export function foldLine(fold: RoomFold, roomName: string | undefined): string {
  const where = roomName ? `In ${roomName}` : 'In a room that was deleted';
  const what = fold.count === 1 ? '1 message' : `${fold.count} messages`;
  return `${where} · ${what} · ${formatClock(fold.last.ts)}`;
}
