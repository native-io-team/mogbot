/**
 * The phone's copy of the Mac's state, and the rules that keep it exact
 * (docs/mobile.md, "Events, cursors and resync"). Pure functions over plain
 * data, so the rules are tested without React or a socket:
 *
 * - messages are upserts by id, so a replayed or re-emitted one never doubles;
 * - a fetched page overwrites a row only if no newer event already wrote it
 *   (the row's seq ≤ the page's `asOf.seq`);
 * - drafts are appends at an offset, dropped when the offset disagrees;
 * - the cursor advances only after the event is applied.
 */

import { shareStructure } from './structure';
import type {
  AgentMessage,
  AgentsOverview,
  CompanionEvent,
  Cursor,
  MacStatus,
  ProjectSummary,
  Result,
  ResultRef,
  RoomView,
} from '@shipstudio/companion-protocol';
import { chatKeysOf, pendingKeyOf } from './rooms';
import {
  asMessage,
  asMessages,
  asOverview,
  asProject,
  asProjects,
  asRooms,
  asStatus,
} from './wellFormed';

export interface Chat {
  /** Oldest first. */
  messages: AgentMessage[];
  /** Older messages exist on the Mac. */
  more: boolean;
  /** A page has been fetched since the last snapshot. */
  loaded: boolean;
}

/** A message the user sent that the Mac hasn't confirmed yet. */
export interface PendingSend {
  clientId: string;
  /** The chat it shows in: an agent's id, or `room:<id>` for a room (with `roomId`). */
  agentId: string;
  /** Said in this room: sent with `rooms.send`. */
  roomId?: string;
  /** @everyone, in a room. */
  everyone?: boolean;
  text: string;
  ts: number;
  /** The Mac said no, or it waited too long: shown as "Not sent · Send". */
  failed: boolean;
  /**
   * The Mac refused it (a `!command`, an unknown `/command`, a removed
   * agent): final, so it's never offered to Send again, only to edit or
   * discard. `reason` is the Mac's own sentence.
   */
  refused?: boolean;
  reason?: string;
  /** Written while the Mac couldn't be reached: sent when it answers (outbox.ts). */
  waiting?: boolean;
  /** Already uploaded; shown from the phone's own copies until the Mac's arrive. */
  attachments?: PendingAttachment[];
  /** Agent ids @mentioned, sent with the text. */
  mentions?: string[];
  /** "Ask for changes": the result it revises (its id goes with the send). */
  revises?: ResultRef;
}

export interface PendingAttachment {
  blobId: string;
  uri: string;
  name: string;
  mime: string;
  size: number;
}

export interface Draft {
  id: string;
  text: string;
}

export interface SyncState {
  overview: AgentsOverview | null;
  mac: MacStatus | null;
  /** The last journaled event applied. Sent as `hello.resume`. */
  cursor: Cursor | null;
  chats: Record<string, Chat>;
  /** Message id → the seq it was last written at (from an event, or a page's `asOf`). */
  seqs: Record<string, number>;
  drafts: Record<string, Draft>;
  pending: Record<string, PendingSend[]>;
  /** When the phone last caught up with the Mac. */
  syncedAt: number | null;
  /** Open projects and their sessions; null until the Mac has said. */
  projects: ProjectSummary[] | null;
  /** Every room, on a Mac that does rooms; null until it has said. */
  rooms: RoomView[] | null;
}

export const emptySync = (): SyncState => ({
  overview: null,
  mac: null,
  cursor: null,
  chats: {},
  seqs: {},
  drafts: {},
  pending: {},
  syncedAt: null,
  projects: null,
  rooms: null,
});

const emptyChat = (): Chat => ({ messages: [], more: true, loaded: false });

const before = (a: AgentMessage, b: AgentMessage) => a.ts < b.ts || (a.ts === b.ts && a.id < b.id);

/** Insert or replace by id, keeping time order. */
export function upsert(list: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const at = list.findIndex((m) => m.id === message.id);
  if (at !== -1 && list[at].ts === message.ts) {
    const next = list.slice();
    next[at] = message;
    return next;
  }
  const rest = at === -1 ? list : list.filter((m) => m.id !== message.id);
  let i = rest.length;
  while (i > 0 && before(message, rest[i - 1])) i--;
  return [...rest.slice(0, i), message, ...rest.slice(i)];
}

export function applyEvent(s: SyncState, event: CompanionEvent, cursor?: Cursor): SyncState {
  const next = reduce(s, event, cursor);
  return cursor ? { ...next, cursor } : next;
}

function reduce(s: SyncState, event: CompanionEvent, cursor?: Cursor): SyncState {
  switch (event.type) {
    case 'agents.message': {
      // From a Mac of another version it may not be the shape this phone
      // knows: made safe to draw, or left out when it isn't a message.
      const m = asMessage(event.message);
      if (!m) return s;
      // A replayed or overtaken event for a row already written at a later
      // seq in this epoch (a newer event, or a page read after it): applying
      // it would put the older copy back (an answered card turning pending).
      const written = s.seqs[m.id];
      if (
        cursor &&
        s.cursor?.epoch === cursor.epoch &&
        written != null &&
        written !== Number.MAX_SAFE_INTEGER &&
        written > cursor.seq
      ) {
        return s;
      }
      // A line said in a room goes in the room's thread and its agent's own chat.
      const chats = { ...s.chats };
      for (const key of chatKeysOf(m)) {
        const chat = chats[key] ?? emptyChat();
        chats[key] = { ...chat, messages: upsert(chat.messages, m) };
      }
      const drafts = { ...s.drafts };
      if (m.agentId && drafts[m.agentId]?.id === m.id) delete drafts[m.agentId];
      return {
        ...s,
        chats,
        seqs: { ...s.seqs, [m.id]: cursor?.seq ?? Number.MAX_SAFE_INTEGER },
        drafts,
        pending: settlePending(s.pending, m),
      };
    }
    case 'agents.status': {
      // An overview from the offline copy or a Mac of another shape may
      // have no list of agents: nothing to mark; the next overview brings it.
      if (!s.overview || !Array.isArray(s.overview.agents)) return s;
      if (typeof event.agentId !== 'string') return s;
      const status = asStatus(event.status);
      const agents = s.overview.agents.map((a) =>
        a?.id === event.agentId ? { ...a, status } : a
      );
      return { ...s, overview: { ...s.overview, agents } };
    }
    case 'agents.registry': {
      // Unreadable: what's shown stays until a readable one comes.
      const overview = asOverview(event.overview);
      return overview ? { ...s, overview: shareStructure(s.overview, overview) } : s;
    }
    case 'rooms.changed': {
      const rooms = asRooms(event.rooms);
      return rooms ? { ...s, rooms } : s;
    }
    case 'system.status':
      return { ...s, mac: event.status };
    case 'agents.draft':
      // The reply it streams is already here (the draft event was overtaken
      // by its finished message, or replayed): a second, growing copy would
      // sit under it until the turn ends.
      if (s.chats[event.agentId]?.messages.some((m) => m.id === event.id)) return s;
      return { ...s, drafts: applyDraft(s.drafts, event) };
    case 'sync.snapshot':
      // Seqs from another epoch can't be compared with anything new: forget
      // them so the re-fetch overwrites. Drafts restart from 0 anyway.
      return {
        ...s,
        overview: shareStructure(s.overview, asOverview(event.overview) ?? s.overview),
        mac: event.status,
        projects: shareStructure(s.projects, asProjects(event.projects) ?? s.projects),
        cursor: event.cursor,
        seqs: {},
        drafts: {},
        chats: Object.fromEntries(
          Object.entries(s.chats).map(([id, chat]) => [id, { ...chat, loaded: false }])
        ),
      };
    case 'sync.caughtUp':
      return { ...s, cursor: event.cursor, syncedAt: Date.now() };
    case 'projects.changed': {
      const project = asProject(event.project);
      return project ? { ...s, projects: upsertProject(s.projects ?? [], project) } : s;
    }
    case 'projects.removed':
      return { ...s, projects: (s.projects ?? []).filter((p) => p.path !== event.path) };
    default:
      // Alerts are handled by the session, not stored.
      return s;
  }
}

function upsertProject(list: ProjectSummary[], project: ProjectSummary): ProjectSummary[] {
  const at = list.findIndex((p) => p.path === project.path);
  if (at === -1) return [...list, project];
  const next = list.slice();
  next[at] = project;
  return next;
}

/**
 * The confirmed copy of a pending send arrived (as an event, which the Mac
 * sends before the response): matched by the `clientId` it echoes. A Mac
 * from before `clientId` echoes nothing, so there the text is all there is
 * to go on; the response settles it by id regardless.
 */
export function settlePending(
  pending: SyncState['pending'],
  m: AgentMessage
): SyncState['pending'] {
  const key = pendingKeyOf(m);
  const list = pending[key];
  if (m.kind !== 'user' || !list?.length) return pending;
  const at = m.clientId
    ? list.findIndex((p) => p.clientId === m.clientId)
    : list.findIndex((p) => p.text === m.text);
  if (at === -1) return pending;
  return { ...pending, [key]: list.filter((_, i) => i !== at) };
}

function applyDraft(
  drafts: Record<string, Draft>,
  e: Extract<CompanionEvent, { type: 'agents.draft' }>
): Record<string, Draft> {
  const held = drafts[e.agentId];
  // Withdrawn: the Mac found it was a progress line and put it in the
  // timeline instead. No bubble, no typing dots for it.
  if (e.from === 0 && e.text === '') {
    if (!held || held.id !== e.id) return drafts;
    const next = { ...drafts };
    delete next[e.agentId];
    return next;
  }
  if (e.from === 0) return { ...drafts, [e.agentId]: { id: e.id, text: e.text } };
  if (held?.id === e.id && held.text.length === e.from) {
    return { ...drafts, [e.agentId]: { id: e.id, text: held.text + e.text } };
  }
  // Out of step: drop it and wait for a restart from 0 or the finished message.
  if (!held) return drafts;
  const next = { ...drafts };
  delete next[e.agentId];
  return next;
}

/** Merge a page from `agents.messages`. `older`: it was fetched with `before`. */
export function mergePage(
  s: SyncState,
  agentId: string,
  page: Result<'agents.messages'>,
  older: boolean
): SyncState {
  const chat = s.chats[agentId] ?? emptyChat();
  const comparable = !!page.asOf && s.cursor?.epoch === page.asOf.epoch;
  let messages = chat.messages;
  const seqs = { ...s.seqs };
  for (const m of asMessages(page.messages)) {
    const written = seqs[m.id];
    // An event newer than this read already wrote the row: keep it.
    if (comparable && written != null && written > page.asOf.seq) continue;
    messages = upsert(messages, m);
    seqs[m.id] = page.asOf?.seq ?? 0;
  }
  const pageMore = page.more === true;
  const more = older || !chat.loaded ? pageMore : chat.more || pageMore;
  return { ...s, seqs, chats: { ...s.chats, [agentId]: { messages, more, loaded: true } } };
}

export function addPending(s: SyncState, p: PendingSend): SyncState {
  return { ...s, pending: { ...s.pending, [p.agentId]: [...(s.pending[p.agentId] ?? []), p] } };
}

/** The Mac answered a send: drop the pending copy and keep the real one. */
export function confirmSend(s: SyncState, clientId: string, sent: AgentMessage): SyncState {
  const message = asMessage(sent);
  // No usable copy came back: the send is settled, the event or a page brings the row.
  if (!message) {
    return {
      ...s,
      pending: Object.fromEntries(
        Object.entries(s.pending).map(([k, l]) => [k, l.filter((p) => p.clientId !== clientId)])
      ),
    };
  }
  const key = pendingKeyOf(message);
  const list = (s.pending[key] ?? []).filter((p) => p.clientId !== clientId);
  const chat = s.chats[key] ?? emptyChat();
  // The event usually got here first and is at least as new; only fill a gap.
  const known = chat.messages.some((m) => m.id === message.id);
  return {
    ...s,
    pending: { ...s.pending, [key]: list },
    chats: known
      ? s.chats
      : { ...s.chats, [key]: { ...chat, messages: upsert(chat.messages, message) } },
  };
}

export function setPendingFailed(
  s: SyncState,
  agentId: string,
  clientId: string,
  failed: boolean,
  waiting = false,
  /** The Mac's reason, when it refused the send (a refusal is final). */
  refusal?: string
): SyncState {
  const list = (s.pending[agentId] ?? []).map((p) => {
    if (p.clientId !== clientId) return p;
    const { refused: _r, reason: _why, ...rest } = p;
    return refusal !== undefined && failed
      ? { ...rest, failed, waiting: false, refused: true, reason: refusal }
      : { ...rest, failed, waiting };
  });
  return { ...s, pending: { ...s.pending, [agentId]: list } };
}
