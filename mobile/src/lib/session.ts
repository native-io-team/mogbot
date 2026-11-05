/**
 * The live session with the paired Mac: owns the transport, feeds its events
 * into the store, and exposes the actions screens call. One Mac, one session.
 */

import type {
  Alert,
  AgentMessage,
  MemoryChange,
  MethodName,
  Params,
  Result,
  ResultRef,
  TeamSetupStepId,
  TeamSetupStepState,
} from '@shipstudio/companion-protocol';
import NetInfo from '@react-native-community/netinfo';
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { announce } from './a11y';
import { needsYou } from './agents';
import {
  badgeCount,
  clearAll,
  dismissApproval,
  dismissRead,
  post,
  setBadge,
  setupChannels,
} from './notify';
import {
  appInfo,
  forgetCredentials,
  loadCredentials,
  saveCredentials,
  usableRoutes,
  type Credentials,
} from './pairing';
import { flushCache, forgetCache, saveOutbox, loadCache, watchCache } from './cache';
import { flushDrafts, forgetDrafts, loadDrafts, refusedToDraft, setComposer } from './drafts';
import { outboxPlan, unreached } from './outbox';
import { loadPrefs } from './prefs';
import { getApp, setApp, update, useApp } from './store';
import {
  addPending,
  applyEvent,
  type PendingAttachment,
  type PendingSend,
  confirmSend,
  emptySync,
  mergePage,
  setPendingFailed,
} from './sync';
import { clearCache, http, type PickedFile } from './files';
import { roomIdOf, roomKey, roomsOffered } from './rooms';
import { registerPush } from './push';
import { sendSecret } from './secrets';
export { secretRouteProblem } from './secrets';
import { DirectTransport, WireFailure } from './transport';
import { newChallenge, PAIR_AGAIN } from './identity';
import { forgetSettledBy, withForget, withoutForget } from './forgets';

const PAGE = 50;
let transport: DirectTransport | null = null;

export const currentTransport = () => transport;

/** Try the Mac again now, instead of waiting out the backoff. */
export const retryNow = () => transport?.retryNow();

/**
 * Read the keychain and, if a Mac is paired, its offline copy and drafts,
 * then connect: the cached chats show at once, and the Mac replays from the
 * copy's cursor. Called once at launch.
 */
export async function boot() {
  const [credentials] = await Promise.all([
    loadCredentials().catch(() => null),
    loadPrefs().catch(() => {}),
  ]);
  if (credentials) {
    await Promise.all([
      loadCache(credentials.serverId).catch(() => false),
      loadDrafts(credentials.serverId).catch(() => {}),
    ]);
  }
  setApp({ credentials });
  watchCache();
  watchAttention();
  void setupChannels();
  void finishForgets();
  if (credentials) connect(credentials);
}

/**
 * A pairing from before identity keys pins nothing, so there's nothing to
 * hold a server to: it isn't used at all. The phone says so and asks for a
 * new pairing rather than sending its token to whoever answers.
 */
function refuseUnpinned() {
  setApp({
    link: { kind: 'refused', reason: 'pair_again' },
    refusal: { t: 'refused', reason: 'pair_again', message: PAIR_AGAIN },
  });
}

export async function adopt(credentials: Credentials) {
  await saveCredentials(credentials);
  setApp({
    ...emptySync(),
    credentials,
    refusal: null,
    welcome: null,
    served: null,
    composer: {},
    push: null,
  });
  await loadDrafts(credentials.serverId).catch(() => {});
  connect(credentials);
}

/** Only for a pairing with a pinned key (`Credentials.fingerprint`). */
const transportFor = (
  c: Credentials & { fingerprint: string },
  getResume?: () => ReturnType<typeof getApp>['cursor']
) =>
  new DirectTransport({
    routes: usableRoutes(c.routes),
    token: c.token,
    app: {
      version: appInfo().version,
      ...(Updates.updateId ? { updateId: Updates.updateId } : {}),
      runtimeVersion: Updates.runtimeVersion ?? 'development',
    },
    getResume: () => getResume?.() ?? undefined,
    foreground: AppState.currentState === 'active',
    http,
    challenge: () => newChallenge((n) => Crypto.getRandomBytes(n)),
    pinned: { fingerprint: c.fingerprint, serverId: c.serverId },
  });

/** Replayed events are history, not news: nothing is announced until caught up. */
let caughtUp = false;

function connect(c: Credentials) {
  transport?.close();
  transport = null;
  if (!c.fingerprint) return refuseUnpinned();
  // The store is in memory, so a cold start has no cursor and gets a
  // snapshot; within a run, every reconnect resumes where it left off.
  const t = transportFor({ ...c, fingerprint: c.fingerprint }, () => getApp().cursor);
  t.onState((link) => {
    // "As of" for everything shown while it's away: the moment it stopped being live.
    const was = getApp().link.kind;
    setApp(
      was === 'connected' && link.kind !== 'connected' ? { link, syncedAt: Date.now() } : { link }
    );
  });
  t.onRefused((refusal) => setApp({ refusal }));
  t.onWelcome((welcome) => {
    caughtUp = false;
    setApp({
      welcome,
      served: { methods: [...welcome.methods], features: [...(welcome.features ?? [])] },
      refusal: null,
    });
    // Focus is per connection: the Mac forgot it when the last one dropped.
    const open = getApp().openChat;
    if (open) void focusChat(open).catch(() => {});
    // An older Mac (or one without rooms) shows none: forget any kept from before.
    if (!roomsOffered(welcome)) setApp({ rooms: null });
    if (!canCall('agents.teamSetup', welcome)) setApp({ teamSetup: null });
    if (canCall('devices.setPush', welcome)) void syncPush();
  });
  t.onEvent((event, cursor) => {
    if (event.type === 'agents.message') noticeMessage(event.message);
    update((s) => applyEvent(s, event, cursor));
    if (event.type === 'alert') void notify(event.alert);
    if (event.type === 'system.status') learnRoutes(event.status.routes);
    // The Mac fires a registry event whenever setting up the team may read differently.
    if (event.type === 'agents.registry') refreshTeamSetupSoon();
    if (event.type === 'sync.snapshot') learnRoutes(event.status.routes);
    // After a snapshot every chat is stale; re-fetch the one on screen now,
    // the others when they're opened. Then send what waited for the Mac.
    if (event.type === 'sync.caughtUp') {
      caughtUp = true;
      const open = getApp().openChat;
      if (open && !getApp().chats[open]?.loaded) void loadLatest(open);
      if (roomsOffered(getApp().welcome)) void refreshRooms().catch(() => {});
      void refreshTeamSetup().catch(() => {});
      void flushOutbox();
    }
  });
  transport = t;
}

/** The Mac's routes change (a new DHCP address, Tailscale turned on); keep the latest. */
function learnRoutes(routes: Credentials['routes']) {
  const c = getApp().credentials;
  if (!c || !routes.length || JSON.stringify(routes) === JSON.stringify(c.routes)) return;
  const next = { ...c, routes };
  setApp({ credentials: next });
  void saveCredentials(next);
}

/** Whether this Mac serves `method` (older Macs list fewer; the phone hides the rest). */
export const canCall = (method: MethodName, welcome = getApp().welcome) =>
  !!welcome?.methods.includes(method);

export function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.request(method, params);
}

/** Hand the Mac this phone's push token, when it may have one. Never asks. */
const syncPush = () =>
  registerPush((token, environment) => call('devices.setPush', { token, environment })).catch(
    () => {}
  );

/**
 * The user chose alerts (after pairing, or in Settings): ask the OS once,
 * then register for push if this build can.
 */
export async function enableAlerts(): Promise<void> {
  await Notifications.requestPermissionsAsync().catch(() => null);
  if (canCall('devices.setPush')) await syncPush();
}

// ---- Lifecycle ----------------------------------------------------------------

/** Foreground/background and network changes. Returns a cleanup. */
export function watchLifecycle(): () => void {
  const app = AppState.addEventListener('change', (state) => {
    const fg = state === 'active';
    transport?.setForeground(fg);
    // The app may be killed from the background: put the copy on disk now.
    if (!fg) {
      void flushCache();
      void flushDrafts();
    }
    // Focus is per socket and only counts in the foreground: say so both ways.
    const open = getApp().openChat;
    if (open && transport?.state.kind === 'connected') {
      void call('agents.focus', { agentId: fg ? open : null }).catch(() => {});
    }
  });
  const net = NetInfo.addEventListener((s) => {
    const online = s.isConnected === null ? null : Boolean(s.isConnected);
    const was = getApp().phoneOnline;
    setApp({ phoneOnline: online });
    // A new network is the best moment to try again, not the end of a backoff.
    if (online && was !== true) {
      transport?.retryNow();
      void finishForgets();
    }
  });
  // Increase Contrast (iOS) / high-contrast text (Android): words get one step brighter.
  if (Platform.OS === 'ios') {
    void AccessibilityInfo.isDarkerSystemColorsEnabled().then((on) => setApp({ highContrast: on }));
  }
  const contrast =
    Platform.OS === 'ios'
      ? AccessibilityInfo.addEventListener('darkerSystemColorsChanged', (on) =>
          setApp({ highContrast: on })
        )
      : null;
  return () => {
    app.remove();
    net();
    contrast?.remove();
  };
}

// ---- Chats --------------------------------------------------------------------

const loading = new Map<string, Promise<void>>();

/** A page of an agent's chat, or (for a `room:<id>` key) a room's thread. */
function readPage(key: string, before?: string) {
  const roomId = roomIdOf(key);
  const at = before ? { before } : {};
  return roomId
    ? call('rooms.messages', { roomId, limit: PAGE, ...at })
    : call('agents.messages', { agentId: key, limit: PAGE, ...at });
}

/** `agents.focus`, or `rooms.focus` for a room's key. */
function focusChat(key: string | null) {
  const roomId = key ? roomIdOf(key) : null;
  if (roomId) return call('rooms.focus', { roomId });
  // Leaving a room also clears it on the Mac (one focus per socket).
  return call('agents.focus', { agentId: key });
}

/** Every room, read again (after catching up, and on pull to refresh). */
export async function refreshRooms() {
  setApp({ rooms: await call('rooms.list', {}) });
}

/** "Setting up your team", read again (null on a Mac without it). */
export async function refreshTeamSetup() {
  if (!canCall('agents.teamSetup')) return;
  setApp({ teamSetup: await call('agents.teamSetup', {}) });
}

let teamSetupTimer: ReturnType<typeof setTimeout> | null = null;
/** A burst of registry events reads the checklist once. */
function refreshTeamSetupSoon() {
  if (!canCall('agents.teamSetup') || teamSetupTimer) return;
  teamSetupTimer = setTimeout(() => {
    teamSetupTimer = null;
    void refreshTeamSetup().catch(() => {});
  }, 300);
}

/** One of the card's answers, then the checklist as it now reads. */
async function teamSetupThen<T>(work: Promise<T>): Promise<T> {
  const out = await work;
  await refreshTeamSetup().catch(() => {});
  return out;
}

export const teamSetup = {
  step: (step: TeamSetupStepId, state: TeamSetupStepState) =>
    teamSetupThen(call('agents.teamSetup.step', { step, state })),
  routine: (agentId: string, checkInId: string, on: boolean) =>
    teamSetupThen(call('agents.teamSetup.routine', { agentId, checkInId, on })),
  hello: (agentId: string) => teamSetupThen(call('agents.teamSetup.hello', { agentId })),
  missing: () => teamSetupThen(call('agents.teamSetup.missing', {})),
  dismiss: () => teamSetupThen(call('agents.teamSetup.dismiss', {})),
  /** A row nothing reached: one sign-in card started on the Mac, or put away. */
  later: (key: string, action: 'connect' | 'not_needed', onPhone = true) =>
    teamSetupThen(call('agents.teamSetup.later', { key, action, onPhone })),
  /** Check again what the team can already reach. */
  check: () => teamSetupThen(call('agents.teamSetup.check', {})),
};

/** The newest page. Concurrent calls for one chat share the request. */
export function loadLatest(agentId: string): Promise<void> {
  const running = loading.get(agentId);
  if (running) return running;
  const run = readPage(agentId)
    .then((page) => update((s) => mergePage(s, agentId, page, false)))
    .finally(() => loading.delete(agentId));
  loading.set(agentId, run);
  return run;
}

export async function loadOlder(agentId: string) {
  const oldest = getApp().chats[agentId]?.messages[0];
  if (!oldest) return loadLatest(agentId);
  const page = await readPage(agentId, oldest.id);
  update((s) => mergePage(s, agentId, page, true));
}

/** On screen (or `null` on leaving): the Mac clears its unread and holds alerts for it. */
export function setOpenChat(agentId: string | null) {
  const roomId = agentId ? roomIdOf(agentId) : null;
  setApp((s) => ({
    openChat: agentId,
    overview:
      agentId && s.overview && !roomId
        ? {
            ...s.overview,
            agents: s.overview.agents.map((a) => (a.id === agentId ? { ...a, unread: 0 } : a)),
          }
        : s.overview,
    rooms:
      roomId && s.rooms ? s.rooms.map((r) => (r.id === roomId ? { ...r, unread: 0 } : r)) : s.rooms,
  }));
  if (transport?.state.kind === 'connected') void focusChat(agentId).catch(() => {});
  if (roomId) return;
  if (agentId) {
    const agent = getApp().overview?.agents.find((a) => a.id === agentId);
    void dismissRead(agentId, agent ? needsYou(agent) : true);
  }
}

/**
 * Send with an optimistic bubble. The `clientId` makes a retry after a lost
 * connection safe: the Mac returns the original message instead of sending
 * it twice. `now`: interrupt the turn in progress once the Mac has it.
 *
 * With no link the send waits in the outbox (outbox.ts) and goes when the
 * Mac answers; a send the Mac may not have heard waits the same way.
 */
export async function send(
  agentId: string,
  text: string,
  now = false,
  clientId?: string,
  attachments: PendingAttachment[] = [],
  mentions: string[] = [],
  revises?: ResultRef
) {
  const id = clientId ?? Crypto.randomUUID();
  const offline = getApp().link.kind !== 'connected';
  if (clientId) update((s) => setPendingFailed(s, agentId, id, false, offline));
  else
    update((s) =>
      addPending(s, {
        clientId: id,
        agentId,
        text,
        ts: Date.now(),
        failed: false,
        ...(offline ? { waiting: true } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(revises ? { revises } : {}),
      })
    );
  // The outbox on disk first, then the composer's emptied draft: a crash in
  // between finds the words in one file or the other, never in neither.
  void saveOutbox().then(() => flushDrafts());
  if (offline) return;
  let message: AgentMessage;
  try {
    message = await call('agents.send', {
      agentId,
      text,
      clientId: id,
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ blobId: a.blobId })) }
        : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(revises ? { revises: revises.id } : {}),
    });
  } catch (error) {
    const retry = unreached(error);
    update((s) =>
      setPendingFailed(s, agentId, id, !retry, retry, retry ? undefined : describeError(error))
    );
    if (retry) return;
    throw error;
  }
  update((s) => confirmSend(s, id, message));
  if (now) await call('agents.interrupt', { agentId });
}

/**
 * Say something in a room, with an optimistic bubble, like `send`: the
 * `clientId` makes a retry safe, and offline it waits in the outbox. The
 * caller has already settled who answers (`answerers`): the Mac refuses a
 * message that names nobody in a room without a lead.
 */
export async function sendToRoom(
  roomId: string,
  text: string,
  mentions: string[],
  everyone: boolean,
  clientId?: string
) {
  const key = roomKey(roomId);
  const id = clientId ?? Crypto.randomUUID();
  const offline = getApp().link.kind !== 'connected';
  if (clientId) update((s) => setPendingFailed(s, key, id, false, offline));
  else
    update((s) =>
      addPending(s, {
        clientId: id,
        agentId: key,
        roomId,
        text,
        ts: Date.now(),
        failed: false,
        ...(offline ? { waiting: true } : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(everyone ? { everyone } : {}),
      })
    );
  if (offline) return;
  let sent: Result<'rooms.send'>;
  try {
    sent = await call('rooms.send', {
      roomId,
      text,
      clientId: id,
      ...(mentions.length ? { mentions } : {}),
      ...(everyone ? { everyone } : {}),
    });
  } catch (error) {
    const retry = unreached(error);
    update((s) =>
      setPendingFailed(s, key, id, !retry, retry, retry ? undefined : describeError(error))
    );
    if (retry) return;
    throw error;
  }
  update((s) => confirmSend(s, id, sent.message));
}

/** A pending send, tried again by its `clientId`: to its room, or its agent. */
export const resend = (p: PendingSend) =>
  p.roomId
    ? sendToRoom(p.roomId, p.text, p.mentions ?? [], !!p.everyone, p.clientId)
    : send(p.agentId, p.text, false, p.clientId, p.attachments, p.mentions, p.revises);

let flushing = false;

/** Send what waited for the Mac, oldest first; give up on what waited too long. */
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const { flush, expire } = outboxPlan(getApp().pending, Date.now());
    for (const p of expire) update((s) => setPendingFailed(s, p.agentId, p.clientId, true));
    for (const p of flush) {
      if (getApp().link.kind !== 'connected') break;
      await resend(p).catch(() => {});
    }
  } finally {
    flushing = false;
  }
}

export function discardPending(agentId: string, clientId: string) {
  setApp((s) => ({
    pending: {
      ...s.pending,
      [agentId]: (s.pending[agentId] ?? []).filter((p) => p.clientId !== clientId),
    },
  }));
}

/** A refused send, back in its chat's composer to change (`refusedToDraft`), and out of the chat. */
export function editPending(p: PendingSend) {
  const s = getApp();
  setComposer(p.agentId, refusedToDraft(p, s.composer[p.agentId], s.overview?.agents ?? []));
  discardPending(p.agentId, p.clientId);
}

export const stop = (agentId: string) => call('agents.stop', { agentId });

export const answerApproval = (
  agentId: string,
  requestId: string,
  allow: boolean,
  always?: boolean,
  note?: string,
  /** On a session's question: the option picked, by index. */
  choice?: number
) =>
  call('agents.answerApproval', {
    agentId,
    requestId,
    allow,
    ...(always ? { always } : {}),
    ...(note ? { note } : {}),
    ...(choice !== undefined ? { choice } : {}),
  });

/** A secure input card's values, straight to the Mac's Keychain (see `secrets.ts`). */
export function saveSecret(agentId: string, requestId: string, values: string[]) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return sendSecret(transport, agentId, requestId, values);
}

export const deviceSelf = () => call('devices.self', {});

/** Pin, mute or hide: shown at once, put back if the Mac says no. */
export async function setAgentToggles(
  agentId: string,
  input: Partial<Record<'pinned' | 'muted' | 'hidden', boolean>>
) {
  const before = getApp().overview;
  const patch = (on: typeof before) =>
    on && {
      ...on,
      agents: on.agents.map((a) => (a.id === agentId ? { ...a, ...input } : a)),
    };
  setApp({ overview: patch(before) });
  try {
    await call('agents.update', { agentId, input });
  } catch (error) {
    setApp((s) => ({
      overview:
        s.overview && before
          ? {
              ...s.overview,
              agents: s.overview.agents.map((a) => {
                const was = before.agents.find((b) => b.id === a.id);
                return a.id === agentId && was
                  ? { ...a, pinned: was.pinned, muted: was.muted, hidden: was.hidden }
                  : a;
              }),
            }
          : s.overview,
    }));
    throw error;
  }
}

/**
 * A new agent, made on the Mac by the desk's own create path. Resolves once
 * the overview has it, read back from the Mac rather than assumed, so its
 * chat opens on the agent as the Mac stores it. `clientId` is the screen's
 * own: tapping Create again after a dropped connection returns the agent
 * the first tap made instead of a second one.
 */
export async function createAgent(
  input: { name: string; role: string; color?: string; template?: string },
  clientId: string = Crypto.randomUUID()
) {
  const stored = await call('agents.create', { input, clientId });
  if (!getApp().overview?.agents.some((a) => a.id === stored.id)) {
    setApp({ overview: await call('agents.overview', {}) });
  }
  return stored;
}

/** A new conversation from its next message; memory kept. The registry event redraws the sheet. */
export async function startFresh(agentId: string) {
  await call('agents.startFresh', { agentId });
}

export async function markUnread(agentId: string) {
  setApp((s) => ({
    overview: s.overview && {
      ...s.overview,
      agents: s.overview.agents.map((a) =>
        a.id === agentId ? { ...a, unread: Math.max(1, a.unread) } : a
      ),
    },
  }));
  await call('agents.markUnread', { agentId });
}

// ---- Files ------------------------------------------------------------------------

/** Upload a picked file to the Mac's staging area (kept there an hour). */
export function upload(file: PickedFile, onProgress?: (fraction: number) => void) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.upload(file, onProgress);
}

/** A local copy of an attachment (cached) or of a blob the Mac produced. */
export function download(source: { blobId: string } | { agentId: string; path: string }) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return transport.download(source);
}

/** An image source for an attachment: the Mac's thumbnail at `width` points (2x for the screen). */
export function attachmentSource(agentId: string, path: string, width?: number) {
  if (!transport) return null;
  return {
    uri: transport.attachmentUrl(agentId, path, width ? width * 2 : undefined),
    headers: transport.authHeaders,
    cacheKey: `${agentId}/${path}@${width ?? 'full'}`,
  };
}

export const listFiles = (agentId: string) => call('agents.files', { agentId });

// ---- The agent sheet ----------------------------------------------------------------

export const readInstructions = (agentId: string) => call('agents.instructions', { agentId });
export const setInstructions = (agentId: string, instructions: string) =>
  call('agents.update', { agentId, input: { instructions } });
export const readUsage = (agentId: string) => call('agents.usage', { agentId });
export const readMemory = (agentId: string) => call('agents.memory', { agentId });
export const changeMemory = (agentId: string, change: MemoryChange) =>
  call('agents.memoryChange', { agentId, change });
export const suggestMemory = (text: string) => call('agents.memorySuggest', { text });
export const revokePermission = (agentId: string, ruleId: string) =>
  call('agents.revokePermission', { agentId, ruleId });
export const changeDiff = (agentId: string, messageId: string, path: string) =>
  call('agents.changeDiff', { agentId, messageId, path });
/** "Keep changes" on the newest card of an agent's copy of its project. */
/** `into` confirms the project's current branch, after an `otherBranch` answer. */
export const keepCopy = (agentId: string, copyId: string, into?: string) =>
  call('agents.keepCopy', into ? { agentId, copyId, into } : { agentId, copyId });
export const discardCopy = (agentId: string, copyId: string) =>
  call('agents.discardCopy', { agentId, copyId });

/** A path written in an agent's reply, fetched from the Mac and saved here. */
export async function fetchPath(agentId: string, path: string) {
  const blob = await call('agents.fetchPath', { agentId, path });
  const local = await download({ blobId: blob.blobId });
  return { ...blob, uri: local };
}

// ---- Search -------------------------------------------------------------------------

export const search = (query: string) => call('agents.search', { query });

/**
 * Page a chat back until `messageId` is loaded, for a search hit. Gives up
 * after `maxPages` pages; resolves whether it was found.
 */
export async function loadUntil(agentId: string, messageId: string, maxPages = 40) {
  const has = () => getApp().chats[agentId]?.messages.some((m) => m.id === messageId) ?? false;
  if (!getApp().chats[agentId]?.loaded) await loadLatest(agentId);
  for (let i = 0; i < maxPages && !has(); i++) {
    if (!getApp().chats[agentId]?.more) break;
    await loadOlder(agentId);
  }
  return has();
}

// ---- Check-ins and routines ---------------------------------------------------------

export const schedule = {
  preview: (when: string) => call('agents.schedule.preview', { when }),
  create: (agentId: string, when: string, note: string) =>
    call('agents.schedule.create', { agentId, when, note }),
  update: (agentId: string, id: string, when: string, note: string) =>
    call('agents.schedule.update', { agentId, id, when, note }),
  pause: (agentId: string, id: string, paused: boolean) =>
    call('agents.schedule.pause', { agentId, id, paused }),
  cancel: (agentId: string, id: string) => call('agents.schedule.cancel', { agentId, id }),
  runNow: (agentId: string, id: string) => call('agents.schedule.runNow', { agentId, id }),
};

// ---- Projects and sessions -----------------------------------------------------------

export async function refreshProjects() {
  const projects = await call('projects.list', {});
  setApp({ projects });
}

export const readSession = (sessionId: string) => call('sessions.read', { sessionId });

/** Type into a project's agent tab. Remote Access's refusals apply on the Mac. */
export const sendToSession = (project: string, sessionId: string, text: string) =>
  call('sessions.send', { project, sessionId, text, clientId: Crypto.randomUUID() });

/** A new agent tab in `project` that opens on `prompt`; resolves once the tab exists. */
export const startSession = (project: string, prompt: string) =>
  call('sessions.start', { project, prompt, clientId: Crypto.randomUUID() });

/** The project's live preview as `device`, saved here to open. */
export async function previewScreenshot(project: string, device: 'desktop' | 'phone') {
  const blob = await call('preview.screenshot', { project, device });
  return { ...blob, uri: await download({ blobId: blob.blobId }) };
}

/** Answer a question a tab is showing: an option's key, or Escape. */
export const pressSessionKey = (sessionId: string, key: string) =>
  call('sessions.key', { sessionId, key });

/**
 * Forget this Mac: revoke our token on it, then wipe everything here.
 * Offline (or if the Mac doesn't answer), the revoke is queued with the
 * token, in the keychain, and finished the next time the Mac can be
 * reached (`finishForgets`). Says which happened, so Settings can tell the
 * user honestly.
 */
export async function unpair(): Promise<'removed' | 'queued'> {
  const credentials = getApp().credentials;
  let removed = false;
  if (transport?.state.kind === 'connected') {
    removed = await call('devices.unpairSelf', {}).then(
      () => true,
      () => false
    );
  }
  transport?.close();
  transport = null;
  // A pairing that pinned nothing is never offered to a server to revoke.
  if (credentials?.fingerprint && !removed) await queueForget(credentials);
  const serverId = credentials?.serverId;
  await forgetCredentials();
  await clearCache().catch(() => {});
  await clearAll();
  if (serverId) {
    await forgetCache(serverId).catch(() => {});
    await forgetDrafts(serverId).catch(() => {});
  }
  setApp({
    ...emptySync(),
    credentials: null,
    welcome: null,
    served: null,
    refusal: null,
    openChat: null,
    push: null,
    link: { kind: 'connecting', attempt: 0 },
  });
  return removed || !credentials ? 'removed' : 'queued';
}

// ---- Forgets that couldn't reach the Mac -----------------------------------------

const FORGET_KEY = 'shipstudio.forget';
const FORGET_OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

async function queuedForgets(): Promise<Credentials[]> {
  const raw = await SecureStore.getItemAsync(FORGET_KEY, FORGET_OPTS).catch(() => null);
  return raw ? (JSON.parse(raw) as Credentials[]) : [];
}

const saveForgets = (list: Credentials[]) =>
  list.length
    ? SecureStore.setItemAsync(FORGET_KEY, JSON.stringify(list), FORGET_OPTS)
    : SecureStore.deleteItemAsync(FORGET_KEY, FORGET_OPTS);

async function queueForget(c: Credentials) {
  await saveForgets(withForget(await queuedForgets(), c)).catch(() => {});
}

let finishing = false;

/**
 * Tell each Mac forgotten offline to revoke this phone's token, over a
 * short-lived connection of its own. Done once the Mac confirms, says the
 * token is already gone, or turns out not to be the Mac that pairing was
 * with (`forgetSettledBy`). Each entry is one pairing (Mac and device), so
 * an old forget never touches a newer pairing with the same Mac.
 */
export async function finishForgets() {
  if (finishing) return;
  finishing = true;
  try {
    for (const c of await queuedForgets()) {
      const { fingerprint } = c;
      // A pairing that pinned nothing can't be held to anything: its token
      // isn't offered to whoever answers. Remove it on the Mac instead.
      const done = !fingerprint
        ? true
        : !usableRoutes(c.routes).length
          ? false
          : await finishOne({ ...c, fingerprint });
      if (done) await saveForgets(withoutForget(await queuedForgets(), c));
    }
  } finally {
    finishing = false;
  }
}

/**
 * One forget, over a short-lived connection of its own that never touches
 * the current pairing: nothing here saves credentials or changes the store.
 */
function finishOne(c: Credentials & { fingerprint: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = transportFor(c);
    const end = (ok: boolean) => {
      clearTimeout(timer);
      t.close();
      resolve(ok);
    };
    const timer = setTimeout(() => end(false), 20_000);
    t.onRefused((r) => end(forgetSettledBy(r.reason)));
    t.onWelcome(() => {
      t.request('devices.unpairSelf', {}).then(
        () => end(true),
        () => end(false)
      );
    });
  });
}

// ---- Notifications --------------------------------------------------------------

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/** The Mac only sends an alert when this phone isn't showing that agent. */
async function notify(alert: Alert) {
  if (getApp().openChat === alert.agentId && AppState.currentState === 'active') return;
  await post(alert);
}

/**
 * A message is about to be stored: take back the alert for an approval
 * that was just answered, and tell VoiceOver / TalkBack what's new.
 */
function noticeMessage(m: AgentMessage) {
  const known = getApp().chats[m.agentId]?.messages.find((x) => x.id === m.id);
  if (m.approval && m.approval.status !== 'pending' && known?.approval?.status === 'pending') {
    void dismissApproval(m.agentId, m.id);
  }
  if (!caughtUp || known) return;
  const name = getApp().overview?.agents.find((a) => a.id === m.agentId)?.name ?? 'An agent';
  if (m.kind === 'approval' && m.approval?.status === 'pending') {
    announce(`${name} needs your OK: ${m.approval.title}`, true);
  } else if (m.kind === 'agent') {
    announce(`${name} replied`);
  } else if (m.kind === 'error') {
    announce(`${name} didn’t finish`);
  }
}

let watchingAttention = false;

/**
 * The icon badge follows the overview, and a chat read anywhere (its unread
 * falling to 0, here or at the desk) takes back its reply alerts. A Mac
 * that removed this phone leaves nothing counted.
 */
function watchAttention() {
  if (watchingAttention) return;
  watchingAttention = true;
  useApp.subscribe((s, prev) => {
    if (s.overview === prev.overview && s.link === prev.link) return;
    const refused = s.link.kind === 'refused';
    void setBadge(refused || !s.overview ? 0 : badgeCount(s.overview.agents));
    if (!s.overview || !prev.overview) return;
    for (const a of s.overview.agents) {
      const was = prev.overview.agents.find((b) => b.id === a.id);
      if (was && was.unread > 0 && a.unread === 0) void dismissRead(a.id, needsYou(a));
    }
  });
}

// ---- Errors ---------------------------------------------------------------------

/** One sentence for a failed action, in the desktop's voice. */
export function describeError(error: unknown): string {
  if (!(error instanceof WireFailure)) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }
  const e = error.error;
  switch (e.type) {
    case 'Protocol':
      return e.message;
    case 'Timeout':
      return 'Your Mac didn’t answer in time.';
    case 'Validation':
      return e.reason;
    case 'NotAuthenticated':
      return `${e.service} is signed out on your Mac.`;
    case 'Process':
    case 'MergeConflict':
      return 'A command on your Mac failed.';
    case 'Io':
    case 'Other':
      return e.message;
  }
}
