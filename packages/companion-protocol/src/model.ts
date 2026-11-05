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

export interface AgentsOverview {
  agents: Agent[];
  /** Claude Code is installed (the default engine). */
  engineReady: boolean;
  engines: EngineInfo[];
}

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
}

/**
 * An import over the connector (desktop `agents/review.rs`). On the phone a
 * consent card is Allow / Deny. A review card can't be answered there: it
 * says "Review on your Mac", where each agent's instructions are on screen
 * before Import (the desktop refuses an Allow sent for one).
 */
export interface ConnectorCard {
  kind: 'consent' | 'review';
  talkId: string;
  source: string;
  review?: ImportReview;
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
  clash?: ImportClash;
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
