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
  newestResults,
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

/**
 * What a room is, under its first line. True to how a room turn runs
 * (docs/agents.md, "Rooms"): it resumes the member's own engine session, so
 * an agent answers here remembering its own chat, and what's said here is
 * posted for every member. Never "sees only what's said here".
 */
export const ROOM_INTRO =
  'Everything said here is posted for everyone in the room. Each agent keeps its own memory and remembers its own chat when it answers here.';

/** "Finance", "Finance and Ops", "Finance, Ops and Design": as the desk joins names (`listNames`). */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Under your line: "To Finance and Ops", or "To everyone" when every member
 * was asked, however many there are.
 */
export function toLine(asked: AgentRef[] | undefined, memberCount: number): string | null {
  if (!asked?.length) return null;
  if (memberCount > 1 && asked.length >= memberCount) return 'To everyone';
  return `To ${listNames(asked.map((a) => a.name))}`;
}

/** "Finance, Ops and Chief of Staff": the room's people, as the row's second line falls back to. */
export function memberNames(members: Pick<Agent, 'name'>[]): string {
  return listNames(members.map((m) => m.name));
}

/**
 * The composer's foot line, word for word the desk's (`addressLine`): who
 * will answer what you're typing, so nobody is surprised by who replies.
 */
export function addressLine(
  room: Pick<RoomView, 'members' | 'lead'>,
  members: Pick<Agent, 'id' | 'name'>[],
  mentions: string[],
  everyone: boolean
): string {
  const to = answerers(room, mentions, everyone);
  if (to === 'ask') return 'Who should answer? @ someone';
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? '';
  if (everyone) return `To everyone · ${to.length} replies`;
  if (!mentions.some((m) => room.members.includes(m))) {
    return `To ${name(to[0])} · @ someone else, or @everyone`;
  }
  return `To ${listNames(to.map(name))}`;
}

/**
 * A line cut where it @mentions a member, by whole name (longest first, as
 * the Mac's `rooms::mentioned_in` reads them), so the mention can be drawn in
 * that member's colour. Never an email address, never a name inside a word.
 */
export function splitMentions(text: string, names: string[]): { text: string; name?: string }[] {
  const sorted = names.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length || !text.includes('@')) return [{ text }];
  const out: { text: string; name?: string }[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const before = i === 0 ? '' : text[i - 1];
    if (text[i] === '@' && !/[\w.]/.test(before)) {
      const rest = text.slice(i + 1);
      const hit = sorted.find(
        (n) =>
          rest.slice(0, n.length).toLowerCase() === n.toLowerCase() &&
          !/^[\w@-]/.test(rest.slice(n.length))
      );
      if (hit) {
        if (plain) out.push({ text: plain });
        plain = '';
        out.push({ text: `@${rest.slice(0, hit.length)}`, name: hit });
        i += hit.length + 1;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Members whose turn in progress answers in this room (a member waiting on your OK isn't replying). */
export const workingHere = (members: Agent[], roomId: string) =>
  members.filter((a) => a.status.state === 'working' && a.status.room === roomId);

/** Members whose turn in this room is stopped on a card for you. */
export const askingHere = (members: Agent[], roomId: string) =>
  members.filter((a) => a.status.state === 'waiting' && a.status.room === roomId);

/** Members with a turn in progress here, working or waiting on you: their draft stays on screen. */
const activeHere = (members: Agent[], roomId: string) =>
  members.filter((a) => a.status.state !== 'idle' && a.status.room === roomId);

/** A member's approval card in this room still waiting on you. */
export const pendingHere = (messages: AgentMessage[]) =>
  messages.some((m) => m.approval?.status === 'pending' && !!m.agentId);

/**
 * The room's row, in one line: who needs you, who's replying, else the
 * newest thing said (as the Mac wrote it: "Ops: Filed.").
 */
export function roomLine(room: RoomView, members: Agent[], messages?: AgentMessage[]): string {
  if (askingHere(members, room.id).length || (messages && pendingHere(messages))) {
    return 'Needs your OK';
  }
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
  | Exclude<
      Item,
      | { kind: 'message' }
      | { kind: 'working' }
      | { kind: 'draft' }
      | { kind: 'room' }
      | { kind: 'setup' }
    >
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
  for (const a of activeHere(members, roomId)) {
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

/**
 * Each member's open copy of its project: the newest change card in this
 * room for it offers Keep / Discard, as in that member's own chat (the
 * desk's `RoomChat`). A member with no open copy, or whose copy's card
 * isn't in the room, has none here; nor does one whose own chat (`own`, as
 * far as this phone has it) holds a newer card for that copy, since this
 * one no longer lists everything Keep would bring over.
 */
export function liveCopyCards(
  members: Pick<Agent, 'id' | 'copy'>[],
  messages: AgentMessage[],
  own: Record<string, AgentMessage[] | undefined> = {}
): Set<string> {
  const live = new Set<string>();
  const newest = (list: AgentMessage[] | undefined, agentId: string, copyId: string) => {
    for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
      const m = list![i];
      if (m.agentId === agentId && m.kind === 'changes' && m.changes?.copy?.id === copyId) return m;
    }
    return undefined;
  };
  for (const member of members) {
    const copyId = member.copy?.id;
    if (!copyId) continue;
    const card = newest(messages, member.id, copyId);
    if (!card) continue;
    const there = newest(own[member.id], member.id, copyId);
    if (there && there.id !== card.id && there.ts > card.ts) continue;
    live.add(card.id);
  }
  return live;
}

/**
 * Each result's newest version in this room, counting the versions in its
 * member's own chat (`own`): an older card here doesn't offer Ask for changes
 * once a newer one was made there.
 */
export function newestRoomResults(
  messages: AgentMessage[],
  own: Record<string, AgentMessage[] | undefined> = {}
): Set<string> {
  // The room's copy last, so a version in both counts as the room's.
  const all = [...Object.values(own).flatMap((l) => l ?? []), ...messages];
  return new Set(newestResults(all).values());
}

/** Members to read the newest page of, so the checks above see their own chats. */
export const membersWithCards = (members: Agent[], messages: AgentMessage[]) =>
  members.filter((a) =>
    messages.some((m) => m.agentId === a.id && (m.kind === 'changes' || !!m.result))
  );

/** The newest line of a run folded into an agent's own chat, and how many it stands for. */
export interface RoomFold {
  roomId: string;
  count: number;
  last: AgentMessage;
}

/**
 * An agent's own chat with what it said in rooms folded: each run of lines
 * from one room becomes one "In <room>" line. A card still waiting on you
 * stays whole, so it can be answered from either chat, and so does a change
 * card for the agent's open copy (`openCopy`), so Keep / Discard are here too.
 */
export function foldRoomLines(
  messages: AgentMessage[],
  openCopy?: string
): (AgentMessage | RoomFold)[] {
  const out: (AgentMessage | RoomFold)[] = [];
  for (const m of messages) {
    const copyCard = !!openCopy && m.kind === 'changes' && m.changes?.copy?.id === openCopy;
    if (!m.room || m.approval?.status === 'pending' || copyCard) {
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
