/**
 * The live session with the paired Mac: owns the transport, feeds its events
 * into the store, and exposes the actions screens call. One Mac, one session.
 */

import { shareStructure } from './structure';
import type {
  Conversations,
  Alert,
  AgentMessage,
  MemoryChange,
  MethodName,
  Params,
  Result,
  ResultRef,
  TeamSetupStepId,
  TeamSetupStepState,
  AgentEffort,
  AgentEngine,
  RoutineStep,
  WatchSource,
} from '@shipstudio/companion-protocol';
import {
  MAC_FEATURES,
  legacyColorFor,
  setClockHour24,
  type LearnSkills,
} from '@shipstudio/companion-protocol';
import NetInfo from '@react-native-community/netinfo';
import { AccessibilityInfo, AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { FIRST_CONVERSATION } from '@shipstudio/companion-protocol';
import { announce, replyAnnouncement } from './a11y';
import { speakable } from './readAloud';
import { conversationOfKey } from './conversations';
import { needsYou } from './agents';
import {
  badgeCount,
  clearAll,
  dismissApproval,
  dismissPushFor,
  dismissRead,
  postNote,
  postNotice,
  setBadge,
  setupChannels,
  type Target,
} from './notify';
import { answerFromAlert, approvalNotice, setupCategories, type AnswerOutcome } from './actionable';
import { defaultDeps, LiveAlerts } from './liveAlerts';
import {
  appInfo,
  asCredentials,
  forgetCredentials,
  loadPairing,
  saveCredentials,
  usableRoutes,
  type Credentials,
  type SavedPairing,
} from './pairing';
import { flushCache, forgetCache, saveOutbox, loadCache, watchCache } from './cache';
import { forgetRemembered } from './remembered';
import { flushDrafts, forgetDrafts, loadDrafts, refusedToDraft, setComposer } from './drafts';
import { outboxPlan, retryWaitMs, sendInOrder, unreached } from './outbox';
import { loadPrefs } from './prefs';
import { getApp, setApp, update, useApp } from './store';
import {
  addPending,
  closeCard,
  applyEvent,
  type PendingAttachment,
  type PendingSend,
  confirmSend,
  emptySync,
  mergePage,
  setPendingFailed,
} from './sync';
import { clearCache, http, localFiles, type PickedFile } from './files';
import { relayImage, retryRelayImage, retryRelayImages } from './relayImages';
import { createReads } from './reads';
import { roomIdOf, roomKey, roomsOffered } from './rooms';
import { registerPush } from './push';
import { sendSecret } from './secrets';
export { secretRouteProblem } from './secrets';
import { DirectTransport, setTransportFaultReporter, WireFailure } from './transport';
import { recordCrash, sendCrashes } from './crash';
import { asMessage, asOverview, asProjects, asRooms } from './wellFormed';

// A frame the phone couldn't handle is skipped (transport.ts) and logged here.
setTransportFaultReporter((e) => void recordCrash(e, 'js', false).catch(() => {}));
import { DemoTransport, demoCredentials, isDemo } from './demo';
import { newChallenge, pairAgain } from './identity';
import { forgetSettledBy, readForgets, withForget, withoutForget } from './forgets';
import { pairedComputer } from './computer';

const PAGE = 50;
let transport: DirectTransport | DemoTransport | null = null;

export const currentTransport = () => transport;

/** Try the Mac again now, instead of waiting out the backoff. */
export const retryNow = () => transport?.retryNow();

/**
 * Read the keychain and, if a Mac is paired, its offline copy and drafts,
 * then connect: the cached chats show at once, and the Mac replays from the
 * copy's cursor. Called once at launch.
 */
export async function boot() {
  const [saved] = await Promise.all([
    loadPairing().catch((): SavedPairing => ({ kind: 'none' })),
    loadPrefs().catch(() => {}),
  ]);
  const credentials = saved.kind === 'paired' ? saved.credentials : null;
  // Saved but unreadable: already removed; the pairing screen says why.
  if (saved.kind === 'damaged') setApp({ pairingLost: true });
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
  void setupCategories();
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
    refusal: { t: 'refused', reason: 'pair_again', message: pairAgain() },
  });
}

/**
 * "Try the demo" on the welcome screen: sample agents from `DemoTransport`,
 * in memory only (never the keychain, the offline copy or drafts), so a
 * relaunch is back on the welcome screen. Never over a real pairing.
 */
export function startDemo(): boolean {
  const current = getApp().credentials;
  if (current && !isDemo(current)) return false;
  const credentials = demoCredentials();
  setApp({
    ...emptySync(),
    credentials,
    refusal: null,
    welcome: null,
    served: null,
    composer: {},
    push: null,
    teamSetup: null,
  });
  connect(credentials);
  return true;
}

export async function adopt(credentials: Credentials) {
  // A real Mac replaces the demo: nothing of the demo's is on disk to clear.
  if (isDemo(getApp().credentials)) transport?.close();
  await saveCredentials(credentials);
  setApp({
    ...emptySync(),
    credentials,
    pairingLost: false,
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
    files: localFiles,
    random: (n) => Crypto.getRandomBytes(n),
    challenge: () => newChallenge((n) => Crypto.getRandomBytes(n)),
    pinned: { fingerprint: c.fingerprint, serverId: c.serverId },
  });

/** Replayed events are history, not news: nothing is announced until caught up. */
let caughtUp = false;

function connect(c: Credentials) {
  transport?.close();
  transport = null;
  if (readsFor !== c.serverId) reads.forget();
  readsFor = c.serverId;
  if (!c.fingerprint) return refuseUnpinned();
  // The store is in memory, so a cold start has no cursor and gets a
  // snapshot; within a run, every reconnect resumes where it left off.
  const t = isDemo(c)
    ? new DemoTransport()
    : transportFor({ ...c, fingerprint: c.fingerprint }, () => getApp().cursor);
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
    retryRelayImages();
    setApp({
      welcome,
      served: { methods: [...welcome.methods], features: [...(welcome.features ?? [])] },
      refusal: null,
    });
    // Focus is per connection: the Mac forgot it when the last one dropped.
    focusHeld = null;
    // A new link: what waits goes on caught-up, and any retry starts quick.
    waitingTries = 0;
    syncFocus(0);
    // An older Mac (or one without rooms) shows none: forget any kept from before.
    if (!roomsOffered(welcome)) setApp({ rooms: null });
    if (!canCall('agents.teamSetup', welcome)) setApp({ teamSetup: null });
    if (canCall('devices.setPush', welcome)) void syncPush();
    if (canCall('system.reportCrashes', welcome) && getApp().prefs.errorReports) {
      void sendCrashes((crashes) =>
        call('system.reportCrashes', {
          crashes,
          platform: Platform.OS === 'android' ? 'android' : 'ios',
          appVersion: appInfo().version,
        })
      ).catch(() => undefined);
    }
  });
  t.onEvent((event, cursor) => {
    if (event.type === 'agents.message') {
      const m = asMessage(event.message);
      if (m) {
        noticeMessage(m);
        // A Mac that sends alerts decides which cards to post; an older one
        // leaves it to this phone.
        if (macSendsAlerts()) liveAlerts.heard(m);
        else alertApproval(m);
      }
    }
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
  const usable = usableRoutes(routes);
  if (usable.length && transport instanceof DirectTransport) transport.setRoutes(usable);
}

/** Whether this Mac serves `method` (older Macs list fewer; the phone hides the rest). */
export const canCall = (method: MethodName, welcome = getApp().welcome) =>
  !!welcome?.methods.includes(method);

/** Every request to the Mac: reads shared, queued and remembered (`lib/reads`). */
const reads = createReads();
/** The Mac the kept reads are for. */
let readsFor: string | null = null;

export function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return reads.call(method, params, () => {
    if (!transport) return Promise.reject(new Error('Not paired'));
    return transport.request(method, params);
  });
}

/**
 * How long a reading a screen polls (usage, accounts) is good for when
 * another screen opens wanting it: under its once-a-minute poll, so the
 * poll still reads, but a tab switched back to doesn't.
 */
export const READ_FRESH_MS = 20_000;

/**
 * What a read last answered, from any screen: a screen opening shows it from
 * its first frame while it reads again. Undefined when it hasn't been read
 * for this Mac.
 */
export const lastRead = <M extends MethodName>(method: M, params: Params<M>) =>
  reads.last<Result<M>>(method, params);

/**
 * A read answered from the last one when that is under `maxAgeMs` old and
 * nothing has changed since: switching tabs, or opening chats one after
 * another, doesn't ask the Mac the same thing each time.
 */
export function callFresh<M extends MethodName>(
  method: M,
  params: Params<M>,
  maxAgeMs: number
): Promise<Result<M>> {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return reads.fresh(method, params, maxAgeMs, () => {
    if (!transport) return Promise.reject(new Error('Not paired'));
    return transport.request(method, params);
  });
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

/** Which network the phone is on, as far as NetInfo says: a change of it is worth a fresh try. */
export function networkKey(s: {
  type: string;
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
  details?: unknown;
}): string {
  const d = (s.details ?? {}) as { ipAddress?: unknown; ssid?: unknown; carrier?: unknown };
  return [s.type, s.isConnected, s.isInternetReachable, d.ipAddress, d.ssid, d.carrier]
    .map((v) =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
    )
    .join('|');
}

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
    syncFocus(0, fg);
  });
  let network = '';
  const net = NetInfo.addEventListener((s) => {
    const online = s.isConnected === null ? null : Boolean(s.isConnected);
    const was = getApp().phoneOnline;
    setApp({ phoneOnline: online });
    // A new network is the best moment to try again, not the end of a backoff:
    // coming online, and also a switch (Wi-Fi to cellular, a VPN like
    // Tailscale coming up or back), after which an open socket may be dead.
    const now = networkKey(s);
    const changed = network !== '' && now !== network;
    network = now;
    if (online && (was !== true || changed)) transport?.retryNow();
    if (online && was !== true) void finishForgets();
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
  // One conversation's chat: its own lines (`lib/conversations`).
  const conv = conversationOfKey(key);
  if (conv)
    return call('agents.messages', {
      agentId: conv.agentId,
      limit: PAGE,
      work: 'summary',
      conversation: conv.conversation,
      ...at,
    });
  return roomId
    ? call('rooms.messages', { roomId, limit: PAGE, ...at })
    : // Timelines as their folded lines: the steps were most of a page, and
      // are read as one opens (`lib/turnSteps`). An older Mac sends them anyway.
      call('agents.messages', { agentId: key, limit: PAGE, work: 'summary', ...at });
}

/** What the Mac holds as this socket's focus; undefined when unsure (a send failed). */
let focusHeld: string | null | undefined = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
/** Chats opened and left within this long say only where they ended up. */
const FOCUS_SETTLE_MS = 150;

/**
 * Tell the Mac which chat is on screen (none in the background), once it
 * has settled: tapping in and out of chats is one focus, not two a chat,
 * and one it already holds isn't sent again.
 */
function syncFocus(delay = FOCUS_SETTLE_MS, foreground = AppState.currentState === 'active') {
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    focusTimer = null;
    if (transport?.state.kind !== 'connected') return;
    const want = foreground ? getApp().openChat : null;
    if (want === focusHeld) return;
    focusHeld = want;
    void focusChat(want).catch(() => {
      if (focusHeld === want) focusHeld = undefined;
    });
  }, delay);
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
  // From a Mac of another shape: made safe to draw; not a list keeps what's shown.
  const rooms = asRooms(await call('rooms.list', {}));
  if (rooms) setApp({ rooms });
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
  // The overview (or rooms) changes only when there was something unread: a
  // new one re-renders everything that reads it, every row of the agents
  // list under the chat included, inside the task that opens the chat.
  setApp((s) => ({
    openChat: agentId,
    overview:
      agentId &&
      s.overview &&
      !roomId &&
      s.overview.agents.some((a) => a.id === agentId && a.unread)
        ? {
            ...s.overview,
            agents: s.overview.agents.map((a) => (a.id === agentId ? { ...a, unread: 0 } : a)),
          }
        : s.overview,
    rooms:
      roomId && s.rooms?.some((r) => r.id === roomId && r.unread)
        ? s.rooms.map((r) => (r.id === roomId ? { ...r, unread: 0 } : r))
        : s.rooms,
  }));
  syncFocus();
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
      // The conversation on screen; an older Mac has one and ignores it.
      ...(getApp().viewing[agentId] ? { conversation: getApp().viewing[agentId] } : {}),
    });
  } catch (error) {
    const retry = unreached(error);
    update((s) =>
      setPendingFailed(s, agentId, id, !retry, retry, retry ? undefined : describeError(error))
    );
    if (retry) return retryWaitingSoon();
    throw error;
  }
  waitingTries = 0;
  update((s) => confirmSend(s, id, message));
  if (now) await call('agents.interrupt', { agentId });
}

/**
 * A send that goes at most once for its `clientId` (a Siri request the
 * system hands over again after the app died mid-way): one already waiting
 * here is left alone, and the Mac returns the original for an id it has seen.
 */
export function sendOnce(agentId: string, text: string, clientId: string): Promise<void> {
  if ((getApp().pending[agentId] ?? []).some((p) => p.clientId === clientId)) {
    return Promise.resolve();
  }
  update((s) => addPending(s, { clientId, agentId, text, ts: Date.now(), failed: false }));
  return send(agentId, text, false, clientId);
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
    if (retry) return retryWaitingSoon();
    throw error;
  }
  waitingTries = 0;
  update((s) => confirmSend(s, id, sent.message));
}

/** A pending send, tried again by its `clientId`: to its room, or its agent. */
export const resend = (p: PendingSend) =>
  p.roomId
    ? sendToRoom(p.roomId, p.text, p.mentions ?? [], !!p.everyone, p.clientId)
    : send(p.agentId, p.text, false, p.clientId, p.attachments, p.mentions, p.revises);

let flushing = false;
let waitingTimer: ReturnType<typeof setTimeout> | null = null;
/** Tries in a row the Mac didn't answer while the link stayed up. */
let waitingTries = 0;

/**
 * A send that didn't reach the Mac, or that it didn't answer, with the link
 * still up: try what's waiting again in a few seconds (by its `clientId`,
 * so one that did land isn't doubled), backing off while it stays busy. A
 * dropped link needs none of this: the reconnect flushes the outbox.
 */
function retryWaitingSoon() {
  if (waitingTimer) return;
  waitingTimer = setTimeout(() => {
    waitingTimer = null;
    if (getApp().link.kind !== 'connected') return;
    // A flush still going would drop this one: look again after it.
    if (flushing) return retryWaitingSoon();
    void flushOutbox();
  }, retryWaitMs(waitingTries++));
}

/** Send what waited for the Mac, oldest first; give up on what waited too long. */
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const { flush, expire } = outboxPlan(getApp().pending, Date.now());
    for (const p of expire) update((s) => setPendingFailed(s, p.agentId, p.clientId, true));
    await sendInOrder(
      flush,
      resend,
      () => getApp().link.kind === 'connected',
      (p) => !!getApp().pending[p.agentId]?.some((x) => x.clientId === p.clientId && x.waiting)
    );
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
  }).catch((e: unknown) => {
    // Closed on the Mac while this copy sat in the cache: drop it here too.
    if (ALREADY_ANSWERED.test(describeError(e))) {
      update((s) => closeCard(s, requestId));
      void loadLatest(agentId).catch(() => {});
    }
    throw e;
  });

/** The Mac's word for a card someone (or expiry) already answered (`answer_gate::already`). */
const ALREADY_ANSWERED = /^Already answered\b/;

/** A secure input card's values, straight to the Mac's Keychain (see `secrets.ts`). */
export function saveSecret(agentId: string, requestId: string, values: string[]) {
  if (!transport) return Promise.reject(new Error('Not paired'));
  return sendSecret(transport, agentId, requestId, values);
}

export const deviceSelf = () => call('devices.self', {});

/**
 * Pin, mute or hide, or how it looks: shown at once, put back if the Mac
 * says no. A colourway also moves the old `color` (the chat's accent) to
 * its nearest, as the Mac does when it saves it.
 */
export async function setAgentToggles(
  agentId: string,
  input: Partial<Record<'pinned' | 'muted' | 'hidden', boolean>> & {
    /** From a Mac listing `MAC_FEATURES.looks`. */
    color?: string;
    /** Its key, from a Mac listing `MAC_FEATURES.agentKeys`. */
    colorway?: string;
    icon?: string;
    boundKey?: string;
    /** "Save new skills", from a Mac that serves `agents.skills`. */
    learnSkills?: LearnSkills;
  }
) {
  const before = getApp().overview;
  const shown = input.colorway ? { ...input, color: legacyColorFor(input.colorway) } : input;
  const patch = (on: typeof before) =>
    on && {
      ...on,
      agents: on.agents.map((a) => (a.id === agentId ? { ...a, ...shown } : a)),
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
                  ? {
                      ...a,
                      pinned: was.pinned,
                      muted: was.muted,
                      hidden: was.hidden,
                      color: was.color,
                      colorway: was.colorway,
                      icon: was.icon,
                      boundKey: was.boundKey,
                      learnSkills: was.learnSkills,
                    }
                  : a;
              }),
            }
          : s.overview,
    }));
    throw error;
  }
}

/**
 * Move an agent to another engine, or another model of its own, from a Mac
 * listing `MAC_FEATURES.engine`. The Mac checks the engine is ready and, on a
 * new engine, starts a new session that carries the conversation over as a
 * recap. Shown once the Mac has said yes, never before: it can refuse (the
 * agent being driven, an engine signed out since).
 */
export async function setAgentEngine(
  agentId: string,
  input: { engine?: AgentEngine; model?: string; effort?: AgentEffort | '' }
) {
  const stored = await call('agents.update', { agentId, input });
  setApp((s) =>
    s.overview
      ? {
          overview: {
            ...s.overview,
            agents: s.overview.agents.map((a) =>
              a.id === agentId
                ? {
                    ...a,
                    engine: stored.engine ?? a.engine,
                    model: stored.model ?? null,
                    // Omitted by the Mac when it is the engine's default.
                    effort: stored.effort,
                  }
                : a
            ),
          },
        }
      : {}
  );
}

/**
 * "Runs on": one of its engine's accounts, or '' for any account. From the
 * next turn; the Mac writes the quiet line in its chat. The stored agent
 * says what it is now (absent: any account).
 */
export async function setAgentAccount(agentId: string, account: string) {
  const stored = await call('agents.update', { agentId, input: { account } });
  setApp((s) =>
    s.overview
      ? {
          overview: {
            ...s.overview,
            agents: s.overview.agents.map((a) =>
              a.id === agentId ? { ...a, account: stored.account } : a
            ),
          },
        }
      : {}
  );
}

/**
 * A new agent, made on the Mac by the desk's own create path. Resolves once
 * the overview has it, read back from the Mac rather than assumed, so its
 * chat opens on the agent as the Mac stores it. `clientId` is the screen's
 * own: tapping Create again after a dropped connection returns the agent
 * the first tap made instead of a second one.
 */
export async function createAgent(
  input: Params<'agents.create'>['input'],
  clientId: string = Crypto.randomUUID()
) {
  const stored = await call('agents.create', { input, clientId });
  if (!getApp().overview?.agents.some((a) => a.id === stored.id)) {
    const fresh = asOverview(await call('agents.overview', {}));
    if (fresh) setApp((s) => ({ overview: shareStructure(s.overview, fresh) }));
  }
  return stored;
}

/**
 * A new conversation, memory kept: on a Mac with several, the one opened in
 * the chat; on an older one, its next message starts one (Start fresh).
 */
export async function startFresh(agentId: string) {
  if (canCall('agents.conversationNew')) {
    await newConversation(agentId);
    return;
  }
  await call('agents.startFresh', { agentId });
}

// ---- Conversations ------------------------------------------------------------

function setConversations(list: Conversations) {
  setApp((s) => ({ conversations: { ...s.conversations, [list.agentId]: list } }));
}

/** An agent's conversations, read again (null on a Mac without them). */
export async function refreshConversations(agentId: string): Promise<Conversations | null> {
  if (!canCall('agents.conversations')) return null;
  const list = await call('agents.conversations', { agentId });
  setConversations(list);
  return list;
}

/** Which conversation the chat opens on: where the user last was, on any device. */
export async function ensureViewing(agentId: string): Promise<void> {
  if (getApp().viewing[agentId]) return;
  // The Mac couldn't say: the first conversation, which every agent has,
  // rather than a chat that never opens.
  const list = await refreshConversations(agentId).catch(() => null);
  const id = list?.current ?? FIRST_CONVERSATION;
  setApp((s) => (s.viewing[agentId] ? {} : { viewing: { ...s.viewing, [agentId]: id } }));
}

/** Show one of an agent's conversations, and tell the Mac the user is in it. */
export async function openConversation(agentId: string, conversation: string) {
  setApp((s) => ({ viewing: { ...s.viewing, [agentId]: conversation } }));
  setConversations(
    await call('agents.conversationSelect', { agentId, conversationId: conversation })
  );
}

/** "New conversation": opened at once (or the empty one already open). */
export async function newConversation(agentId: string) {
  const list = await call('agents.conversationNew', { agentId });
  setConversations(list);
  setApp((s) => ({ viewing: { ...s.viewing, [agentId]: list.current } }));
}

/** Run a routine in another of the agent's conversations, from its next run. */
export async function moveRoutine(agentId: string, routineId: string, conversation: string) {
  setConversations(
    await call('agents.conversationRoutine', { agentId, routineId, conversationId: conversation })
  );
}

/**
 * "Rewind to here": the conversation carries on from just before the user's
 * message; what came after stays in the chat, folded. The chat is read again
 * so the Mac's line saying so is in it.
 */
export async function rewindConversation(agentId: string, conversation: string, messageId: string) {
  setConversations(
    await call('agents.conversationRewind', { agentId, conversationId: conversation, messageId })
  );
}

/** "Fork from here": a new conversation with everything before the message, opened at once. */
export async function forkConversation(agentId: string, conversation: string, messageId: string) {
  const list = await call('agents.conversationFork', {
    agentId,
    conversationId: conversation,
    messageId,
  });
  setConversations(list);
  setApp((s) => ({ viewing: { ...s.viewing, [agentId]: list.current } }));
}

/** Whether this Mac can go back (rewind, fork, edit and resend). */
export const canGoBack = () =>
  canCall('agents.conversationRewind') && canCall('agents.conversationFork');

/**
 * Edit and resend: back to just before `messageId` in `conversation`, then
 * the new words sent there. A refused rewind sends nothing (it throws).
 */
export async function sendEdited(
  agentId: string,
  conversation: string,
  messageId: string,
  text: string,
  mentions: string[] = [],
  attachments: PendingAttachment[] = []
) {
  await rewindConversation(agentId, conversation, messageId);
  await send(agentId, text, false, undefined, attachments, mentions);
}

/** Name one; empty gives it back to its first message. */
export async function renameConversation(agentId: string, conversation: string, title: string) {
  setConversations(
    await call('agents.conversationRename', { agentId, conversationId: conversation, title })
  );
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

/**
 * An image source for an attachment: the Mac's thumbnail at `width` points
 * (2x for the screen). On Tailscale, its address and headers; over the relay,
 * the downloaded file (no `uri` while it comes, null if it couldn't).
 */
export function attachmentSource(
  agentId: string,
  path: string,
  width?: number
): { uri?: string; headers?: Record<string, string>; cacheKey: string } | null {
  if (!transport) return null;
  const w = width ? width * 2 : undefined;
  const cacheKey = `${agentId}/${path}@${width ?? 'full'}`;
  if (transport instanceof DirectTransport && transport.route.kind === 'relay') {
    const t = transport;
    const uri = relayImage(cacheKey, () => t.download({ agentId, path }, w));
    if (uri === null) return null;
    if (uri) return { uri, cacheKey };
    return { cacheKey };
  }
  return {
    uri: transport.attachmentUrl(agentId, path, w),
    headers: transport.authHeaders,
    cacheKey,
  };
}

/**
 * "Tap to try again" on a picture: over the relay it's fetched again; on a
 * direct route the image view reloads it itself.
 */
export function retryAttachmentSource(agentId: string, path: string, width?: number) {
  retryRelayImage(`${agentId}/${path}@${width ?? 'full'}`);
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
/**
 * "Watch live": a one-time link to the card's running site, on this Mac's
 * tailnet only. `link`: one of the message's `localLinks` instead (Macs
 * with `watch.links`).
 */
export const watchLive = (agentId: string, messageId: string, link?: number) =>
  call('agents.watchLive', link == null ? { agentId, messageId } : { agentId, messageId, link });

/** A path written in an agent's reply, fetched from the Mac and saved here. */
export async function fetchPath(agentId: string, path: string) {
  const blob = await call('agents.fetchPath', { agentId, path });
  const local = await download({ blobId: blob.blobId });
  return { ...blob, uri: local };
}

// ---- Search -------------------------------------------------------------------------

export const search = (query: string) => call('agents.search', { query });

/**
 * Page a chat back until `messageId` is loaded, for a search hit. `key` is
 * the chat it reads from: a conversation's (`conversationKey`) on a Mac that
 * keeps several, else the agent's. Gives up after `maxPages` pages; resolves
 * whether it was found.
 */
export async function loadUntil(key: string, messageId: string, maxPages = 40) {
  const has = () => getApp().chats[key]?.messages.some((m) => m.id === messageId) ?? false;
  if (!getApp().chats[key]?.loaded) await loadLatest(key);
  for (let i = 0; i < maxPages && !has(); i++) {
    if (!getApp().chats[key]?.more) break;
    await loadOlder(key);
  }
  return has();
}

// ---- Check-ins and routines ---------------------------------------------------------

export const schedule = {
  preview: (when: string) => call('agents.schedule.preview', { when }),
  /** `then`: steps after the first, only to a Mac listing `MAC_FEATURES.steps`. */
  create: (agentId: string, when: string, note: string, then?: RoutineStep[]) =>
    call('agents.schedule.create', { agentId, when, note, ...(then ? { then } : {}) }),
  update: (agentId: string, id: string, when: string, note: string, then?: RoutineStep[]) =>
    call('agents.schedule.update', { agentId, id, when, note, ...(then ? { then } : {}) }),
  pause: (agentId: string, id: string, paused: boolean) =>
    call('agents.schedule.pause', { agentId, id, paused }),
  cancel: (agentId: string, id: string) => call('agents.schedule.cancel', { agentId, id }),
  runNow: (agentId: string, id: string) => call('agents.schedule.runNow', { agentId, id }),
};

/**
 * "When…" routines, on a Mac that lists these methods (`canCall`). Pause and
 * Cancel are `schedule.pause|cancel`, shared with timed routines.
 */
export const watch = {
  options: (agentId: string) => call('agents.watch.options', { agentId }),
  create: (agentId: string, source: WatchSource, everyMinutes: number, note: string) =>
    call('agents.watch.create', { agentId, source, everyMinutes, note }),
  update: (agentId: string, id: string, source: WatchSource, everyMinutes: number, note: string) =>
    call('agents.watch.update', { agentId, id, source, everyMinutes, note }),
  checkNow: (agentId: string, id: string) => call('agents.watch.checkNow', { agentId, id }),
};

// ---- Projects and sessions -----------------------------------------------------------

export async function refreshProjects() {
  const projects = asProjects(await call('projects.list', {}));
  if (projects) setApp({ projects });
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
  // Leaving the demo: nothing was saved, and there's no Mac to tell.
  if (isDemo(credentials)) {
    transport?.close();
    transport = null;
    setApp({
      ...emptySync(),
      credentials: null,
      welcome: null,
      served: null,
      refusal: null,
      openChat: null,
      push: null,
      composer: {},
      teamSetup: null,
      link: { kind: 'connecting', attempt: 0 },
    });
    return 'removed';
  }
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
  liveAlerts.forget();
  forgetRemembered();
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
  const { list, damaged } = readForgets(raw, asCredentials);
  // Whatever couldn't be read is dropped from the keychain, so it can't
  // stop the readable ones (or the next launch) again.
  if (damaged) await saveForgets(list).catch(() => {});
  return list;
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

/**
 * The Mac's alerts (`liveAlerts.ts`). It already left out the socket in
 * front of that chat; a chat opened since is checked here.
 */
const liveAlerts = new LiveAlerts(
  defaultDeps(
    (id) => getApp().overview?.agents.find((a) => a.id === id),
    (id) => getApp().openChat === id && AppState.currentState === 'active'
  )
);

const notify = (alert: Alert) => liveAlerts.alert(alert);

/** This Mac sends `alert` for every card that needs the user (`MAC_FEATURES.alerts`). */
const macSendsAlerts = () => !!getApp().welcome?.features?.includes(MAC_FEATURES.alerts);

/** How long after posting a card's own notification the relay's duplicate is looked for again. */
const PUSH_DEDUPE_MS = 4000;

/**
 * With a Mac that sends no alerts (older than `MAC_FEATURES.alerts`): a
 * new card arrives over the socket while the app is in the background (iOS
 * gives it seconds there), so this phone posts it itself, with its words
 * and, when it fits, Allow / Deny (`actionable.ts`). Replayed history is
 * never news; in front, the app shows it. Runs before the message is
 * stored, so "new" is knowable.
 */
function alertApproval(m: AgentMessage) {
  if (!caughtUp || AppState.currentState === 'active') return;
  if (m.kind !== 'approval' || m.approval?.status !== 'pending') return;
  const s = getApp();
  if (isDemo(s.credentials)) return;
  if (s.chats[m.agentId]?.messages.some((x) => x.id === m.id)) return;
  const agent = s.overview?.agents.find((a) => a.id === m.agentId);
  const notice = agent && approvalNotice(agent, m);
  if (!notice) return;
  void postNotice(notice).then((posted) => {
    if (!posted) return;
    // The relay's "needs you" for the same card may land just after: keep the one with words.
    void dismissPushFor(m.agentId);
    setTimeout(() => void dismissPushFor(m.agentId), PUSH_DEDUPE_MS);
  });
}

/** How long an answer from a notification waits for the Mac. */
const ANSWER_WAIT_MS = 20_000;

/** Resolves once the Mac is answering, or false after `ms`. */
export function waitLive(ms = ANSWER_WAIT_MS): Promise<boolean> {
  if (getApp().link.kind === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      stop();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    const stop = useApp.subscribe((st) => {
      if (st.link.kind === 'connected') done(true);
      else if (st.link.kind === 'refused') done(false);
    });
    // Woken from the background: don't wait out a backoff.
    transport?.retryNow();
  });
}

/**
 * Allow or Deny tapped on a notification. The same request as the card in
 * the app, so the Mac's one-answer-per-card claim decides; what didn't land
 * is said in a notification of its own.
 */
export function answerFromNotification(
  target: { agentId: string; messageId?: string; requestId?: string },
  allow: boolean
): Promise<AnswerOutcome> {
  return answerFromAlert(target, allow, {
    waitLive: () => waitLive(),
    answer: (agentId, requestId, yes) => answerApproval(agentId, requestId, yes, false),
    describe: describeError,
    tell: (back: Target, body: string) => postNote(back, 'Not answered', body),
    dismiss: dismissApproval,
  });
}

/**
 * A message is about to be stored: take back the alert for an approval
 * that was just answered, and tell VoiceOver / TalkBack what's new.
 */
function noticeMessage(m: AgentMessage) {
  const known = getApp().chats[m.agentId]?.messages.find((x) => x.id === m.id);
  // Answered or expired, here or anywhere: its notification is no longer
  // true. Taken back even when this chat was never loaded (the alert came
  // over the socket, or as a push), and on replay after a reconnect.
  if (
    m.approval &&
    m.approval.status !== 'pending' &&
    known?.approval?.status !== m.approval.status
  ) {
    void dismissApproval(m.agentId, m.id);
  }
  if (!caughtUp || known) return;
  const name = getApp().overview?.agents.find((a) => a.id === m.agentId)?.name ?? 'An agent';
  if (m.kind === 'approval' && m.approval?.status === 'pending') {
    announce(`${name} needs your OK: ${m.approval.title}`, true);
  } else if (m.kind === 'agent') {
    // In its open chat the reply is read; a streamed one was a moving target until now.
    const here = getApp().openChat === m.agentId && AppState.currentState === 'active';
    announce(replyAnnouncement(name, here ? speakable(m.text ?? '') : '', here), here);
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
    if (s.overview === prev.overview && s.link === prev.link && s.teamSetup === prev.teamSetup)
      return;
    // Times read the Mac's way (it writes routine times into sentences itself).
    setClockHour24(s.overview?.hour24);
    const refused = s.link.kind === 'refused';
    // The demo's count is samples; the icon outlives it, so it never shows one.
    const demo = isDemo(s.credentials);
    void setBadge(refused || demo || !s.overview ? 0 : badgeCount(s.overview.agents, s.teamSetup));
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
  const comp = pairedComputer();
  if (!(error instanceof WireFailure)) {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }
  const e = error.error;
  switch (e.type) {
    case 'Protocol':
      return e.message;
    case 'Timeout':
      return `${comp.yourCap} didn’t answer in time.`;
    case 'Validation':
      return e.reason;
    case 'NotAuthenticated':
      return `${e.service} is signed out on ${comp.your}.`;
    case 'Process':
    case 'MergeConflict':
      return `A command on ${comp.your} failed.`;
    case 'Io':
    case 'Other':
      return e.message;
  }
}
