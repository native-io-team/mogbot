/**
 * A conversation as the list draws it, newest first (the list is inverted):
 * the reply being written or the working line, your unconfirmed sends, then
 * the messages. Time is told the way iMessage and Grok tell it: a centred
 * line where the day changes or the conversation picks up after a pause, not
 * a clock under every bubble. Messages from the same side in a run sit closer
 * together (`grouped`). Pure, so it's tested.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import { formatClock, formatDate, workingLine } from './agents';
import { isImportInterview } from './bars';
import { foldRoomLines, type RoomFold } from './rooms';
import type { PendingSend } from './sync';

export type Item =
  | { kind: 'message'; key: string; message: AgentMessage; grouped: boolean }
  | { kind: 'day'; key: string; label: string }
  | { kind: 'pending'; key: string; pending: PendingSend }
  | { kind: 'draft'; key: string; text: string }
  | { kind: 'working'; key: string; label: string }
  /** What the agent said in a room, folded into one line that opens the room. */
  | { kind: 'room'; key: string; fold: RoomFold }
  /** "Setting up your team", where it was posted in the Chief's chat. */
  | { kind: 'setup'; key: typeof SETUP_KEY };

/** The setup card's row: one per chat, so its key is fixed. */
export const SETUP_KEY = 'team-setup';

const itemTs = (item: Item): number | null =>
  item.kind === 'message' ? item.message.ts : item.kind === 'room' ? item.fold.last.ts : null;

/**
 * The list with "Setting up your team" at its place, newest first: under
 * (newer than) everything said up to `anchor`, when it was posted, and above
 * what came after, the time line that opens it included. Never pinned under
 * the newest message. Left out while its place is older than what's loaded
 * (`more`); with no time known, it goes under the newest message.
 */
export function withSetupCard(items: Item[], anchor: number | null, more: boolean): Item[] {
  const card: Item = { kind: 'setup', key: SETUP_KEY };
  const first = items.findIndex((i) => itemTs(i) !== null);
  if (first < 0) return more ? items : [...items, card];
  if (anchor === null) {
    // No time known (an older Mac, its import out of reach): under the newest message.
    return [...items.slice(0, first), card, ...items.slice(first)];
  }
  const at = items.findIndex((i) => {
    const ts = itemTs(i);
    return ts !== null && ts <= anchor;
  });
  if (at < 0) return more ? items : [...items, card];
  return [...items.slice(0, at), card, ...items.slice(at)];
}

/** Messages closer than this, from the same side, are one run: drawn close together. */
const RUN_MS = 5 * 60_000;
/** A pause this long (same day) gets its own time line. */
export const GAP_MS = 30 * 60_000;
const side = (m: AgentMessage) => (m.kind === 'user' ? 'you' : 'them');

/**
 * The list, newest first: the draft or working line, unconfirmed sends, then
 * messages, with a time line above the first message of each day ("Today
 * 2:40 PM") and above any that follows a pause ("4:12 PM").
 */
export function chatItems(
  agent: Agent,
  messages: AgentMessage[],
  pending: PendingSend[],
  draft: { id: string; text: string } | undefined,
  now = Date.now()
): Item[] {
  const out: Item[] = [];
  // A reply being written in a room streams there, not here: this chat
  // only says it's working, and folds the reply once it lands.
  if (agent.status.room) draft = undefined;
  if (draft) out.push({ kind: 'draft', key: draft.id, text: draft.text });
  else if (agent.status.state === 'working')
    out.push({
      kind: 'working',
      key: 'working',
      // Mid-import the bar above the composer says it; the row keeps its dots.
      label: isImportInterview(agent.status.activity) ? '' : workingLine(agent),
    });
  for (let i = pending.length - 1; i >= 0; i--) {
    out.push({ kind: 'pending', key: `pending:${pending[i].clientId}`, pending: pending[i] });
  }
  const rows = messages.some((m) => m.room) ? foldRoomLines(messages, agent.copy?.id) : messages;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const before = rows[i - 1];
    if ('count' in row) {
      const prevTs = before ? ('count' in before ? before.last.ts : before.ts) : undefined;
      const label = timeLabel(row.last.ts, prevTs, now);
      out.push({ kind: 'room', key: `room:${row.last.id}`, fold: row });
      if (label) out.push({ kind: 'day', key: `day:${row.last.id}`, label });
      continue;
    }
    const m = row;
    const prev = before && 'count' in before ? before.last : before;
    const label = timeLabel(m.ts, prev?.ts, now);
    // A draft that became its message keeps its key, so the row never remounts.
    if (!(draft && m.id === draft.id)) {
      const grouped = !label && !!prev && side(prev) === side(m) && m.ts - prev.ts <= RUN_MS;
      out.push({ kind: 'message', key: m.id, message: m, grouped });
    }
    if (label) out.push({ kind: 'day', key: `day:${m.id}`, label });
  }
  return out;
}

/**
 * The line above a message, or null for none: the day and time at the first
 * message of a day, the time alone after a pause of `GAP_MS` or more.
 */
export function timeLabel(ts: number, prevTs: number | undefined, now = Date.now()): string | null {
  const day = dayLabel(ts, now);
  if (prevTs === undefined || dayLabel(prevTs, now) !== day) return `${day} ${formatClock(ts)}`;
  if (ts - prevTs >= GAP_MS) return formatClock(ts);
  return null;
}

/** "Today", "Yesterday", "Tuesday", "Nov 3" (`formatDate`): a day separator. */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return formatDate(ts, now);
}

/** When a message was sent, in full, for its long-press menu: "Today 2:40 PM". */
export const sentAt = (ts: number, now = Date.now()) => `${dayLabel(ts, now)} ${formatClock(ts)}`;
