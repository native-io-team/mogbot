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
  | { kind: 'pending'; key: string; pending: PendingSend; grouped: boolean }
  | { kind: 'draft'; key: string; text: string }
  | { kind: 'working'; key: string; label: string }
  /** What the agent said in a room, folded into one line that opens the room. */
  | { kind: 'room'; key: string; fold: RoomFold }
  /** "Setting up your team", where it was posted in the Chief's chat. */
  | { kind: 'setup'; key: typeof SETUP_KEY };

/**
 * A send's row key, the same while it's on its way and once the Mac has it
 * (the confirmed copy echoes the `clientId`). A new key there remounted the
 * row the moment the Mac answered: the bubble flashed, and the list glided
 * everything above it to make room for a row that was already there.
 */
export const sendKey = (clientId: string) => `send:${clientId}`;

/** A message's row key: a send from this phone keeps the key its pending row had. */
export const messageKey = (m: Pick<AgentMessage, 'id' | 'kind' | 'clientId'>) =>
  m.kind === 'user' && m.clientId ? sendKey(m.clientId) : m.id;

/** Whether a row is the one for this message id (a search hit, a card), whatever its key. */
export const isRowFor = (item: { key: string; kind: string; message?: AgentMessage }, id: string) =>
  item.key === id || (item.kind === 'message' && item.message?.id === id);

/**
 * Your unconfirmed sends, newest first, as the rows they'll become: the time
 * line and the run spacing worked out the same way as for the confirmed
 * copy, so nothing appears above the bubble or shifts when the Mac answers.
 * `prev` is the newest message before them.
 */
export function pendingItems(
  pending: PendingSend[],
  prev: { ts: number; you: boolean } | undefined,
  now: number
): (
  | { kind: 'pending'; key: string; pending: PendingSend; grouped: boolean }
  | {
      kind: 'day';
      key: string;
      label: string;
    }
)[] {
  const out: ReturnType<typeof pendingItems> = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    const before = i > 0 ? { ts: pending[i - 1].ts, you: true } : prev;
    const label = timeLabel(p.ts, before?.ts, now);
    const grouped = !label && !!before?.you && p.ts - before.ts <= RUN_MS;
    const key = sendKey(p.clientId);
    out.push({ kind: 'pending', key, pending: p, grouped });
    if (label) out.push({ kind: 'day', key: `day:${key}`, label });
  }
  return out;
}

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
  const rows = messages.some((m) => m.room) ? foldRoomLines(messages, agent.copy?.id) : messages;
  const last = rows[rows.length - 1];
  out.push(
    ...pendingItems(
      pending,
      last &&
        ('count' in last
          ? { ts: last.last.ts, you: false }
          : { ts: last.ts, you: side(last) === 'you' }),
      now
    )
  );
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
      out.push({ kind: 'message', key: messageKey(m), message: m, grouped });
    }
    if (label) out.push({ kind: 'day', key: `day:${messageKey(m)}`, label });
  }
  return out;
}

/**
 * The line above a message, or null for none: the day and time at the first
 * message of a day, the time alone after a pause of `GAP_MS` or more.
 */
export function timeLabel(ts: number, prevTs: number | undefined, now = Date.now()): string | null {
  // Days compared by their midnight; only a line that shows is worded. Wording
  // both sides of every message (a locale lookup each) was most of what a
  // 5,000-line chat cost to lay out, on every page and every status.
  if (prevTs === undefined || dayStart(prevTs) !== dayStart(ts))
    return `${dayLabel(ts, now)} ${formatClock(ts)}`;
  if (ts - prevTs >= GAP_MS) return formatClock(ts);
  return null;
}

/** Local midnight of the day `t` falls on. */
function dayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "Tuesday", "Nov 3" (`formatDate`): a day separator. */
export function dayLabel(ts: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return formatDate(ts, now);
}

/** When a message was sent, in full, for its long-press menu: "Today 2:40 PM". */
export const sentAt = (ts: number, now = Date.now()) => `${dayLabel(ts, now)} ${formatClock(ts)}`;
