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
export async function loadRoomMessages(roomId: string): Promise<void> {
  const key = roomKey(roomId);
  try {
    const messages = await getRoomMessages(roomId, MESSAGE_PAGE);
    setMessages(key, messages, messages.length >= MESSAGE_PAGE);
  } catch (error) {
    logger.error('[Agents] room messages failed', { roomId, error: String(error) });
    setMessages(key, state.messages[key] ?? [], false);
  }
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

/** (Re)load a chat's newest page. */
export async function loadMessages(agentId: string): Promise<void> {
  try {
    const messages = await getAgentMessages(agentId, MESSAGE_PAGE);
    setMessages(agentId, messages, messages.length >= MESSAGE_PAGE);
  } catch (error) {
    logger.error('[Agents] messages failed', { agentId, error: String(error) });
    setMessages(agentId, state.messages[agentId] ?? [], false);
  }
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
  const drafts = message.agentId ? withoutDraft(message.agentId, message.id) : state.drafts;
  // A member's line said in a room is in both its own chat and the room's thread.
  const keys = [message.agentId, message.room ? roomKey(message.room) : ''].filter(Boolean);
  let messages = state.messages;
  for (const key of keys) {
    const existing = messages[key];
    if (!existing) continue;
    const index = existing.findIndex((m) => m.id === message.id);
    const next =
      index === -1 ? [...existing, message] : existing.map((m, i) => (i === index ? message : m));
    messages = { ...messages, [key]: next };
  }
  if (messages === state.messages && drafts === state.drafts) return;
  emit({ ...state, drafts, messages });
}

/** A reply grew. Keeps the time it started, so it doesn't jump past a divider. */
export function updateDraft(agentId: string, id: string, text: string) {
  const previous = state.drafts[agentId];
  if (state.messages[agentId]?.some((m) => m.id === id)) return;
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

function start() {
  const mine = ++generation;
  void refreshAgents();
  void refreshRooms();
  void Promise.all([
    listen<AgentMessage>(AGENT_EVENTS.message, (e) => upsertMessage(e.payload)),
    listen<{ agentId: string; status: AgentStatus }>(AGENT_EVENTS.status, (e) =>
      patchStatus(e.payload.agentId, e.payload.status)
    ),
    listen(AGENT_EVENTS.registry, () => {
      scheduleRefresh();
      // A deleted agent leaves its rooms; a room's row follows its members.
      scheduleRoomsRefresh();
    }),
    listen<{ agentId: string; id: string; text: string }>(AGENT_EVENTS.draft, (e) =>
      updateDraft(e.payload.agentId, e.payload.id, e.payload.text)
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
    loaded: false,
    error: null,
    messages: {},
    older: {},
    drafts: {},
    rooms: [],
    roomsLoaded: false,
  };
  loadingOlder.clear();
}
