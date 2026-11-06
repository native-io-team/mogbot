/**
 * Agents — the frontend store.
 *
 * A `useSyncExternalStore` source over the agents commands. The backend is the
 * authority and pushes four events: `registry` (the list changed: reload it),
 * `status` (an agent started, is doing something, or went idle), `message`
 * (a new or updated chat line), and `draft` (a reply still being written).
 * Messages are kept only for chats that have been opened in this session,
 * newest page first and older pages as you scroll up; a draft is kept for any
 * agent until the message that completes it (same id) arrives or the turn ends.
 *
 * Components subscribe to a slice (`useAgentsSelector`), never the whole
 * state: a reply streaming in another chat updates the store every 40 ms, and
 * that must not re-render the app, the sidebar or the chat on screen.
 *
 * @module lib/agentsStore
 */

import { useRef, useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AGENT_EVENTS,
  getAgentMessages,
  getAgentsOverview,
  needsYou,
  type Agent,
  type AgentMessage,
  type AgentStatus,
  type EngineInfo,
  type NewAgentDefaults,
  type AgentIndependence,
  type ImportChoice,
} from './agents';
import { asCommandError, formatCommandError } from './errors';
import { logger } from './logger';
import { getRoomMessages, getRooms, roomKey, ROOMS_EVENT, type Room } from './agentRooms';

export interface AgentsState {
  agents: Agent[];
  engineReady: boolean;
  engines: EngineInfo[];
  /** What new agents start on (Settings → Agents); null until the overview says. */
  defaults: NewAgentDefaults | null;
  /** How much agents do on their own; null until the overview says. */
  independence: AgentIndependence | null;
  /** "Bring your agents, or start fresh?" answered; null until the overview says. */
  importChoice: ImportChoice | null;
  loaded: boolean;
  error: string | null;
  /** Chat lines per agent, oldest first; absent until that chat is opened. */
  messages: Record<string, AgentMessage[]>;
  /** Chats with lines older than the ones loaded. */
  older: Record<string, boolean>;
  /** The reply each agent is writing right now, if any. */
  drafts: Record<string, AgentMessage>;
  /** Group conversations (`lib/agentRooms`); a room's thread is `messages[roomKey(id)]`. */
  rooms: Room[];
  /** The rooms have been read once (an open room that isn't there is gone). */
  roomsLoaded: boolean;
}

let state: AgentsState = {
  agents: [],
  engineReady: true,
  engines: [],
  defaults: null,
  independence: null,
  importChoice: null,
  loaded: false,
  error: null,
  messages: {},
  older: {},
  drafts: {},
  rooms: [],
  roomsLoaded: false,
};
const listeners = new Set<() => void>();
let unlistens: UnlistenFn[] = [];
let generation = 0;
let refreshTimer: number | null = null;

function emit(next: AgentsState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getAgentsSnapshot(): AgentsState {
  return state;
}

export async function refreshAgents(): Promise<void> {
  try {
    const overview = await getAgentsOverview();
    emit({
      ...state,
      agents: keepUnchanged(state.agents, overview.agents),
      engineReady: overview.engineReady,
      // Kept when unchanged, like the agents: a new array re-renders everything reading it.
      engines: sameJson(state.engines, overview.engines ?? [])
        ? state.engines
        : (overview.engines ?? []),
      defaults: overview.defaults ?? null,
      independence: overview.independence ?? null,
      importChoice: overview.importChoice ?? null,
      loaded: true,
      error: null,
    });
  } catch (error) {
    logger.error('[Agents] overview failed', { error: String(error) });
    emit({ ...state, loaded: true, error: formatCommandError(asCommandError(error)) });
  }
}

/**
 * A reload returns every agent anew, though usually one row changed. Keep the
 * objects (and the list) that didn't, so only what changed re-renders.
 */
function keepUnchanged(previous: Agent[], next: Agent[]): Agent[] {
  const before = new Map(previous.map((a) => [a.id, a]));
  let same = previous.length === next.length;
  const merged = next.map((agent, i) => {
    const old = before.get(agent.id);
    if (old && sameJson(old, agent)) {
      if (previous[i] !== old) same = false;
      return old;
    }
    same = false;
    return agent;
  });
  return same ? previous : merged;
}

export async function refreshRooms(): Promise<void> {
  try {
    const rooms = await getRooms();
    const same =
      rooms.length === state.rooms.length &&
      rooms.every((r, i) => JSON.stringify(r) === JSON.stringify(state.rooms[i]));
    if (!same || !state.roomsLoaded) emit({ ...state, rooms, roomsLoaded: true });
  } catch (error) {
    logger.error('[Agents] rooms failed', { error: String(error) });
  }
}

let roomsTimer: number | null = null;
function scheduleRoomsRefresh() {
  if (roomsTimer !== null) return;
  roomsTimer = window.setTimeout(() => {
    roomsTimer = null;
    void refreshRooms();
  }, 120);
}

/** (Re)load a room's newest page. */
export function loadRoomMessages(roomId: string): Promise<void> {
  return loadNewest(roomKey(roomId), () => getRoomMessages(roomId, MESSAGE_PAGE), {
    roomId,
  });
}

/** The page before the oldest room line loaded. */
export async function loadOlderRoomMessages(roomId: string): Promise<void> {
  const key = roomKey(roomId);
  const loaded = state.messages[key];
  if (!loaded || !state.older[key]) return;
  try {
    const page = await getRoomMessages(roomId, MESSAGE_PAGE, loaded[0]?.id);
    const current = state.messages[key] ?? [];
    const have = new Set(current.map((m) => m.id));
    const fresh = page.filter((m) => !have.has(m.id));
    setMessages(key, [...fresh, ...current], fresh.length > 0 && page.length >= MESSAGE_PAGE);
  } catch (error) {
    logger.error('[Agents] older room messages failed', { roomId, error: String(error) });
  }
}

/**
 * Deep equality for JSON values: what comparing the two `JSON.stringify`s
 * said, without building both strings (a working agent's timeline makes them
 * long) and stopping at the first difference. Like `JSON.stringify`, key
 * order counts and a key whose value is `undefined` counts as absent.
 */
// NaN and the infinities stringify as null.
const asJson = (v: unknown) => (typeof v === 'number' && !isFinite(v) ? null : v);

export function sameJson(x0: unknown, y0: unknown): boolean {
  const a = asJson(x0);
  const b = asJson(y0);
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const mine = a as unknown[];
    const other = b as unknown[];
    if (mine.length !== other.length) return false;
    for (let i = 0; i < mine.length; i++) {
      // In an array, undefined (like a function) stringifies as null.
      const x = mine[i] === undefined ? null : mine[i];
      const y = other[i] === undefined ? null : other[i];
      if (!sameJson(x, y)) return false;
    }
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  // In key order, as the strings would have been.
  const keys = Object.keys(x).filter((k) => x[k] !== undefined);
  const others = Object.keys(y).filter((k) => y[k] !== undefined);
  if (keys.length !== others.length) return false;
  return keys.every((k, i) => k === others[i] && sameJson(x[k], y[k]));
}

/** Coalesce bursts of registry events (every message bumps the row). */
function scheduleRefresh() {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshAgents();
  }, 120);
}

/** Lines a chat opens with; older ones load a page at a time as you scroll up. */
export const MESSAGE_PAGE = 150;
/** The most `agents_messages` returns in one call. */
export const MESSAGE_MAX = 5000;

function setMessages(agentId: string, messages: AgentMessage[], older: boolean) {
  emit({
    ...state,
    messages: { ...state.messages, [agentId]: messages },
    older: { ...state.older, [agentId]: older },
  });
}

/**
 * Put a line in a chat: replaced where it is when it's already there (an
 * approval answered, a reply edited), otherwise after the last line no newer
 * than it. Events usually arrive in order, so that's the end; one that was
 * overtaken (a slow emit, a page read while it was written) still lands in
 * its place instead of below lines written after it.
 */
export function placeLine(list: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index !== -1) {
    if (list[index] === message) return list;
    return list.map((m, i) => (i === index ? message : m));
  }
  let at = list.length;
  while (at > 0 && list[at - 1].ts > message.ts) at--;
  return at === list.length
    ? [...list, message]
    : [...list.slice(0, at), message, ...list.slice(at)];
}

/**
 * A newest page, read while the chat may already hold lines: older pages
 * scrolled in, and lines that arrived as events. Older lines above the page
 * stay (a reload never throws away what you scrolled to); lines that arrived
 * after the read stay too, and an event that came in during the read wins
 * over the page's older copy of its line.
 */
export function mergeNewest(
  current: AgentMessage[] | undefined,
  page: AgentMessage[],
  arrived: AgentMessage[]
): { messages: AgentMessage[]; keptOlder: boolean } {
  const inPage = new Set(page.map((m) => m.id));
  let merged = page;
  let keptOlder = false;
  if (current?.length && page.length) {
    const first = current.findIndex((m) => m.id === page[0].id);
    // No overlap means a gap between what was held and this page: start from the page.
    if (first > 0) {
      merged = [...current.slice(0, first), ...page];
      keptOlder = true;
    }
    if (first !== -1) {
      for (const m of current.slice(first)) if (!inPage.has(m.id)) merged = placeLine(merged, m);
    }
  } else if (current?.length) {
    merged = current;
    keptOlder = true;
  }
  for (const m of arrived) merged = placeLine(merged, m);
  return { messages: merged, keptOlder };
}

/** Lines that arrived as events while a chat's newest page was being read. */
const arriving = new Map<string, AgentMessage[]>();
/** One newest-page read per chat at a time. */
const loadingNewest = new Map<string, Promise<void>>();

function loadNewest(
  key: string,
  read: () => Promise<AgentMessage[]>,
  context: Record<string, string>
): Promise<void> {
  const inFlight = loadingNewest.get(key);
  if (inFlight) return inFlight;
  arriving.set(key, []);
  const request = read()
    .then((page) => {
      const { messages, keptOlder } = mergeNewest(
        state.messages[key],
        page,
        arriving.get(key) ?? []
      );
      const older = keptOlder ? (state.older[key] ?? false) : page.length >= MESSAGE_PAGE;
      setMessages(key, messages, older);
    })
    .catch((error: unknown) => {
      logger.error('[Agents] messages failed', { ...context, error: String(error) });
      // Whatever arrived while it failed is still worth showing.
      const { messages } = mergeNewest(state.messages[key], [], arriving.get(key) ?? []);
      setMessages(key, messages, state.older[key] ?? false);
    })
    .finally(() => {
      arriving.delete(key);
      loadingNewest.delete(key);
    });
  loadingNewest.set(key, request);
  return request;
}

/** (Re)load a chat's newest page. */
export function loadMessages(agentId: string): Promise<void> {
  return loadNewest(agentId, () => getAgentMessages(agentId, MESSAGE_PAGE), { agentId });
}

/** One request per chat at a time: a scroll and a search jump can both ask. */
const loadingOlder = new Map<string, Promise<void>>();

/**
 * Load the page before the oldest line loaded, or with `through`, every line
 * back to that one (a search hit). Resolves once the store has them.
 */
export function loadOlderMessages(agentId: string, through?: string): Promise<void> {
  const inFlight = loadingOlder.get(agentId);
  if (inFlight)
    return inFlight.then(() => (through ? loadOlderMessages(agentId, through) : undefined));
  const loaded = state.messages[agentId];
  if (!loaded || !state.older[agentId] || (through && loaded.some((m) => m.id === through))) {
    return Promise.resolve();
  }
  const request = getAgentMessages(agentId, MESSAGE_PAGE, { before: loaded[0]?.id, through })
    .then((page) => {
      const current = state.messages[agentId] ?? [];
      const have = new Set(current.map((m) => m.id));
      const fresh = page.filter((m) => !have.has(m.id));
      // Nothing new (a backend that ignores the cursor) means nothing older either.
      setMessages(agentId, [...fresh, ...current], fresh.length > 0 && page.length >= MESSAGE_PAGE);
    })
    .catch((error: unknown) => {
      logger.error('[Agents] older messages failed', { agentId, error: String(error) });
    })
    .finally(() => loadingOlder.delete(agentId));
  loadingOlder.set(agentId, request);
  return request;
}

function withoutDraft(agentId: string, id?: string): AgentsState['drafts'] {
  const draft = state.drafts[agentId];
  if (!draft || (id !== undefined && draft.id !== id)) return state.drafts;
  const { [agentId]: _gone, ...rest } = state.drafts;
  return rest;
}

/**
 * Insert or replace a chat line (approvals are updated in place). The line
 * that completes a draft replaces it in the same render, so nothing flickers.
 */
export function upsertMessage(message: AgentMessage) {
  noteFinished(message.id);
  const drafts = message.agentId ? withoutDraft(message.agentId, message.id) : state.drafts;
  // A member's line said in a room is in both its own chat and the room's thread.
  const keys = [message.agentId, message.room ? roomKey(message.room) : ''].filter(Boolean);
  let messages = state.messages;
  for (const key of keys) {
    // A page is being read: this line may be newer than what it returns.
    arriving.get(key)?.push(message);
    const existing = messages[key];
    if (!existing) continue;
    // An update to a line older than everything loaded (an old card expiring)
    // belongs on a page not read yet; it arrives with that page, not at the top.
    if (
      state.older[key] &&
      existing.length &&
      message.ts < existing[0].ts &&
      !existing.some((m) => m.id === message.id)
    )
      continue;
    const next = placeLine(existing, message);
    if (next !== existing) messages = { ...messages, [key]: next };
  }
  if (messages === state.messages && drafts === state.drafts) return;
  emit({ ...state, drafts, messages });
}

/**
 * Lines that exist as finished messages: a draft event for one that arrives
 * after it (events on two channels, or a duplicate) must not bring back a
 * second, streaming copy of a reply that is already there. Bounded; only the
 * last few matter.
 */
const finished = new Set<string>();
const FINISHED_KEPT = 500;
function noteFinished(id: string) {
  finished.delete(id);
  finished.add(id);
  if (finished.size > FINISHED_KEPT) finished.delete(finished.values().next().value as string);
}

/** A reply grew. Keeps the time it started, so it doesn't jump past a divider. */
export function updateDraft(agentId: string, id: string, text: string) {
  const previous = state.drafts[agentId];
  if (finished.has(id) || state.messages[agentId]?.some((m) => m.id === id)) return;
  // Empty text withdraws the draft: it was progress narration, which the Mac
  // keeps in the turn's timeline (a `note` step) instead of the chat.
  if (text === '') {
    if (previous?.id !== id) return;
    const drafts = { ...state.drafts };
    delete drafts[agentId];
    emit({ ...state, drafts });
    return;
  }
  // A repeated event changes nothing; don't re-render the chat for it.
  if (previous?.id === id && previous.text === text) return;
  const ts = previous?.id === id ? previous.ts : Date.now();
  emit({
    ...state,
    drafts: { ...state.drafts, [agentId]: { id, agentId, ts, kind: 'agent', text } },
  });
}

/**
 * You just sent `text`: the row shows it and moves up at once, as the
 * backend's own update will (its first line: `preview_for` in runner.rs).
 */
export function markSent(agentId: string, text: string) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  emit({
    ...state,
    agents: state.agents.map((a) =>
      a.id === agentId
        ? { ...a, preview: line?.slice(0, 140) ?? a.preview, lastActivityAt: Date.now() }
        : a
    ),
  });
}

function patchStatus(agentId: string, status: AgentStatus) {
  emit({
    ...state,
    agents: state.agents.map((a) => (a.id === agentId ? { ...a, status } : a)),
    // A turn that ended without completing its draft took it with it.
    drafts: status.state === 'idle' ? withoutDraft(agentId) : state.drafts,
  });
}

/**
 * Status and draft events, held until the next frame. A reply streams as the
 * whole text so far every 40 ms and six working agents send a status several
 * times a second each; applied one by one, each was its own render of the
 * chat and the sidebar, several between two frames the screen could show.
 * Only the newest of each per agent matters, so a frame applies at most one
 * of each, in the order they last arrived (a turn that ended and then began
 * again ends, then begins). A message, a registry change or a room change
 * applies what is held first, so nothing lands out of order. A hidden window
 * gets no frames: the timer is the backstop.
 */
type Held =
  | { kind: 'status'; agentId: string; status: AgentStatus }
  | { kind: 'draft'; agentId: string; id: string; text: string };
const held = new Map<string, Held>();
let heldFrame: number | null = null;
let heldTimer: ReturnType<typeof setTimeout> | null = null;
const HELD_BACKSTOP_MS = 50;

function hold(event: Held) {
  const key = `${event.kind}:${event.agentId}`;
  held.delete(key);
  held.set(key, event);
  if (heldTimer !== null) return;
  heldTimer = setTimeout(applyHeld, HELD_BACKSTOP_MS);
  if (typeof requestAnimationFrame === 'function') heldFrame = requestAnimationFrame(applyHeld);
}

function applyHeld() {
  if (heldFrame !== null) cancelAnimationFrame(heldFrame);
  if (heldTimer !== null) clearTimeout(heldTimer);
  heldFrame = null;
  heldTimer = null;
  const events = [...held.values()];
  held.clear();
  for (const e of events) {
    if (e.kind === 'status') patchStatus(e.agentId, e.status);
    else updateDraft(e.agentId, e.id, e.text);
  }
}

function start() {
  const mine = ++generation;
  void refreshAgents();
  void refreshRooms();
  void Promise.all([
    listen<AgentMessage>(AGENT_EVENTS.message, (e) => {
      applyHeld();
      upsertMessage(e.payload);
    }),
    listen<{ agentId: string; status: AgentStatus }>(AGENT_EVENTS.status, (e) =>
      hold({ kind: 'status', agentId: e.payload.agentId, status: e.payload.status })
    ),
    listen(AGENT_EVENTS.registry, () => {
      applyHeld();
      scheduleRefresh();
      // A deleted agent leaves its rooms; a room's row follows its members.
      scheduleRoomsRefresh();
    }),
    listen<{ agentId: string; id: string; text: string }>(AGENT_EVENTS.draft, (e) =>
      hold({ kind: 'draft', ...e.payload })
    ),
    listen(ROOMS_EVENT, () => scheduleRoomsRefresh()),
  ]).then((handles) => {
    if (mine !== generation) {
      handles.forEach((h) => h());
      return;
    }
    unlistens = handles;
  });
}

function stop() {
  applyHeld();
  generation++;
  unlistens.forEach((h) => h());
  unlistens = [];
}

export function subscribeAgents(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * A slice of the store; the component re-renders only when the slice changes
 * (by `isEqual`, identity by default). `select` may be an inline function.
 */
export function useAgentsSelector<T>(
  select: (state: AgentsState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const last = useRef<{ state: AgentsState; select: typeof select; value: T } | null>(null);
  const getSlice = () => {
    const prev = last.current;
    if (prev && prev.state === state && prev.select === select) return prev.value;
    const value = select(state);
    last.current = {
      state,
      select,
      value: prev && isEqual(prev.value, value) ? prev.value : value,
    };
    return last.current.value;
  };
  return useSyncExternalStore(subscribeAgents, getSlice);
}

const selectAgents = (s: AgentsState) => s.agents;

const indexes = new WeakMap<Agent[], Map<string, Agent>>();
/** One agent by id, from a list indexed once per list (the store's list changes per event). */
export function agentIn(agents: Agent[], id: string): Agent | undefined {
  let index = indexes.get(agents);
  if (!index) {
    index = new Map(agents.map((a) => [a.id, a]));
    indexes.set(agents, index);
  }
  return index.get(id);
}
export const useAgentsList = () => useAgentsSelector(selectAgents);
const selectRooms = (s: AgentsState) => s.rooms;
export const useRoomsList = () => useAgentsSelector(selectRooms);

/** What the Agents side wants from you: who is waiting on your OK, and how many have news. */
export interface AgentsAttention {
  /** Names of the visible agents waiting on an approval or an answer. */
  waiting: string[];
  /** Visible agents with unread replies, not counting the ones above. */
  unread: number;
}

/** Agents attention for the mode toggle's dot and tooltip. Hidden agents never ask. */
export function useAgentsAttention(): AgentsAttention {
  return useAgentsSelector(attentionOf, sameAttention);
}

function attentionOf({ agents }: AgentsState): AgentsAttention {
  const visible = agents.filter((a) => !a.hidden);
  const waiting = visible.filter(needsYou);
  return {
    waiting: waiting.map((a) => a.name),
    unread: visible.filter((a) => !needsYou(a) && a.unread > 0).length,
  };
}

const sameAttention = (a: AgentsAttention, b: AgentsAttention) =>
  a.unread === b.unread && a.waiting.join('\n') === b.waiting.join('\n');

/** Test hook. */
export function __resetAgentsStore() {
  stop();
  state = {
    agents: [],
    engineReady: true,
    engines: [],
    defaults: null,
    independence: null,
    importChoice: null,
    loaded: false,
    error: null,
    messages: {},
    older: {},
    drafts: {},
    rooms: [],
    roomsLoaded: false,
  };
  loadingOlder.clear();
  loadingNewest.clear();
  arriving.clear();
  finished.clear();
}
