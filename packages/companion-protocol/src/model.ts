/**
 * The things the Mac and the phone talk about.
 *
 * The agent types are the desktop's own (`src/lib/agents.ts`, which mirrors
 * `src-tauri/src/agents/`), copied here so the Expo app needn't import a file
 * that pulls in Tauri. `desktop-conformance.ts` fails `tsc` if the two copies
 * ever differ; Rust is held to them by the generated fixtures (see docs/mobile.md,
 * "Keeping the types honest").
 *
 * Everything below the agent types is new to the companion.
 */

// ============================================================================
// Agents: identical to src/lib/agents.ts
// ============================================================================

import type { ResultCard, ResultRef } from './results';

export interface AgentStatus {
  state: 'idle' | 'working' | 'waiting';
  activity: string | null;
  since: number | null;
  /** The turn's timeline so far, while it isn't idle; older Macs omit it. */
  work?: TurnWork;
  /** The room the turn in progress answers in; absent for the agent's own chat. */
  room?: string;
}

/**
 * What kind of thing a timeline step was, for its icon (`agents::work::StepKind`).
 * A newer Mac may send a kind this build doesn't know: draw it as `tool`.
 */
export type WorkStepKind =
  | 'read'
  | 'edit'
  | 'search'
  | 'web'
  | 'command'
  | 'message'
  | 'approval'
  | 'screenshot'
  | 'plan'
  | 'delegate'
  | 'project'
  | 'tool';

/** One thing a turn did, in plain words ("Read Hero.tsx", "Ran npm test"). */
export interface WorkStep {
  /** When it was seen, ms since the epoch. */
  at: number;
  kind: WorkStepKind;
  label: string;
  /**
   * What became of it, when it didn't simply go through: `declined` (the
   * user said no) or `failed` (it came back with an error). Absent while it
   * runs and once it succeeded. Its label already says so in words.
   */
  outcome?: WorkStepOutcome;
  /** A screenshot this step produced. */
  image?: Attachment;
}

/** `agents::work::StepOutcome`. */
export type WorkStepOutcome = 'declined' | 'failed';

/**
 * What a turn did (`agents::work`): on the status while it runs (its newest
 * steps), and on the message it ended on once it's over. Only what the
 * engine's output said it did; a turn with no steps has none.
 */
export interface TurnWork {
  startedAt: number;
  /** Absent while the turn is still running. */
  endedAt?: number;
  /** Every step seen, including any no longer kept in `steps`. */
  stepCount: number;
  /** The newest steps, oldest first. */
  steps: WorkStep[];
  /** Files it edited successfully, distinct. Not carried while it runs. */
  files?: string[];
  fileCount: number;
  /**
   * While it runs: the working-line words of the newest step, while that
   * call hasn't come back. When it equals the status's `activity`, the
   * working line *is* that step.
   */
  doing?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  shape: number;
  color: string;
  isMain: boolean;
  /**
   * The user's "Admin — can manage and approve for other agents" switch
   * (`agents::admin`). Absent: the default, which is on for the Chief of
   * Staff only (`isAdmin`). Older Macs never send it.
   */
  admin?: boolean;
  pinned: boolean;
  hidden: boolean;
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  preview: string | null;
  unread: number;
  pendingApprovals: number;
  /** What its turns run on; mirrors `engine::Engine`. */
  engine: AgentEngine;
  /** One of its engine's models; null is that engine's default. */
  model: string | null;
  /** What its routines run on; omitted when automatic. */
  routineModel?: string;
  /** The ready-made agent it was made from (`agents.templates`), if any. */
  template?: string;
  muted: boolean;
  checkIns?: CheckIn[];
  /**
   * Its "When…" routines (each a `CheckIn` with `watch`), apart from the
   * timed ones so an older app doesn't take one for a one-time check-in.
   * Sent by a Mac whose `welcome.features` has `routines.when`.
   */
  watches?: CheckIn[];
  permissions?: PermissionRule[];
  status: AgentStatus;
  /** The agent's home on the Mac. Only meaningful as a base for `Attachment.path`. */
  home: string;
  failure?: Failure;
  project?: string;
  /** Its open copy of that project, where its turns run until kept or discarded. */
  copy?: TaskCopy;
  /** Set to work directly in the project instead of in a copy. */
  workDirectly?: boolean;
  capabilities?: Capabilities;
  /** Secrets it has in the Keychain (names only); omitted when none. */
  secrets?: AgentSecret[];
  /** Browser access and the Claude Code apps kept from it; omitted when it has the defaults. */
  reach?: AgentReachSettings;
  /** Moved engines and not run there yet: its next turn starts a new conversation. */
  newEngine?: boolean;
  /** How full its conversation is, as its engine reported it; omitted when it doesn't say. */
  context?: ContextFill;
  /** You're driving its session in a terminal on the Mac; omitted otherwise. */
  takeover?: AgentTakeover;
}

/**
 * Mirrors `takeover::View` without the Mac's terminal id, which the Mac
 * strips before it is sent (`wire::phone_overview`). The phone shows the
 * state; it can't take over.
 */
export interface AgentTakeover {
  /** When it began (epoch ms). */
  since: number;
  /** A bound agent's project: the terminal is a tab in its workspace. */
  project?: string;
  /** The workspace's id for the CLI, for that tab. */
  cli: 'claude-code' | 'codex';
  /** Claude Code will ask whether to trust the folder first; omitted otherwise. */
  trustPrompt?: boolean;
}

/** Mirrors `context::ContextFill`: two numbers the engine reported, never estimated. */
export interface ContextFill {
  /** Tokens its latest request carried. */
  used: number;
  /** The model's context window. */
  window: number;
  at: number;
  /** The engine's own id for the model that made the request, when it says. */
  model?: string;
}

export interface Failure {
  kind: 'usage_limit' | 'signed_out' | 'other';
  resetsAt?: number;
}

export type Repeat =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number };

export interface CheckIn {
  id: string;
  note: string;
  repeat?: Repeat;
  nextAt: number;
  createdAt: number;
  paused: boolean;
  /** Its last runs, oldest first; omitted before the first. */
  runs?: CheckInRun[];
  /** A failed run waiting to be tried again. */
  retry?: CheckInRetry;
  /** A "When…" routine: it runs when something happens; `nextAt` is its next check. */
  watch?: Watch;
}

/** What a "When…" routine waits for; mirrors `watch::Source`. */
export type WatchSource =
  | { kind: 'github_mentions' }
  | { kind: 'github_assigned' }
  | { kind: 'linear_assigned' }
  | { kind: 'new_file'; folder: string }
  /** `app`: the Claude Code app it checks through. Absent on older Macs' routines. */
  | { kind: 'custom'; check: string; app?: string }
  /** Written by a newer Mac. */
  | { kind: 'unknown' };

/** One thing a check found; mirrors `watch::Event`. */
export interface WatchEvent {
  id: string;
  title: string;
  detail?: string;
  url?: string;
}

/** A "When…" routine's state; mirrors `watch::Watch`. */
export interface Watch {
  source: WatchSource;
  everyMinutes: number;
  /** Ids already handled. Desk only: it stays on the Mac for the phone. */
  seen?: string[];
  /** When the first check noted what was already there; absent until then. */
  baselineAt?: number;
  lastCheckedAt?: number;
  lastFoundAt?: number;
  lastFound: number;
  /** Failed checks in a row. */
  failures: number;
  lastError?: string;
  /** The last firing's items, kept for its retry. Desk only. */
  pending?: WatchEvent[];
  /** Why it paused itself. */
  pausedNote?: string;
  /** Model checks only: how many ran on a local day, for the daily cap. */
  dayChecks?: { day: string; checks: number };
  /** Model checks only: the daily cap when not the default (24). */
  maxChecksPerDay?: number;
  /** Model checks only: an empty answer before the baseline, not yet trusted as one. */
  emptyAnswers?: number;
  /** What part of the source its checks cover, when not all of it. */
  coverage?: string;
}

/** One scheduled run and what came of it; mirrors `runs::Run`. */
export interface CheckInRun {
  at: number;
  outcome: 'running' | 'ran' | 'retrying' | 'failed' | 'skipped' | 'unknown';
  /** 1 for the run itself, 2 for its first retry. */
  attempt: number;
  /** Why it failed, as the chat said it. */
  detail?: string;
  retryAt?: number;
  /** Connectors Claude Code said need signing in again. */
  signIn?: string[];
  /** Run now, from the popover. */
  manual?: boolean;
}

/** Mirrors `runs::Retry`. */
export interface CheckInRetry {
  at: number;
  attempts: number;
  firstFailedAt: number;
  dueAt: number;
}

export interface CheckInMark {
  dueAt: number;
  late: boolean;
  repeats: boolean;
  manual?: boolean;
  /** A "When…" routine fired: what it found ("2 new GitHub mentions"). */
  found?: string;
}

export interface SchedulePreview {
  nextAt: number;
  repeat: Repeat | null;
}

export type AgentEngine = 'claude' | 'codex';

export interface ModelChoice {
  value: string;
  label: string;
}

/** Mirrors `engine::EngineInfo`: an engine an agent can run on, as found on this Mac. */
export interface EngineInfo {
  id: AgentEngine;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /**
   * Its turns can stop to ask (an approval card) before going past what it
   * may do alone. Optional: a Mac from before it sends none.
   */
  asks?: boolean;
  /** The engine's own models, without Default. */
  models: ModelChoice[];
}

/**
 * Mirrors `defaults::View`: what a new agent starts on when nobody picked
 * (Settings → Agents). Existing agents keep their own engine and model.
 */
export interface NewAgentDefaults {
  /** The engine the user chose; null when they never have (the rule decides). */
  engine: AgentEngine | null;
  /** Each engine's chosen model while it still offers it; null is the engine's own default. */
  models: { claude: string | null; codex: string | null };
  /** Where a new agent starts now: the chosen engine when it's ready, else the first that is. */
  startsOn: AgentEngine;
  /** The model it starts on there; null is that engine's default. */
  model: string | null;
}

/** A change to `NewAgentDefaults`: a field left out stays; an empty model is the engine's own. */
export interface NewAgentDefaultsChange {
  engine?: AgentEngine;
  claudeModel?: string;
  codexModel?: string;
}

export interface AgentsOverview {
  agents: Agent[];
  /** Claude Code is installed (the default engine). */
  engineReady: boolean;
  engines: EngineInfo[];
  /** What new agents start on. Optional: a Mac from before it sends none. */
  defaults?: NewAgentDefaults;
  /** How much agents do on their own. Optional: a Mac from before it sends none. */
  independence?: AgentIndependence;
}

/**
 * Mirrors `agents::independence::Level`: how much the user's agents do on
 * their own. It changes what they're told, never what asks for an Allow.
 */
export type AgentIndependence = 'often' | 'judgement' | 'go_hard';

export type MessageKind =
  | 'user'
  | 'agent'
  | 'sent_to_agent'
  | 'from_agent'
  | 'approval'
  | 'error'
  | 'check_in'
  | 'note'
  | 'changes'
  | 'session';

export interface SessionMark {
  project: string;
  event: 'started' | 'sent' | 'reply' | 'screenshot';
  sessionId?: string;
  tab?: number;
  cli?: string;
}

export interface Capabilities {
  seenAt: number;
  lines: { what: string; detail: string }[];
}

export interface PermissionScope {
  kind: 'command_prefix' | 'command' | 'domain' | 'tool';
  value: string;
  label: string;
}

export interface PermissionRule extends PermissionScope {
  id: string;
  createdAt: number;
}

export interface AgentRef {
  id: string;
  name: string;
}

export interface Approval {
  requestId: string;
  title: string;
  detail: string;
  /** A plain sentence to lead with when `detail` is raw (a push); show detail behind Details. */
  summary?: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  tool?: string;
  input?: unknown;
  always?: PermissionScope;
  alwaysAllowed?: boolean;
  note?: string;
  /** A secure input card: what the agent asked for. */
  secret?: SecretRequest;
  /** A question a project session is waiting on, answered with keys sent to it. */
  prompt?: SessionPrompt;
  /** The option picked on a `prompt` card. */
  choice?: string;
  /** An import connector card: another assistant asking to start, or its staged agents. */
  connector?: ConnectorCard;
  /**
   * Closed by the app rather than answered (status `expired`), with the line
   * saying why: a request from work that was replaced, such as the check-in
   * after an import. Nothing it asked for ran.
   */
  setAside?: string;
  /**
   * A login card (`request_login`): which app, what the agent may do, and the
   * ways in, best first. Every way in runs on the Mac (`agents.loginStart`);
   * `flow` is its live state. A Mac without the `logins` feature never sends it.
   */
  login?: LoginRequest;
}

// Logins: identical to src/lib/agentLogins.ts (desktop `agents/logins.rs`).
// Never a credential: names, abilities and the ways in only.

export type LoginMethod = 'existing' | 'oauth' | 'claude_ai' | 'gh' | 'browser' | 'key';

export interface LoginAbility {
  /** `read`, or `write` (send, post, change). */
  id: 'read' | 'write';
  label: string;
}

export interface LoginOption {
  /** Unique on the card: the method, or `existing:<connectionId>`. */
  id: string;
  method: LoginMethod;
  label: string;
  /** What it means: where it signs in, where the sign-in is kept. */
  detail: string;
  connectionId?: string;
}

export type LoginFlowState = 'starting' | 'waiting' | 'failed' | 'cancelled';

/** A way in under way, on the Mac. Live only; never stored. */
export interface LoginFlow {
  state: LoginFlowState;
  option: string;
  message?: string;
  startedAt: number;
  /** Started from a phone: "Finish signing in on your Mac". */
  fromPhone?: boolean;
  /** The sign-in is on the phone (its sheet, claude.ai there, a device code), not the Mac's browser. */
  onPhone?: boolean;
  /** A device sign-in's one-time code (GitHub), typed at `verificationUri` on either device. */
  userCode?: string;
  verificationUri?: string;
}

export interface LoginRequest {
  /** The catalogue's id ("gmail", "linkedin"), or `other`. */
  service: string;
  title: string;
  /** What the agent called it, when that differs ("gmail work"). */
  askedAs?: string;
  accountHint?: string;
  why: string;
  abilities: LoginAbility[];
  /** Best first. Empty when nothing on the Mac can sign it in (`noConnector` says why). */
  options: LoginOption[];
  noConnector?: string;
  /** The masked field, when an API key is a way in (`key` option). */
  key?: SecretRequest;
  quiet?: boolean;
  /** The secret card an older Mac build raised, which this replaced. */
  replaces?: string;
  flow?: LoginFlow;
}

/** `agents.loginPhoneBegin`: what the phone opens. No secret: the PKCE verifier stays on the Mac. */
export interface LoginPhoneBegin {
  flowId: string;
  /** The card it signs in for (a team row's first), for `agents.loginCancel`. */
  agentId: string;
  requestId: string;
  /** The provider's authorization URL, for the system sign-in sheet. */
  url: string;
  /** The companion app's own redirect, which the sheet hands back. */
  redirectUri: string;
}

export type TeamCardState = 'waiting' | 'connected' | 'skipped' | 'covered';

/** One agent's ask on a row of "What your team needs". */
export interface TeamCard {
  agentId: string;
  agentName: string;
  requestId: string;
  service: string;
  title: string;
  abilities: LoginAbility[];
  state: TeamCardState;
  /** How it was answered ("Connected · Gmail (work@acme.com)", "Not needed"). */
  outcome?: string;
  askedAs?: string;
  flow?: LoginFlow;
}

/** One row: a service (or Google's family), every agent on it, one way in for all. */
export interface TeamNeed {
  key: string;
  title: string;
  services: string[];
  options: LoginOption[];
  noConnector?: string;
  cards: TeamCard[];
  done: boolean;
}

export interface TeamLogins {
  needs: TeamNeed[];
  /** Rows done, of rows. */
  done: number;
  total: number;
}

/** "What it can reach" (`agents.reach`): read-only on the phone. */
export interface AgentReach {
  connections: {
    connectionId: string;
    service: string;
    title: string;
    account: string;
    access: 'read' | 'full';
    /** Where the sign-in is kept, in words. */
    kept: string;
    needsSignIn: boolean;
    lastUsedAt?: number;
  }[];
  /** Absent for an agent on Codex, which has no browser. */
  browser?: { on: boolean; sites: string[]; helperInstalled: boolean };
  secrets: {
    secretId: string;
    name: string;
    purpose: string;
    variables: string[];
    lastUsedAt?: number;
  }[];
  /** Claude Code apps kept from this agent. */
  blockedApps: string[];
}

/**
 * An import over the connector (desktop `agents/review.rs`). On the phone a
 * consent card is Allow / Deny. A review card can't be answered there: it
 * says "Review on your Mac", where each agent's instructions are on screen
 * before Import (the desktop refuses an Allow sent for one).
 */
export interface ConnectorCard {
  kind: 'consent' | 'playback' | 'review';
  talkId: string;
  source: string;
  review?: ImportReview;
  /**
   * Playback only: what each agent will do, in plain words. Answerable on the
   * phone: Allow is "That's everything", Deny with a note adds what's missing.
   */
  playback?: PlaybackAgent[];
}

export interface PlaybackAgent {
  key: string;
  name: string;
  lines: { kind: PlaybackKind; text: string }[];
}

export type PlaybackKind =
  | 'job'
  | 'routine'
  | 'watch'
  | 'app'
  | 'keep'
  | 'login'
  | 'history'
  | 'gap';

/** Past conversations that arrived for one agent, as counted. */
export interface ImportHistoryCount {
  conversations: number;
  messages: number;
  masked?: number;
  chars?: number;
  capped?: boolean;
}

/** An import with another assistant over the connector (desktop `agents/connector.rs`). */
export interface ImportTalk {
  id: string;
  source: string;
  chiefId: string;
  state:
    | 'awaiting_consent'
    | 'interviewing'
    | 'playback'
    | 'review'
    | 'imported'
    | 'declined'
    | 'denied'
    | 'stopped';
  startedAt: number;
  lastAt: number;
  exchanges: number;
  staged: string[];
  imported: string[];
  busy: boolean;
  conversations?: number;
  playbacks?: number;
}

/** What importing from a review card made. */
export interface ImportApplied {
  agents: string[];
  replaced: string[];
  skipped: [string, string][];
  chiefNotes: boolean;
  routinesRefused: string[];
}

/**
 * "Setting up your team" after an import (desktop `agents/team_setup.rs`):
 * one checklist in the Chief's chat. Logins, routines to switch on, what the
 * agents said they're missing, then saying hi to each, in that order. Read
 * from the Mac every time; only the user's choices are kept there.
 */
export type TeamSetupStepId = 'logins' | 'routines' | 'missing' | 'hello';
export type TeamSetupStepState = 'open' | 'done' | 'skipped';
export type TeamSetupHelloState = 'quiet' | 'working' | 'said_hi';

export interface TeamSetupLogin {
  agentId: string;
  agentName: string;
  requestId: string;
  /** What the agent called it (a secret's key): never shown as a title. */
  name: string;
  purpose: string;
  /** The app's name ("Gmail"), or the key made readable ("Email drafts"). Absent from an older Mac. */
  title?: string;
  /** Which row ("google", "github", "email drafts"). */
  group?: string;
  /** The family's name ("Google"), when the row is one. */
  family?: string;
  /** A login card (connected from "What your team needs") or a secure input card. */
  kind?: 'login' | 'secret';
  /** Which account, when the card says. */
  account?: string;
}

export interface TeamSetupRoutine {
  agentId: string;
  agentName: string;
  checkInId: string;
  /** "Every weekday at 09:00", as the Mac's schedule says it. */
  when: string;
  what: string;
  on: boolean;
}

export interface TeamSetupGap {
  agentId: string;
  agentName: string;
  lines: string[];
}

export interface TeamSetupHello {
  agentId: string;
  agentName: string;
  color: string;
  state: TeamSetupHelloState;
}

export interface TeamSetupStep {
  id: TeamSetupStepId;
  state: TeamSetupStepState;
  logins?: TeamSetupLogin[];
  routines?: TeamSetupRoutine[];
  gaps?: TeamSetupGap[];
  agents?: TeamSetupHello[];
}

export interface TeamSetupView {
  id: string;
  source: string;
  /**
   * When it was posted (the import's end): its place in the Chief's
   * conversation, like a message's. Older Macs don't say.
   */
  postedAt?: number;
  steps: TeamSetupStep[];
  /** Steps done or skipped. */
  done: number;
  total: number;
  /** The first open step. */
  current?: TeamSetupStepId;
  complete: boolean;
  /** How many agents it covers. */
  agents: number;
  /** Requests the update set aside, when it folded an earlier import in. */
  setAside?: number;
  /** Put away by the user (only when asked for with `any`). */
  dismissed: boolean;
}

/**
 * An import as the phone follows it (`agents.import.status`). Never the
 * Remote access link: it's a key, and only the Mac copies it.
 */
export interface PhoneImportStatus {
  remoteAccess: { enabled: boolean; funnelOn: boolean; everConnected: boolean };
  /** Start was pressed: one import may begin. */
  armed: boolean;
  talk: ImportTalk | null;
  /** The message to send the other assistant (no secrets in it). */
  prompt: string;
  chiefId: string | null;
}

export interface ImportReview {
  proposals: ImportProposal[];
  chiefNotes?: string;
  summary?: string;
}

export interface ImportProposal {
  key: string;
  name: string;
  role: string;
  instructions: string;
  memory: string;
  routines: { when: string; what: string; schedule?: string; refused?: string }[];
  logins: { name: string; purpose: string; kind: string }[];
  watches?: { when: string; what: string }[];
  apps?: { name: string; purpose: string }[];
  preferences?: string;
  context?: string;
  history?: ImportHistoryCount;
  clash?: ImportClash;
  foreignPaths?: string[];
  foreignTools?: { name: string; here?: string }[];
}

export interface ImportClash {
  agentId: string;
  name?: string;
  role: string;
  instructions: string;
  logins?: string[];
  project?: string;
  activeRoutines?: number;
  rules?: number;
  conversation?: boolean;
}

/** One answer a session's question offers, as the session shows it. */
export interface PromptOption {
  label: string;
  keys: string[];
  role: 'allow' | 'deny' | 'other';
}

/**
 * A question a project session can't answer itself (folder trust, a
 * permission prompt, a menu). The same card sits in every chat in `chats`;
 * answering it in one answers it in all.
 */
export interface SessionPrompt {
  kind: 'trust' | 'permission' | 'choice';
  project: string;
  sessionId: string;
  tab: number;
  question: string;
  options: PromptOption[];
  owner: AgentRef;
  chats: string[];
}

// Secrets: identical to src/lib/agentSecrets.ts. A value is never part of
// any of these; only names, purposes and variable names travel.

export type SecretKind = 'password' | 'api_key' | 'token' | 'other';

export interface SecretField {
  label: string;
  env: string;
}

export interface SecretRequest {
  name: string;
  purpose: string;
  kind: SecretKind;
  fields: SecretField[];
  reference: string;
}

export interface AgentSecret extends SecretRequest {
  id: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface AgentMessage {
  id: string;
  agentId: string;
  ts: number;
  kind: MessageKind;
  text: string;
  peer?: AgentRef;
  approval?: Approval;
  attachments?: Attachment[];
  checkIn?: CheckInMark;
  stopped?: boolean;
  mentions?: AgentRef[];
  failure?: Failure;
  changes?: ChangeSummary;
  session?: SessionMark;
  /**
   * On a user message sent from a phone: the `clientId` its `agents.send`
   * carried, so the phone's optimistic bubble is replaced by id, not by text.
   * Absent on everything else; older clients ignore it.
   */
  clientId?: string;
  /** What the turn that ended on this message did; older Macs omit it. */
  work?: TurnWork;
  /** On a `note`: the conversation started fresh here (memory kept); a divider. */
  fresh?: boolean;
  /**
   * A result card (`share_result`): on an `agent` message of its own, or on
   * the turn's `changes` card when the turn also changed a project. Older
   * Macs never send it.
   */
  result?: ResultCard;
  /** On a user message: "Ask for changes" on this result. */
  revises?: ResultRef;
  /** On a `note` (an `error` from older Macs): a take-over's terminal closed by itself; not a turn's failure. */
  takeover?: boolean;
  /**
   * Said in a room, not the agent's own chat: the room's id. A line only the
   * room has (the user's message, a room note) has an empty `agentId`.
   */
  room?: string;
  /**
   * On an admin's `agent` message: other agents' requests only the user can
   * decide, each answered in place (the answer goes to that agent's card).
   */
  decide?: DecideItem[];
}

/** One of another agent's cards, brought to the user by an admin. */
export interface DecideItem {
  agentId: string;
  agentName: string;
  approval: Approval;
}

/** Whether an agent is an admin: its switch, else on for the Chief only. */
export function isAdmin(agent: Pick<Agent, 'admin' | 'isMain'>): boolean {
  return agent.admin ?? agent.isMain;
}

/**
 * A group conversation of 2–6 agents (`agents::rooms`). Each member keeps its
 * own session and memory; the room is a shared thread.
 */
export interface Room {
  id: string;
  name: string;
  /** Agent ids, in the order they were added. */
  members: string[];
  /** Who answers a message that mentions nobody; absent: ask who should. */
  lead?: string;
  muted: boolean;
  createdAt: number;
  lastActivityAt: number;
  preview?: string;
  unread: number;
  /** What the room is for, in a line. Absent from older Macs and rooms made without one. */
  purpose?: string;
  /** The agent that made it (the Chief of Staff); absent when the user did. */
  createdBy?: string;
}

/** A room with what is happening in it now. */
export interface RoomView extends Room {
  /** Agent turns the newest user message has set off, and the most it may. */
  turnsUsed: number;
  turnCap: number;
  /** Members asked here whose turn hasn't started (busy elsewhere, or waiting for a slot). */
  waiting: string[];
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
}

export interface ChangeSummary {
  project: string;
  branch?: string;
  from: string;
  to: string;
  files: ChangedFile[];
  fileCount: number;
  added: number;
  removed: number;
  /**
   * The turn worked in a copy of the project: the card lists everything in
   * the copy so far, and offers Keep / Discard while `Agent.copy.id` matches.
   */
  copy?: CopyRef;
  /** In a copy: files it changed that Keep won't bring over, and why. */
  leftOut?: LeftOut[];
  /** In a copy: why its changes couldn't be saved this turn, in a sentence. */
  warning?: string;
}

/** A file in the copy that Keep leaves behind. */
export interface LeftOut {
  path: string;
  /** `ignored`: git ignores it (an edited `.env`), so it never leaves the copy. */
  why: 'secrets' | 'dependencies' | 'tooLarge' | 'ignored';
}

/** The copy a change card describes. */
export interface CopyRef {
  id: string;
  /** The copy's folder (a linked git worktree), outside the project. */
  path: string;
  branch: string;
}

/** A project-bound agent's open copy of its project. */
export interface TaskCopy extends CopyRef {
  /** The user's own project folder. */
  project: string;
  /** The commit it started from. */
  base: string;
  baseBranch?: string;
  createdAt: number;
  /** The project's dependencies were cloned in. */
  deps: boolean;
  /**
   * The last Keep that couldn't go through, kept on the Mac so every card
   * shows what's in the way. Cleared by the next turn or Keep.
   */
  stuck?: Extract<KeptCopy, { outcome: 'conflict' | 'markers' | 'otherBranch' }>;
}

/** What `agents.keepCopy` did. */
export type KeptCopy =
  /** In the project's `branch` now. */
  | { outcome: 'kept'; files: number; branch: string; leftOut?: LeftOut[] }
  | { outcome: 'nothing'; leftOut?: LeftOut[] }
  /** Overlaps with edits made in the project since: the copy is mid-merge. */
  | { outcome: 'conflict'; files: string[] }
  /** These files still have conflict markers in them: nothing was kept. */
  | { outcome: 'markers'; files: string[] }
  /**
   * The project is on `current`, not the branch the copy was made from
   * (`base`). Nothing was kept; keeping there sends `into: current`.
   */
  | { outcome: 'otherBranch'; current: string; base?: string };

export interface Attachment {
  name: string;
  /** Relative to the agent's home: `attachments/<message id>/<name>`. */
  path: string;
  mime: string;
  size: number;
}

export interface SharedFile extends Attachment {
  messageId: string;
  ts: number;
  from: 'user' | 'agent';
}

export interface NewAgentInput {
  name: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  engine?: AgentEngine;
  model?: string;
  project?: string;
  template?: string;
}

/** A ready-made agent, as `agents.templates` offers it (its briefing stays on the Mac). */
export interface RoleTemplateSummary {
  id: string;
  /** What the picker calls it ("Research assistant"). */
  title: string;
  /** The agent's name unless the user picks another. */
  name: string;
  role: string;
  color: string;
  /** What it can't work without: `mail` is an email app connected on the Mac. */
  needs: 'mail' | null;
}

export interface UpdateAgentInput {
  name?: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  pinned?: boolean;
  hidden?: boolean;
  muted?: boolean;
  engine?: AgentEngine;
  model?: string;
  routineModel?: string;
  project?: string;
  workDirectly?: boolean;
}

/** What `agents.create` / `agents.update` return: the stored agent, no live state. */
export type StoredAgent = Omit<Agent, 'status' | 'home'>;

export interface SearchHit {
  agentId: string;
  agentName: string;
  agentColor: string;
  messageId: string;
  ts: number;
  kind: MessageKind;
  peerName?: string;
  snippet: string;
  /** Said in a room: the hit opens the room. `agent*` is who said it (empty for the user's line). */
  roomId?: string;
  roomName?: string;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  pricedTurns: number;
  durationMs: number;
  /** "When…" routines' model checks: counted apart from turns, their cost included above. Newer Macs only. */
  checks?: number;
  /** Checks that reported a cost. */
  pricedChecks?: number;
}

export interface UsageSummary {
  week: UsageTotals;
  allTime: UsageTotals;
  /** Each routine that ran on its own this week. Newer Macs only. */
  routines?: RoutineUsage[];
}

/** One routine's week, from turns that ran nothing but it. */
export interface RoutineUsage {
  /** The check-in's id. */
  id: string;
  week: UsageTotals;
}

/**
 * One window of an engine's plan (Claude Code's `five_hour` / `seven_day`,
 * Codex's `primary` / `secondary`), exactly as the engine last reported it.
 */
export interface QuotaWindow {
  kind: string;
  /** 0–100; absent when the engine said only that it's used up. */
  usedPercent?: number;
  /** When it resets, epoch ms. */
  resetsAt?: number;
  windowMinutes?: number;
  /** The engine said it's used up. */
  limited: boolean;
  /** When the engine reported it, epoch ms. */
  observedAt: number;
}

/** An engine's plan, only ever as the engine reported it. Never estimated. */
export interface Quota {
  engine: AgentEngine;
  windows: QuotaWindow[];
  /** The plan's name, only when the engine said it (Codex's `planType`). */
  plan?: string;
}

/** The last usage limit a turn on an account hit (`agents::wallet::LimitHit`). */
export interface UsageLimitHit {
  /** When, epoch ms. */
  at: number;
  /** When the engine said it resets, epoch ms; absent when it didn't say. */
  resetsAt?: number;
}

/**
 * One usage account of an engine (`agents::wallet::AccountView`). An
 * engine's accounts come in the order turns try them; the first is this
 * Mac's own sign-in unless the user moved it.
 */
export interface UsageAccount {
  id: string;
  engine: AgentEngine;
  name: string;
  thisMac: boolean;
  signedIn: boolean;
  email?: string;
  limit?: UsageLimitHit;
  /** Out of usage right now. */
  out: boolean;
}

/** How the user wants their limits used (`agents::usage_plan::Mode`). */
export type UsageMode = 'normal' | 'save' | 'use_it_all';

/**
 * What one run has used, from this user's own past runs: an ESTIMATE
 * (`agents::forecast::PerRun`), never a reading. Absent with too little
 * history.
 */
export interface UsageEstimate {
  estimate: true;
  tokens: number;
  low: number;
  high: number;
  runs: number;
  days: number;
}

export interface UsageEngineLine {
  id: AgentEngine;
  label: string;
  installed: boolean;
  signedIn: boolean;
  agents: number;
  nextAccount?: string;
  allOut: boolean;
  perTurn?: UsageEstimate;
}

/** An account with what its engine last reported (`agents::inventory`). */
export interface UsageAccountLine {
  engine: AgentEngine;
  id: string;
  name: string;
  thisMac: boolean;
  signedIn: boolean;
  out: boolean;
  outUntil?: number;
  /** Its engine's next turn runs on it. */
  next: boolean;
  plan?: string;
  /** As last reported and still current; empty: no reading. */
  windows: QuotaWindow[];
  /** Window kinds whose share per token this Mac has learned. */
  learned: string[];
}

/** Other compute detected on this Mac; agents here don't run on it. */
export interface LocalCompute {
  name: string;
  running?: boolean;
  models: string[];
}

/** A window near its reset with capacity left, as reported. */
export interface SpareWindow {
  engine: AgentEngine;
  accountId: string;
  accountName: string;
  next: boolean;
  kind: string;
  windowMinutes?: number;
  usedPercent: number;
  resetsAt: number;
  observedAt: number;
}

/** Work to do when there's spare capacity. */
export interface SpareItem {
  id: string;
  text: string;
  agentId?: string;
  addedBy: string;
  addedAt: number;
  state: 'waiting' | 'started';
  startedAt?: number;
}

export interface UsageAgentLine {
  id: string;
  name: string;
  engine: AgentEngine;
  model?: string;
  isMain: boolean;
  perTurn?: UsageEstimate;
}

export interface UsageRoutineLine {
  agentId: string;
  id: string;
  what: string;
  when: boolean;
  perRun?: UsageEstimate;
}

/** The capacity inventory (`agents_usage_overview`, `agents.usagePlan`). */
export interface UsageInventory {
  mode: UsageMode;
  modeSetAt?: number;
  engines: UsageEngineLine[];
  accounts: UsageAccountLine[];
  local: LocalCompute[];
  spare: SpareWindow[];
  backlog: SpareItem[];
  agents: UsageAgentLine[];
  routines: UsageRoutineLine[];
  now: number;
}

export interface PasteImportAgent {
  name: string;
  role: string;
  isMain: boolean;
  existing: boolean;
  instructionsChars: number;
  memoryLines: number;
  routines: PasteImportRoutine[];
  color: string | null;
  instructions: string;
  memory: string[];
}

export interface PasteImportRoutine {
  when: string;
  what: string;
  schedule?: string;
  refused?: string;
}

export interface ImportRoutineOutcome {
  agent: string;
  when: string;
  what: string;
  detail: string;
}

export interface PasteImportPreview {
  source: string;
  blocks: number;
  agents: PasteImportAgent[];
  problems: string[];
}

export interface ImportSummary {
  created: string[];
  updated: string[];
  skipped: [string, string][];
  routinesSet: ImportRoutineOutcome[];
  routinesRefused: ImportRoutineOutcome[];
}

// Memory: identical to src/lib/agents.ts (`memory::Entry`, `memory::Change`).

export interface MemoryEntry {
  text: string;
  /** The `###` heading it sits under. */
  group?: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  /** The exact lines a delete removed, for Undo. */
  removed?: string;
}

export type MemoryChange =
  | {
      op: 'add';
      text: string;
      group?: string;
      after?: string;
      before?: string;
      raw?: string;
    }
  | { op: 'edit'; index: number; original: string; text: string }
  | { op: 'delete'; index: number; original: string };

/** Mirrors `crate::types::FileDiff` (src/lib/git.ts). */
export interface FileDiff {
  filePath: string;
  isNewFile: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  content: string;
  additions: number;
  deletions: number;
}

/** Must match `MAX_FILES` / `MAX_FILE_BYTES` in agents/attachments.rs. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ============================================================================
// Projects and sessions: structured forms of Remote Access's project tools
// ============================================================================

/** Read off a session's screen by `remote_access/agent_state.rs`. */
export type SessionState = 'working' | 'needs_decision' | 'finished' | 'exited';

/** A numbered-menu prompt on a session's screen, as `agent_state` parsed it. */
export interface SessionQuestion {
  question: string;
  /** What the agent wants to do, when the screen shows it (the command). */
  action?: string;
  /** In screen order; `key` is what `sessions.key` presses to choose it. */
  options: { key: string; label: string; highlighted: boolean }[];
}

export interface SessionSummary {
  /** The backend PTY session id. */
  sessionId: string;
  /** Its number among the project's tabs ("Claude Code 1"). */
  tab: number;
  /** Agent CLI id (`claude`, `codex`, `opencode`); absent for a plain terminal. */
  cli?: string;
  state: SessionState;
  /** The spinner line, while working ("Stewing… (4s)"). */
  activity?: string;
  question?: SessionQuestion;
  lastOutputAt: number;
}

export interface ProjectSummary {
  path: string;
  name: string;
  branch?: string;
  /** Uncommitted changes, as `git status` counts them. */
  dirtyFiles: number;
  /** Agent tabs first; anything waiting on the user first among those. */
  sessions: SessionSummary[];
}

export interface SessionScreen {
  session: SessionSummary;
  /** The rendered screen and scrollback (vt100), plain text. */
  screen: string;
  /** The agent's latest reply, without the input box and spinner lines. */
  reply?: string;
  /**
   * The newest message the Mac typed into this tab (from this phone, an
   * outside assistant or an agent), and when. Absent when it typed none
   * since the app started, or on an older Mac. Never read off the screen:
   * a message typed at the desk isn't here.
   */
  sent?: SessionSent;
}

export interface SessionSent {
  text: string;
  at: number;
  /** One of the user's agents sent it, not the user. */
  byAgent: boolean;
}

// ============================================================================
// The Mac, the connection, and paired devices
// ============================================================================

/** Three-valued on purpose: "we couldn't tell" is never shown as yes or no. */
export type Known = 'yes' | 'no' | 'unknown';

export interface MacStatus {
  /** The Mac's name, as the user sees it in System Settings. */
  name: string;
  appVersion: string;
  /** Mirrors `remote_access::power`: what keeps it awake, and its battery. */
  power: {
    keepAwake: boolean;
    lidClosedMode: Known;
    onBattery: Known;
    batteryPercent?: number;
  };
  claude: {
    installed: boolean;
    /** From the same check onboarding uses (`claude_auth_truth`), cached 60 s. */
    signedIn: Known;
    version?: string;
  };
  /** Every way this Mac can be reached right now (the phone learns new ones from this). */
  routes: Route[];
}

export type RouteKind = 'tailscale' | 'lan';

export interface Route {
  kind: RouteKind;
  /** `https://mac.tailnet.ts.net:47443` or `https://192.168.1.20:47444`. */
  url: string;
  /** LAN only: SHA-256 of the Mac's certificate public key (SPKI), base64url. */
  pin?: string;
}

export type DevicePlatform = 'ios' | 'android';

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  model?: string;
  appVersion: string;
  /** How it was built: the official app, or one built on this Mac (a fork). */
  build: 'official' | 'self';
  pairedAt: number;
  lastSeenAt?: number;
  lastRoute?: RouteKind;
  /** Has a live connection now. */
  connected: boolean;
  /** Free-Apple-ID builds stop opening at this time; reinstall before. Epoch ms. */
  expiresAt?: number;
}

/** Which APNs a token belongs to. TestFlight and the App Store are production. */
export type PushEnvironment = 'production' | 'development';

/**
 * Whether this phone will get pushes, as the Mac sees it (`devices.setPush`).
 * - `on`: the relay has it; pushes arrive while the app isn't in front.
 * - `pending`: saved, but the relay wasn't reachable yet; retried on the next alert.
 * - `off`: push is off on the Mac.
 * - `unavailable`: the Mac's build has no push service.
 * - `self_build`: a self-built app gets no push entitlement from Apple.
 */
export type PushStatus = 'on' | 'pending' | 'off' | 'unavailable' | 'self_build';

/** A notification the Mac decided this device should show (see `Notifier`). */
export interface Alert {
  agentId: string;
  /** The message it's about, so tapping opens the chat there. */
  messageId?: string;
  title: string;
  body: string;
  kind: 'reply' | 'approval' | 'error' | 'check_in';
}

/** What an agent may reach beyond its connections (desktop `AgentReach`). */
export interface AgentReachSettings {
  /** The user took its browser away. */
  browserOff?: boolean;
  /** Sites it was given the browser for on a login card. */
  browserSites?: string[];
  /** Claude Code apps kept from its turns, by name there. */
  blockedApps?: string[];
}
