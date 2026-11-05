/**
 * Agents — types mirroring `src-tauri/src/agents/` and the invoke wrappers.
 *
 * @module lib/agents
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { FileDiff } from './git';
import type { AgentSecret, SecretRequest } from './agentSecrets';
import type { Watch, WatchSource } from '../../packages/companion-protocol/src/model';

export type { Watch, WatchEvent, WatchSource } from '../../packages/companion-protocol/src/model';

/** Avatar colour keys. The CSS maps each to a feature token. */
export const AGENT_COLORS = [
  'white',
  'brown',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

/** Number of avatar shapes; must match `SHAPE_COUNT` in store.rs. */
export const AGENT_SHAPE_COUNT = 14;

export interface AgentStatus {
  state: 'idle' | 'working' | 'waiting';
  activity: string | null;
  since: number | null;
  /** The turn's timeline so far, while it isn't idle; older Macs omit it. */
  work?: TurnWork;
  /** The room the turn in progress answers in (`lib/agentRooms`); absent for its own chat. */
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
  /** One of AGENT_COLORS; typed loosely because the registry is a file. */
  color: string;
  isMain: boolean;
  pinned: boolean;
  hidden: boolean;
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  preview: string | null;
  unread: number;
  /** Approval cards still waiting on the user, including ones the agent paused on. */
  pendingApprovals: number;
  /** What its turns run on; mirrors `engine::Engine`. */
  engine: AgentEngine;
  /** One of its engine's models; null is that engine's default. */
  model: string | null;
  /** What its routines run on (see `routineModelOf`); omitted when automatic. */
  routineModel?: string;
  /** The ready-made agent it was made from (`agentTemplates.ts`), if any. */
  template?: string;
  /** No OS notifications; unread and the Dock badge still count it. */
  muted: boolean;
  /** Omitted by the backend when there are none. */
  checkIns?: CheckIn[];
  /** "Always allow" rules; omitted when there are none. */
  permissions?: PermissionRule[];
  status: AgentStatus;
  /** The agent's home folder; attachment paths are relative to it. */
  home: string;
  /** The newest line in its chat is a failed turn; omitted otherwise. */
  failure?: Failure;
  /** The project it works in (a path from `project_list`); omitted when unbound. */
  project?: string;
  /**
   * Its open copy of that project (`agents/task.rs`): where its turns run
   * until the user keeps or discards the changes. Omitted when none is open.
   */
  copy?: TaskCopy;
  /** "Work directly in the project": no copy, its turns edit the project itself. */
  workDirectly?: boolean;
  /** What its last turn could use; omitted before its first turn. */
  capabilities?: Capabilities;
  /** Secrets it has in the Keychain (names only); omitted when none. */
  secrets?: AgentSecret[];
  /** Moved engines and not run there yet: its next turn starts a new conversation. */
  newEngine?: boolean;
  /** How full its conversation is, as its engine reported it; omitted when it doesn't say. */
  context?: ContextFill;
  /** You're driving its session in a terminal; omitted otherwise. */
  takeover?: AgentTakeover;
}

/** Mirrors `takeover::View`: you're driving the agent's own session by hand. */
export interface AgentTakeover {
  /** When it began (epoch ms). */
  since: number;
  /** The backend PTY session the terminal shows. */
  ptySession: string;
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

/** Mirrors `failure::Failure`: what kind of failure a turn ended in. */
export interface Failure {
  kind: 'usage_limit' | 'signed_out' | 'other';
  /** When the usage limit resets (epoch ms), only when Claude Code said so. */
  resetsAt?: number;
}

/** How a routine repeats; mirrors `schedule::Repeat`. Days are 0 = Sunday. */
export type Repeat =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number };

/** A check-in (one-time) or routine (repeats); mirrors `schedule::CheckIn`. */
export interface CheckIn {
  id: string;
  note: string;
  repeat?: Repeat;
  /** When it next fires, epoch ms. */
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

/** On a `check_in` chat line: when it was due and whether it ran late. */
export interface CheckInMark {
  dueAt: number;
  late: boolean;
  repeats: boolean;
  /** Run now, by the user; its schedule didn't move. */
  manual?: boolean;
  /** A "When…" routine fired: what it found ("2 new GitHub mentions"). */
  found?: string;
}

export interface SchedulePreview {
  nextAt: number;
  /** How it repeats; null for a one-time check-in. */
  repeat: Repeat | null;
}

export type AgentEngine = 'claude' | 'codex';

/** Mirrors `engine::ModelChoice`: a model as the engine lists it. */
export interface EngineModel {
  value: string;
  label: string;
}

/** A model as the UI offers it. */
export interface ModelChoice extends EngineModel {
  /** What a person picks by: "Most capable", "Balanced", "Fastest". */
  label: string;
  /** The engine's own name for it, said small beside the label: "Opus". */
  detail?: string;
}

/** Mirrors `engine::EngineInfo`: an engine an agent can run on, as found on this Mac. */
export interface EngineInfo {
  id: AgentEngine;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /**
   * Its turns can stop and ask (an Allow / Deny card) before going past what
   * it may do alone. Claude Code always; Codex only over its app-server.
   */
  asks?: boolean;
  /** The engine's own models, without Default. */
  models: EngineModel[];
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
  /** Claude Code is installed. Per-agent readiness is `engineIsReady` over `engines`. */
  engineReady: boolean;
  engines: EngineInfo[];
  /** What new agents start on. Optional for the phone's older Macs (see the protocol). */
  defaults?: NewAgentDefaults;
}

export type MessageKind =
  | 'user'
  | 'agent'
  | 'sent_to_agent'
  | 'from_agent'
  | 'approval'
  | 'error'
  | 'check_in'
  /** A quiet line: an automatically allowed call, an interruption, what the Chief did. */
  | 'note'
  /** Files a project-bound agent's turn changed (`changes`). */
  | 'changes'
  /** The agent worked in a project's session (`session`). */
  | 'session';

/** Mirrors `sessions::SessionMark`: what an agent did in a project's session. */
export interface SessionMark {
  /** The project's path. */
  project: string;
  event: 'started' | 'sent' | 'reply' | 'screenshot';
  /** The tab's PTY session id; absent on a screenshot. */
  sessionId?: string;
  /** Its number among the project's tabs then. */
  tab?: number;
  /** The tab's agent CLI id (`claude`, `codex`, …). */
  cli?: string;
}

/** Mirrors `capabilities::Capabilities`, from the agent's last turn. */
export interface Capabilities {
  seenAt: number;
  lines: { what: string; detail: string }[];
}

/** What "Always allow" covers; mirrors `permissions::Scope`. */
export interface PermissionScope {
  kind: 'command_prefix' | 'command' | 'domain' | 'tool';
  value: string;
  /** The value in words: "npm test", "example.com", "Send an email · Gmail". */
  label: string;
}

export interface PermissionRule extends PermissionScope {
  id: string;
  createdAt: number;
}

/** What a rule lets through, before its value: "Commands starting with". A tool's label says it all. */
export const SCOPE_KIND_LABEL: Record<PermissionScope['kind'], string> = {
  command_prefix: 'Commands starting with',
  command: 'Exactly',
  domain: 'Web pages on',
  tool: '',
};

/** The tooltip on "Always allow": exactly what will stop asking. */
export function describeScope(scope: PermissionScope, agentName: string): string {
  const what =
    scope.kind === 'command_prefix'
      ? `Any command starting with “${scope.label}”`
      : scope.kind === 'command'
        ? `Exactly “${scope.label}”`
        : scope.kind === 'domain'
          ? `Opening pages on ${scope.label}`
          : `“${scope.label}”`;
  const chained = scope.kind.startsWith('command')
    ? ' Commands chained with &&, ; or | still ask.'
    : '';
  return `${what} runs for ${agentName} without asking.${chained} Revoke it in Edit agent → Permissions.`;
}

export interface AgentRef {
  id: string;
  name: string;
}

export interface Approval {
  requestId: string;
  title: string;
  detail: string;
  /** A plain sentence the card leads with when `detail` is raw (a push); detail then sits behind Details. */
  summary?: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  tool?: string;
  input?: unknown;
  /** What "Always allow" would cover; only on cards that may offer it. */
  always?: PermissionScope;
  /** Allowed by an "Always allow" rule rather than once. */
  alwaysAllowed?: boolean;
  /** What you told the agent when you declined. */
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
 * What answering a session's question means, as the backend decides it: the
 * option picked, else the card's Allow or Deny option. Lets a card resolve in
 * place before the registry catches up.
 */
export function promptAnswer(
  prompt: SessionPrompt,
  allow: boolean,
  choice?: number
): { status: 'allowed' | 'denied'; choice: string } {
  const picked =
    choice !== undefined && prompt.options[choice]
      ? prompt.options[choice]
      : prompt.options.find((o) => o.role === (allow ? 'allow' : 'deny'));
  if (!picked) return { status: 'denied', choice: 'Cancelled' };
  return { status: picked.role === 'deny' ? 'denied' : 'allowed', choice: picked.label };
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

export interface AgentMessage {
  id: string;
  agentId: string;
  ts: number;
  kind: MessageKind;
  text: string;
  peer?: AgentRef;
  approval?: Approval;
  /** Files sent with a user message. */
  attachments?: Attachment[];
  checkIn?: CheckInMark;
  /** A reply cut off by Stop: what had streamed by then. */
  stopped?: boolean;
  /** Agents you @mentioned in this message, as they were named then. */
  mentions?: AgentRef[];
  /** On an `error` line: what kind of failure. Absent on lines written before. */
  failure?: Failure;
  /** On a `changes` line: what the turn changed in the project. */
  changes?: ChangeSummary;
  /** On a `session` line. */
  session?: SessionMark;
  /** On a user message sent from the phone: the `clientId` of its send (docs/mobile.md). */
  clientId?: string;
  /** What the turn that ended on this message did; older Macs omit it. */
  work?: TurnWork;
  /** On a `note`: the conversation started fresh here; drawn as a divider. */
  fresh?: boolean;
  /**
   * A result card (`share_result`, `agents/results.rs`): on an `agent`
   * message of its own, or on the turn's `changes` card.
   */
  result?: ResultCard;
  /** On a user message: "Ask for changes" on this result. */
  revises?: ResultRef;
  /** On a `note` (an `error` in older logs): a take-over's terminal closed by itself, its last lines after a blank line; not a turn's failure, so no Retry. */
  takeover?: boolean;
  /**
   * Said in a room: that room's id. A member's line is also in the room's
   * thread; in the agent's own chat it folds into one "In <room>" line. A
   * line only the room has (yours, a room note) has an empty `agentId`.
   */
  room?: string;
}

/** Mirrors `project::ChangedFile`: line counts are absent for a binary file. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added?: number;
  removed?: number;
}

/** Mirrors `project::ChangeSummary`, read from git when the turn ended. */
export interface ChangeSummary {
  project: string;
  /** Absent when HEAD was detached. */
  branch?: string;
  from: string;
  to: string;
  /** At most 50; `fileCount` counts them all. */
  files: ChangedFile[];
  fileCount: number;
  added: number;
  removed: number;
  /**
   * The turn worked in a copy of the project: the files are everything in
   * the copy so far (what Keep would bring over), not only this turn's.
   */
  copy?: CopyRef;
  /** In a copy: files it changed that Keep won't bring over, and why. */
  leftOut?: LeftOut[];
  /** In a copy: why its changes couldn't be saved this turn, in a sentence. */
  warning?: string;
}

/** Mirrors `task::LeftOut`: a file in the copy that Keep leaves behind. */
export interface LeftOut {
  path: string;
  /** `ignored`: git ignores it (an edited `.env`), so it never leaves the copy. */
  why: 'secrets' | 'dependencies' | 'tooLarge' | 'ignored';
}

/**
 * The card's line for what Keep won't bring over (mirrors `task::left_out_line`):
 * "Not included: .env.local (looks like secrets) · changed .env — not included (git ignores it)".
 */
export function leftOutLine(items: LeftOut[] | undefined): string | null {
  if (!items?.length) return null;
  const why = {
    secrets: 'looks like secrets',
    dependencies: 'dependencies',
    tooLarge: 'over 5 MB',
  };
  const parts: string[] = [];
  const skipped = items.filter((l) => l.why !== 'ignored').slice(0, 5);
  if (skipped.length) {
    parts.push(
      `Not included: ${skipped.map((l) => `${l.path} (${why[l.why as keyof typeof why]})`).join(', ')}`
    );
  }
  const ignored = items.filter((l) => l.why === 'ignored').slice(0, 5);
  if (ignored.length) {
    parts.push(`changed ${ignored.map((l) => l.path).join(', ')} — not included (git ignores it)`);
  }
  return parts.join(' · ');
}

/** Mirrors `task::CopyRef`: the copy a change card describes. */
export interface CopyRef {
  id: string;
  /** The copy's folder: a git worktree outside the project. */
  path: string;
  branch: string;
}

/** Mirrors `task::TaskCopy`: an agent's open copy of its project. */
export interface TaskCopy extends CopyRef {
  /** The user's own project folder. */
  project: string;
  /** The commit it started from. */
  base: string;
  /** The branch the project was on when the copy was made. */
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

/** Mirrors `task::Kept`: what "Keep changes" did. */
export type KeptCopy =
  /** In the project's `branch` now. */
  | { outcome: 'kept'; files: number; branch: string; leftOut?: LeftOut[] }
  | { outcome: 'nothing'; leftOut?: LeftOut[] }
  /** Some changes overlap with edits made in the project since; resolved in the copy. */
  | { outcome: 'conflict'; files: string[] }
  /** These files still have conflict markers in them: nothing was kept. */
  | { outcome: 'markers'; files: string[] }
  /**
   * The project is on `current`, not the branch the copy was made from
   * (`base`; absent when it was made from no branch). Nothing was kept;
   * keeping there takes `keepCopy(…, current)`.
   */
  | { outcome: 'otherBranch'; current: string; base?: string };

/** A file sent with a message, as kept in the agent's home. */
export interface Attachment {
  name: string;
  /** Relative to the agent's home: `attachments/<message id>/<name>`. */
  path: string;
  mime: string;
  size: number;
}

/** A file about to be sent: one on disk, or bytes the composer holds (a paste). */
export interface OutgoingAttachment {
  name: string;
  path?: string;
  /** Base64. */
  data?: string;
}

/** What the backend reports for a file before it is attached. */
export interface FileInfo {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** Must match `MAX_FILES` / `MAX_FILE_BYTES` in agents/attachments.rs. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const isImageMime = (mime: string) => /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime);

/** "840 KB", "3.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * A local file as an `<img>` source. Through the asset protocol in the app;
 * under the UI harness the fixtures are served over HTTP, so the path already
 * is a URL (feature-detected, as in `fidelityImageUrl`).
 */
export function localFileUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export const attachmentUrl = (home: string, attachment: Attachment) =>
  localFileUrl(`${home}/${attachment.path}`);

export interface NewAgentInput {
  name: string;
  shape?: number;
  color?: string;
  role?: string;
  instructions?: string;
  engine?: AgentEngine;
  model?: string;
  /** A project path from `list_projects`. */
  project?: string;
  /** The ready-made agent it starts from; the instructions sent are what was shown. */
  template?: string;
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
  /** Switches from its next turn; the model resets unless one is given too. */
  engine?: AgentEngine;
  /** One of its engine's models, or '' for that engine's default. */
  model?: string;
  /** '' automatic, 'same' (its own model), or one of its engine's models. */
  routineModel?: string;
  /** A project path from `list_projects`, or '' to unbind it. */
  project?: string;
  /** Work directly in the project instead of in a copy of it. */
  workDirectly?: boolean;
}

/** The model choice that passes no model: whatever the engine itself defaults to. */
export const ENGINE_DEFAULT_LABEL = 'Engine’s default';

/**
 * The models an agent can run on: Claude Code's own `--model` aliases, which
 * always mean the current model of that family. Must match `MODELS` in store.rs.
 */
export const AGENT_MODELS: readonly ModelChoice[] = [
  { value: '', label: ENGINE_DEFAULT_LABEL },
  { value: 'opus', label: 'Most capable', detail: 'Opus' },
  { value: 'sonnet', label: 'Balanced', detail: 'Sonnet' },
  { value: 'haiku', label: 'Fastest', detail: 'Haiku' },
];

export const ENGINE_LABEL: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Engine's default first, then the engine's own models (Claude Code's aliases until the overview says). */
export function modelChoices(engine: AgentEngine, engines: EngineInfo[]): readonly ModelChoice[] {
  const listed = engines.find((e) => e.id === engine)?.models;
  if (engine === 'claude' && !listed?.length) return AGENT_MODELS;
  // Claude Code's aliases are said by what they're for, the alias beside it.
  const plain = (m: ModelChoice): ModelChoice => {
    if (engine !== 'claude') return m;
    const known = AGENT_MODELS.find((k) => k.value === m.value);
    return known ? { ...known, detail: m.label } : m;
  };
  return [AGENT_MODELS[0], ...(listed ?? []).map(plain)];
}

export function modelLabel(
  model: string | null,
  choices: readonly ModelChoice[] = AGENT_MODELS
): string {
  return choices.find((m) => m.value === (model ?? ''))?.label ?? model ?? ENGINE_DEFAULT_LABEL;
}

/**
 * Whether an agent on this engine can be sent a message: its engine is
 * installed and signed in, by that engine's own check (`engines`). Before the
 * engines have loaded, Claude Code counts as `claudeInstalled` says.
 */
export function engineIsReady(
  engine: AgentEngine,
  engines: EngineInfo[],
  claudeInstalled: boolean
): boolean {
  const info = engines.find((e) => e.id === engine);
  if (info) return info.installed && info.signedIn;
  return engine === 'claude' && claudeInstalled;
}

/** No engine Agents runs on is installed at all (Opencode-, Cursor- or "Other"-only). */
export function noEngineInstalled(engines: EngineInfo[]): boolean {
  return engines.length > 0 && engines.every((e) => !e.installed);
}

/**
 * The engine a new agent goes on when nobody picked one: Claude Code when
 * it's ready, else the first that is, else Claude Code. Mirrors
 * `engine::default_for`.
 */
export function defaultEngine(engines: EngineInfo[]): AgentEngine {
  const ready = engines.filter((e) => engineUnavailable(e) === null);
  if (ready.some((e) => e.id === 'claude')) return 'claude';
  return ready[0]?.id ?? 'claude';
}

/**
 * Where a new agent starts when nobody picked: the user's default
 * (`defaults.startsOn`, already checked against the engines on the Mac), or
 * before the overview says, the rule (`defaultEngine`).
 */
export function newAgentEngine(
  defaults: NewAgentDefaults | null,
  engines: EngineInfo[]
): AgentEngine {
  return defaults?.startsOn ?? defaultEngine(engines);
}

/**
 * The model a new agent on `engine` starts on: the default chosen for that
 * engine while it's still one of `choices`, else the engine's own ('').
 */
export function newAgentModel(
  defaults: NewAgentDefaults | null,
  engine: AgentEngine,
  choices: readonly ModelChoice[]
): string {
  const chosen = defaults?.models[engine] ?? '';
  return choices.some((m) => m.value === chosen) ? chosen : '';
}

/**
 * The line under "New agents start on" when the chosen engine can't take new
 * agents and they start on another for now (`startsOn`), or null when they
 * start where chosen. `verb` is how the control is used: "Pick" on the desk,
 * "Tap" on the phone (mobile/src/lib/newAgentDefaults.ts says the same).
 */
export function startsOnFallback(defaults: NewAgentDefaults, verb: 'Pick' | 'Tap'): string | null {
  const { engine, startsOn } = defaults;
  if (!engine || engine === startsOn) return null;
  const on = ENGINE_LABEL[startsOn];
  return `${ENGINE_LABEL[engine]} isn’t ready, so new agents start on ${on} for now. ${verb} ${on} to keep them there.`;
}

/** What an engine needs before it can take an agent, or null when it can. */
export function engineUnavailable(info: EngineInfo): 'install' | 'sign-in' | null {
  if (!info.installed) return 'install';
  if (!info.signedIn) return 'sign-in';
  return null;
}

/**
 * What stands between an agent on this engine and your computer, as each
 * engine actually enforces it (see "Approvals" in docs/agents.md). Never more:
 * the app's own tools and anything you've already allowed don't ask, and
 * apps connected to Codex itself run outside its limits.
 */
export function engineProtections(engine: AgentEngine, info?: EngineInfo): string {
  if (engine === 'claude') {
    return "It can edit your projects and use this app's tools on its own. Anything else asks you first, unless you've already allowed it.";
  }
  const limits =
    "Its commands go ahead without asking, but can only change files in your projects and its own folder, and can't reach the internet.";
  const apps = "Apps you've connected to Codex aren't limited by this.";
  if (info?.asks === true) return `${limits} Going further asks you first. ${apps}`;
  const cantAsk = engineCantAsk(engine, info ? [info] : []);
  if (cantAsk) return `${limits} ${cantAsk} ${apps}`;
  // Not known (not installed, or a computer that doesn't say): claim nothing more.
  return `${limits} ${apps}`;
}

/**
 * Said wherever an agent on this engine is on show (the editor, its chat,
 * the phone's agent sheet) when its turns can't stop to ask: anything that
 * would need your OK is refused instead. Null when it can ask, or when that
 * isn't known. Must match `engineCantAsk` in mobile/src/lib/agents.ts.
 */
export function engineCantAsk(engine: AgentEngine, engines: EngineInfo[]): string | null {
  const info = engines.find((e) => e.id === engine);
  if (!info?.installed || info.asks !== false) return null;
  return `${info.label} can't stop to ask you here, so anything that needs your OK is refused. Updating ${info.label} fixes this.`;
}

export interface RoutineModelChoice extends ModelChoice {
  hint: string | null;
}

/**
 * Choices for what an agent's routines run on. Must match `routine_model` in
 * store.rs. Haiku is Claude Code's: a Codex agent's routines run on its own
 * model unless one of Codex's is picked (which is cheaper isn't something
 * Codex says, so nothing is picked for the user).
 */
export function routineModelChoices(
  engine: AgentEngine,
  choices: readonly ModelChoice[]
): RoutineModelChoice[] {
  const models = choices.filter((m) => m.value).map((m) => ({ ...m, hint: null }));
  if (engine === 'codex') {
    return [{ value: '', label: 'Same as its chats', hint: null }, ...models];
  }
  return [
    { value: '', label: 'Automatic', hint: 'Fastest (Haiku) unless the agent has its own model' },
    { value: 'same', label: 'Same as its chats', hint: null },
    ...models,
  ];
}

/** The model a routine wakes the agent on, as `Agent::routine_model` resolves it. */
export function routineModelOf(
  agent: Pick<Agent, 'engine' | 'model' | 'routineModel'>
): string | null {
  const setting = agent.routineModel ?? '';
  if (setting === '' && agent.engine !== 'codex') return agent.model ?? 'haiku';
  if (setting === '' || setting === 'same') return agent.model;
  return setting;
}

export interface SearchHit {
  agentId: string;
  agentName: string;
  agentColor: string;
  messageId: string;
  ts: number;
  kind: MessageKind;
  peerName?: string;
  /** Text around the first match, on one line, with … where cut. */
  snippet: string;
  /** Said in a room: opens the room. `agentId` is then who said it (empty: you). */
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
  /** Turns that reported a cost; costUsd is complete only when this equals turns. */
  pricedTurns: number;
  durationMs: number;
  /** "When…" routines' model checks, counted apart from turns (cost included above). */
  checks?: number;
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

export const AGENT_EVENTS = {
  message: 'agents://message',
  status: 'agents://status',
  registry: 'agents://registry',
  /** A reply being written: `{ agentId, id, text }`, the text so far. */
  draft: 'agents://draft',
  /** An engine reported its plan's limits; read `agents_quota` again. */
  quota: 'agents://quota',
  /** A notification was clicked; payload is the agent id to open. */
  open: 'agents://open',
  /** The import over the connector changed: an `ImportGate`. */
  importTalk: 'agents://import-talk',
  /** How far a copy from the other app has got: `OtherAppProgress`. */
  importProgress: 'agents://import-progress',
} as const;

export const getAgentsOverview = () => invoke<AgentsOverview>('agents_overview');
/**
 * The agents bound to a project folder, straight from the registry: unlike
 * the overview, this creates no Chief of Staff and probes no engine.
 */
export const getAgentsWithProjects = () => invoke<Agent[]>('agents_with_projects');
/**
 * The newest `limit` lines, oldest first. `before`: only lines older than that
 * one (the next page up). `through`: reach back at least to that line.
 */
export const getAgentMessages = (
  agentId: string,
  limit?: number,
  { before, through }: { before?: string; through?: string } = {}
) => invoke<AgentMessage[]>('agents_messages', { agentId, limit, before, through });
export const sendAgentMessage = (
  agentId: string,
  text: string,
  attachments: OutgoingAttachment[] = [],
  mentions: string[] = [],
  /** "Ask for changes": the id of the result this message revises. */
  revises?: string
) =>
  invoke<AgentMessage>('agents_send', {
    agentId,
    text,
    attachments: attachments.length ? attachments : undefined,
    mentions: mentions.length ? mentions : undefined,
    revises,
  });
export const inspectFiles = (paths: string[]) =>
  invoke<FileInfo[]>('agents_inspect_files', { paths });
/** Open an attachment in its default app, or with `reveal`, show it in Finder. */
/** What was done: off the open allowlist, a file is only shown in Finder. */
export const openAttachment = (agentId: string, path: string, reveal = false) =>
  invoke<'open' | 'reveal'>('agents_open_attachment', { agentId, path, reveal });

/** The toast when Open could only show the file in Finder. */
export const REVEALED_INSTEAD = 'Shown in Finder — this kind of file isn’t opened directly';

/** One row of a conversation's Files list; mirrors `files::SharedFile`. */
export interface SharedFile extends Attachment {
  messageId: string;
  ts: number;
  from: 'user' | 'agent';
}

/** Everything shared in a conversation, both ways, newest first. */
export const getAgentFiles = (agentId: string) => invoke<SharedFile[]>('agents_files', { agentId });

/**
 * A path from an agent's reply. Documents, images and text open in their default app;
 * anything else is only shown in Finder; paths outside the agent's folder, the
 * user's projects and its copy are refused. Resolves to what was done.
 */
export const openLocalPath = (agentId: string, path: string, reveal = false) =>
  invoke<'open' | 'reveal'>('agents_open_path', { agentId, path, reveal });

/**
 * The local path a link in agent prose points at, or null for a web link.
 * `~/x`, `/x`, `file:///x` and a bare relative `report.md` (relative to the
 * agent's folder) all count; anything with a scheme other than file: doesn't.
 */
export function localPathFromHref(href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  if (/^file:/i.test(href)) href = href.replace(/^file:(\/\/)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * Where a path written out in prose starts: `~/` or one of the roots people
 * actually keep files under. Kept narrow on purpose: `/careers` in a reply is
 * a URL route, not a file, and "and/or" is not a path.
 */
const PATH_ROOT = /(?:~|\/(?:Users|Volumes|private|tmp|var|opt|Applications|Library))\//.source;
const PATH_BODY = /[^\s<>()[\]`'"]*[^\s<>()[\]`'".,;:!?]/.source;

/** A path anywhere in running text. */
export const PROSE_PATH = new RegExp(PATH_ROOT + PATH_BODY);

/** Inline code that is nothing but a path. */
const CODE_PATH = new RegExp(`^${PATH_ROOT}[^\\n<>\`"]+$`);
export const isCodePath = (text: string) => CODE_PATH.test(text.trim());

export type FilesFilter = 'all' | 'user' | 'agent';

export const filterFiles = (files: SharedFile[], filter: FilesFilter) =>
  filter === 'all' ? files : files.filter((f) => f.from === filter);

/**
 * Change what new agents start on. Refused, with nothing saved, for an engine
 * that isn't installed and signed in or a model its engine doesn't offer. The
 * overview carries the result, so the store picks it up on its own.
 */
export const setNewAgentDefaults = (change: NewAgentDefaultsChange) =>
  invoke<NewAgentDefaults>('agents_set_defaults', { change });
export const createAgent = (input: NewAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_create', { input });
export const updateAgent = (agentId: string, input: UpdateAgentInput) =>
  invoke<Omit<Agent, 'status' | 'home'>>('agents_update', { agentId, input });
export const getAgentInstructions = (agentId: string) =>
  invoke<string>('agents_instructions', { agentId });
/** One file of a change card, as this turn changed it. */
export const getChangeDiff = (agentId: string, messageId: string, path: string) =>
  invoke<FileDiff>('agents_change_diff', { agentId, messageId, path });
/**
 * "Keep changes": the agent's copy of its project, merged into the branch it
 * was made from. `into` confirms the project's current branch by name, after
 * an `otherBranch` answer.
 */
export const keepCopy = (agentId: string, copyId: string, into?: string) =>
  invoke<KeptCopy>('agents_copy_keep', { agentId, copyId, ...(into ? { into } : {}) });
/** "Discard": the agent's copy of its project and everything in it. */
export const discardCopy = (agentId: string, copyId: string) =>
  invoke<void>('agents_copy_discard', { agentId, copyId });
export const deleteAgent = (agentId: string) => invoke<void>('agents_delete', { agentId });
export const stopAgent = (agentId: string) => invoke<boolean>('agents_stop', { agentId });
/** How many agents are mid-turn (running or waiting for a slot). */
export const agentsBusy = () => invoke<number>('agents_busy');
export const answerApproval = (
  agentId: string,
  requestId: string,
  allow: boolean,
  always = false,
  note?: string,
  /** On a session's question: the option picked (an index into its options). */
  choice?: number
) =>
  invoke<void>('agents_answer_approval', {
    agentId,
    requestId,
    allow,
    always: always || undefined,
    note: note?.trim() || undefined,
    choice,
  });
/** Stop the turn in progress so what's queued sends now. */
export const interruptAgent = (agentId: string) => invoke<boolean>('agents_interrupt', { agentId });
export const revokePermission = (agentId: string, ruleId: string) =>
  invoke<void>('agents_revoke_permission', { agentId, ruleId });
export const focusAgent = (agentId: string | null) => invoke<void>('agents_focus', { agentId });
export const markAgentUnread = (agentId: string) => invoke<void>('agents_mark_unread', { agentId });
/** A new conversation from its next message: instructions and memory carry over, the chat stays. */
export const startAgentFresh = (agentId: string) =>
  invoke<Agent>('agents_start_fresh', { agentId });

/** Whether its next message would continue a conversation (one there is to leave). */
export const canStartFresh = (agent: Pick<Agent, 'sessionId' | 'newEngine'>) =>
  Boolean(agent.sessionId || agent.newEngine);

/**
 * Step into the agent's own session in a terminal (`agents::takeover`). It
 * pauses until handed back. `stopFirst` stops a turn in progress first, as
 * Stop does; without it a working agent is refused.
 */
export const takeOverAgent = (agentId: string, cols: number, rows: number, stopFirst = false) =>
  invoke<AgentTakeover>('agents_take_over', {
    agentId,
    cols: Math.max(2, Math.round(cols)),
    rows: Math.max(2, Math.round(rows)),
    stopFirst: stopFirst || undefined,
  });
/** Mirrors `takeover::HandBack`. `busy`: the terminal is printing, so ask, then `force`. */
export type HandBackResult = 'handedBack' | 'notDriving' | 'busy';

/** End the terminal and give the session back. Without `force`, refused while it's printing. */
export const handBackAgent = (agentId: string, force = false) =>
  invoke<HandBackResult>('agents_hand_back', { agentId, force: force || undefined });

/** "Claude Code will ask…": the one thing to know before the terminal opens. */
export const TRUST_HINT =
  'Claude Code will ask whether to trust this folder — choose “Yes, proceed”. Choosing No hands it back.';

/** What driving it means for edits, said once, on the banner. */
export function takeoverPolicy(takeover: AgentTakeover, name: string): string {
  const edits = `Edits in its projects are accepted automatically while you drive, as they are for ${name}`;
  return takeover.cli === 'claude-code' ? `${edits}. Shift-Tab changes it.` : `${edits}.`;
}

/** There is a session to step into: it has had a conversation on this engine. */
export const canTakeOver = (agent: Pick<Agent, 'sessionId' | 'newEngine'>) =>
  Boolean(agent.sessionId) && !agent.newEngine;

/** Where the person driving it is: "in a terminal", or "in acme-site". */
export function takeoverWhere(takeover: AgentTakeover, projectName?: string): string {
  if (!takeover.project) return 'in a terminal';
  const name =
    projectName ?? takeover.project.split(/[\\/]/).filter(Boolean).pop() ?? 'its project';
  return `in ${name}`;
}

/** From this full, the chat suggests starting fresh. */
export const CONTEXT_SUGGEST_AT = 85;

/** How full its conversation is, 0-100, or null when its engine didn't say. */
export function contextPercent(agent: Pick<Agent, 'context'>): number | null {
  const fill = agent.context;
  if (!fill || fill.window <= 0) return null;
  return Math.min(100, Math.round((fill.used / fill.window) * 100));
}
/** The one message that asks the other assistant to talk to the Chief over the connector. */
export const getImportPrompt = () => invoke<string>('agents_import_prompt');

/* ------------------------------------- import as a conversation (connector) */

/** An import with another assistant over the connector (`agents/connector.rs`). */
export interface ImportTalk {
  id: string;
  /** The other assistant, as it named itself ("Grok"). */
  source: string;
  chiefId: string;
  /**
   * `awaiting_consent`: the card asking you is up. `interviewing`: the sealed
   * interview is going. `playback`: the plan is played back to you, asking
   * what's missing. `review`: the staged agents wait on your card. The rest
   * are how it ended.
   */
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
  /** Agents staged for your review so far (nothing is created yet). */
  staged: string[];
  /** Agents you imported from the review. */
  imported: string[];
  /** The interview is writing its answer. */
  busy: boolean;
  /** Past conversations received so far, across agents (`import_history`). */
  conversations?: number;
  /** Times the plan has been played back to you. */
  playbacks?: number;
}

/** Whether an import may begin (you pressed Start), and the one going on. */
export interface ImportGate {
  armed: boolean;
  talk: ImportTalk | null;
}

/** An import that is still going (not ended one way or another). */
export const talkIsLive = (t: ImportTalk | null | undefined): t is ImportTalk =>
  !!t &&
  (t.state === 'awaiting_consent' ||
    t.state === 'interviewing' ||
    t.state === 'playback' ||
    t.state === 'review');

export const getImportTalk = () => invoke<ImportGate>('agents_import_talk');
/** Start: one import over the connector may begin (it still asks on a card first). */
export const armImportTalk = () => invoke<ImportGate>('agents_import_talk_arm');
export const stopImportTalk = () => invoke<boolean>('agents_import_talk_stop');

/** An import connector card, carried on an approval (`agents/review.rs`). */
export interface ConnectorCard {
  kind: 'consent' | 'playback' | 'review';
  talkId: string;
  source: string;
  review?: ImportReview;
  /** Playback only: the plan, agent by agent, in plain words (`agents/harvest.rs`). */
  playback?: PlaybackAgent[];
}

/** One agent's plan as the Chief plays it back, in the first person. */
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
  /** Some were left out: a limit was reached. */
  capped?: boolean;
}

/**
 * Answer the plan's playback: nothing (`addition` empty) brings up the review;
 * what's missing goes back to the interview, which plays the plan back again.
 */
export const answerImportPlayback = (agentId: string, requestId: string, addition?: string) =>
  invoke<void>('agents_import_playback_answer', {
    agentId,
    requestId,
    addition: addition?.trim() ? addition : null,
  });

/** What the other assistant proposed, staged for you. Nothing exists until you import. */
export interface ImportReview {
  proposals: ImportProposal[];
  /** What its managing agent knew, offered as notes for your Chief. Off unless ticked. */
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
  /** What it watches for and does then. Not set up here by itself: it lands in memory. */
  watches?: { when: string; what: string }[];
  /** Apps and connectors it used there. */
  apps?: { name: string; purpose: string }[];
  /** How you like things done, one per line. */
  preferences?: string;
  /** Standing context: people, projects, accounts by name. */
  context?: string;
  /** Past conversations that arrived for it. */
  history?: ImportHistoryCount;
  /** An agent here already has this name (or one that looks like it): what it is now. */
  clash?: ImportClash;
}

/** The agent here a proposal's name is taken by, with everything Replace would change. */
export interface ImportClash {
  agentId: string;
  /** Its name here: it may only look like the proposal's ("Ѕite" with a Cyrillic Ѕ). */
  name?: string;
  role: string;
  instructions: string;
  /** Its saved logins, by name: removed on Replace unless you keep them. */
  logins?: string[];
  /** The project it's bound to (a path): unbound on Replace. */
  project?: string;
  /** Routines that would run: paused on Replace. */
  activeRoutines?: number;
  /** Its "Always allow" rules: removed on Replace. */
  rules?: number;
  /** It has a conversation going: Replace starts it fresh, memory kept. */
  conversation?: boolean;
}

/** What you kept on the review card. */
export interface ImportPicks {
  agents: {
    key: string;
    replace: boolean;
    /** Replace only: keep the replaced agent's saved logins. Off unless ticked. */
    keepLogins?: boolean;
    /** Replace only: the agent as the card showed it; Import refuses if it changed since. */
    seen?: ImportClash;
  }[];
  chiefNotes: boolean;
}

export interface ImportApplied {
  agents: string[];
  replaced: string[];
  skipped: [string, string][];
  chiefNotes: boolean;
  routinesRefused: string[];
}

export const applyImportReview = (agentId: string, requestId: string, picks: ImportPicks) =>
  invoke<ImportApplied>('agents_import_review_apply', { agentId, requestId, picks });

/** A review card's agents with each clash read again against the agents here now. */
export const currentImportReview = (agentId: string, requestId: string) =>
  invoke<ImportReview>('agents_import_review_current', { agentId, requestId });

/** The peer id prefix of a line in an import conversation. */
export const CONNECTOR_PEER = 'connector:';
/** A line of an import conversation (the other assistant's, or to it), not one of your agents. */
export const isConnectorLine = (m: Pick<AgentMessage, 'kind' | 'peer'>) =>
  (m.kind === 'from_agent' || m.kind === 'sent_to_agent') &&
  !!m.peer?.id.startsWith(CONNECTOR_PEER);

/**
 * An import conversation's line, as plain text with its web links found:
 * nothing in it is read as HTML or markdown (it comes from the internet,
 * through an assistant that can be prompt-injected), and only `http(s)://`
 * becomes a link. Trailing punctuation stays text ("see https://x.ai.").
 */
export function connectorTextParts(text: string): ({ text: string } | { url: string })[] {
  const parts: ({ text: string } | { url: string })[] = [];
  const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, '');
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ url });
    last = at + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * "Finance (from Grok)": the name a clashing agent comes in under unless
 * you choose Replace (`review::unique_name`; the backend picks the final one).
 */
export const copyName = (name: string, source: string) =>
  `${name.slice(0, 20)} (from ${source.slice(0, 14)})`;

/** One agent a pasted reply would import (see `agents/paste.rs`). */
export interface PasteImportAgent {
  name: string;
  role: string;
  isMain: boolean;
  /** An agent with this name already exists and will be updated. */
  existing: boolean;
  instructionsChars: number;
  memoryLines: number;
  routines: PasteImportRoutine[];
  /** The badge colour it has or will be given here; null only before a Chief of Staff exists. */
  color: string | null;
  /** What came across, word for word. */
  instructions: string;
  memory: string[];
}

/**
 * One routine in a pasted reply: what it becomes (`schedule`), or why it
 * won't be set (`refused`). A refused one doesn't block the import.
 */
export interface PasteImportRoutine {
  when: string;
  what: string;
  schedule?: string;
  refused?: string;
}

/** A routine an import set or refused. `detail` is what it became, or why not. */
export interface ImportRoutineOutcome {
  agent: string;
  when: string;
  what: string;
  detail: string;
}

/** What importing a pasted reply would do. Any problem blocks the import. */
export interface PasteImportPreview {
  source: string;
  blocks: number;
  agents: PasteImportAgent[];
  problems: string[];
}

export interface ImportSummary {
  created: string[];
  updated: string[];
  /** `[name, why]` */
  skipped: [string, string][];
  routinesSet: ImportRoutineOutcome[];
  routinesRefused: ImportRoutineOutcome[];
}

export const getPasteImportPrompt = () => invoke<string>('agents_import_paste_prompt');
export const previewPasteImport = (text: string) =>
  invoke<PasteImportPreview>('agents_import_paste_preview', { text });
export const importPaste = (text: string) => invoke<ImportSummary>('agents_import_paste', { text });
/* ------------------------------------------ import from the other app */

/**
 * The app this one grew out of, by name, for the palette's title only: it is
 * registered before any preview has been read. Everywhere else reads the
 * preview's `appName`, from `OTHER_APP_NAME` in
 * `src-tauri/src/agents/other_app.rs`, which also knows where its agents live.
 */
export const OTHER_APP_NAME = 'Ship Studio';

/** What happens to one of its agents (`other_app::Plan`). */
export type OtherAppPlan = 'new' | 'merge' | 'imported' | 'skip';

export interface OtherAppAgent {
  sourceId: string;
  name: string;
  role: string;
  color: string;
  isMain: boolean;
  plan: OtherAppPlan;
  /** Why it's skipped, or that it's already here. */
  reason?: string;
  instructions: string;
  memory: string[];
  messages: number;
  attachments: number;
  routines: { schedule: string; what: string }[];
  /** Names of secrets it had saved there; they don't come across. */
  secrets: string[];
  /** Its "Always allow" rules, in words. Left behind unless kept. */
  rules: string[];
  /** Bytes its folder takes. */
  bytes: number;
  /** Its folder; its copy in the other app works in the same one. */
  project?: string;
  projectMissing: boolean;
}

export interface OtherAppPreview {
  appName: string;
  source?: string;
  agents: OtherAppAgent[];
  /** Bytes an import would copy. */
  totalBytes: number;
  /** Same volume: the copy is a clone, instant and free. */
  sameVolume: boolean;
  freeBytes?: number;
  /** False only when a copy to another volume wouldn't fit. */
  enoughSpace: boolean;
}

export interface OtherAppSummary extends ImportSummary {
  appName: string;
  already: string[];
  routinesPaused: number;
  messages: number;
  secretsLeft: { agent: string; secrets: string[] }[];
  /** "Always allow" rules carried over, because the user kept them. */
  rulesKept: { agent: string; rules: string[] }[];
  /** "Always allow" rules left behind (the default). */
  rulesLeft: { agent: string; rules: string[] }[];
  filesSkipped: string[];
}

export interface OtherAppProgress {
  agent: string;
  doneBytes: number;
  totalBytes: number;
}

/** Null when the other app isn't on this Mac or has no agents. Reads only. */
export const previewOtherAppImport = () =>
  invoke<OtherAppPreview | null>('agents_other_app_preview');
/** Whether it has agents here, from its registry alone (cheap: for the palette). */
export const otherAppExists = () => invoke<boolean>('agents_other_app_exists');
/** Copies its team in; never writes to its folder. */
export const importFromOtherApp = (options: { keepRules: boolean } = { keepRules: false }) =>
  invoke<OtherAppSummary>('agents_other_app_import', { options });

export const previewSchedule = (when: string) =>
  invoke<SchedulePreview>('agents_schedule_preview', { when });
export const createCheckIn = (agentId: string, when: string, note: string) =>
  invoke<CheckIn>('agents_schedule_create', { agentId, when, note });
export const cancelCheckIn = (agentId: string, id: string) =>
  invoke<void>('agents_schedule_cancel', { agentId, id });
export const pauseCheckIn = (agentId: string, id: string, paused: boolean) =>
  invoke<void>('agents_schedule_pause', { agentId, id, paused });
export const updateCheckIn = (agentId: string, id: string, when: string, note: string) =>
  invoke<CheckIn>('agents_schedule_update', { agentId, id, when, note });
/** Fire it now as a normal wake; its next time doesn't move. */
export const runCheckInNow = (agentId: string, id: string) =>
  invoke<void>('agents_schedule_run_now', { agentId, id });

/* ------------------------------------------------------------- memory */

/** One entry of an agent's `## Memory`; mirrors `memory::Entry`. */
export interface MemoryEntry {
  text: string;
  /** The `###` heading it sits under ("Imported from Grok Bot"). */
  group?: string;
}

export interface MemoryView {
  entries: MemoryEntry[];
  /** The exact lines a delete removed, for Undo. */
  removed?: string;
}

/** Mirrors `memory::Change`. An edit or delete names the entry by position and words. */
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

export const getAgentMemory = (agentId: string) => invoke<MemoryView>('agents_memory', { agentId });
export const changeAgentMemory = (agentId: string, change: MemoryChange) =>
  invoke<MemoryView>('agents_memory_change', { agentId, change });
/** "Remember this": the message as one line worth keeping (Haiku, or its opening). */
export const suggestMemory = (text: string) => invoke<string>('agents_memory_suggest', { text });

export {
  groupMemory,
  undoDelete,
  type MemoryGroup,
} from '../../packages/companion-protocol/src/memory';

/**
 * Formatters are built once: `toLocaleTimeString` with options builds a new
 * one per call, which over a few hundred rows was the costliest part of a
 * chat render.
 */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const EXACT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

// The schedule's wording is shared with the phone, which shows the same list.
export {
  describeCheckInTime,
  describeEvery,
  describeWatchSource,
  describeWatchStatus,
  describeWatchTitle,
  watchUsesModel,
  watchCappedToday,
  DEFAULT_MAX_CHECKS_PER_DAY,
  describeRepeat,
  describeRun,
  describeRunDetail,
  formatWhen,
  formatWhenInline,
  routineEcho,
  routineInPast,
  routineWhenOf,
  routineWhenPhrase,
  scheduleWhenPhrase,
  sortCheckIns,
  splitScheduleInput,
} from '../../packages/companion-protocol/src/schedule';
// The routine picker, shared with the phone's schedule sheet.
export {
  CADENCES,
  INTERVALS,
  intervalLabel,
  newPicker,
  onceDays,
  pickerOf,
  toggleDay,
  WEEK,
  whenOf,
  type PickerState,
} from '../../packages/companion-protocol/src/routinePicker';

/** What Check now came to; mirrors `watch::CheckOutcome`. */
export interface WatchCheckOutcome {
  found: number;
  baseline: boolean;
  /** A model check found nothing before its baseline; the next check confirms it. */
  unconfirmed?: boolean;
  error?: string;
  paused?: string;
}

export const createWatch = (
  agentId: string,
  source: WatchSource,
  everyMinutes: number,
  note: string
) => invoke<CheckIn>('agents_watch_create', { agentId, source, everyMinutes, note });
export const updateWatch = (
  agentId: string,
  id: string,
  source: WatchSource,
  everyMinutes: number,
  note: string
) => invoke<CheckIn>('agents_watch_update', { agentId, id, source, everyMinutes, note });
export const checkWatchNow = (agentId: string, id: string) =>
  invoke<WatchCheckOutcome>('agents_watch_check_now', { agentId, id });

export const searchAgents = (query: string) => invoke<SearchHit[]>('agents_search', { query });
export const getAgentUsage = (agentId: string) => invoke<UsageSummary>('agents_usage', { agentId });
/** Each engine's plan as it last reported it; empty when none has (`agents::quota`). */
export const getQuotas = () => invoke<Quota[]>('agents_quota');

// The plan's limits and a routine's week, worded once for the desk and the phone.
export {
  apiPrice,
  COST_BASIS_NOTE,
  onClaudePlan,
  QUOTA_WARN_PERCENT,
  quotaLines,
  resetDay,
  resetPhrase,
  retryPhrase,
  routineWeekLine,
  fullyPriced,
  sumTotals,
  type QuotaLine,
  type QuotaTone,
} from '../../packages/companion-protocol/src/quota';
import {
  apiPrice as apiPriceWords,
  fullyPriced as fullyPricedTotals,
  resetPhrase as resetWords,
} from '../../packages/companion-protocol/src/quota';

/**
 * A hit's snippet cut to start a few words before its first match, so the
 * match survives a two-line clamp. The backend leads with more context than
 * a narrow sidebar can show.
 */
export function snippetAround(snippet: string, query: string, lead = 14): string {
  const runs = highlightRuns(snippet, query);
  const first = runs.findIndex((r) => r.match);
  if (first < 0) return snippet;
  const at = runs.slice(0, first).reduce((n, r) => n + r.text.length, 0);
  if (at <= lead + 1) return snippet;
  // Start at a word boundary inside the lead, so no word is cut in half.
  const space = snippet.indexOf(' ', at - lead);
  const start = space >= 0 && space < at ? space + 1 : at;
  return `…${snippet.slice(start).replace(/^…/, '')}`;
}

/** Hits grouped by agent, groups in the order their newest hit appears. */
export function groupHits(hits: SearchHit[]): { agentId: string; hits: SearchHit[] }[] {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.agentId);
    if (group) group.push(hit);
    else groups.set(hit.agentId, [hit]);
  }
  return [...groups].map(([agentId, group]) => ({ agentId, hits: group }));
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * "$0.42 at API prices · 38k tokens · 6 turns · 4 min", from what Claude Code
 * reported. The cost is left out unless every turn reported one (a partial
 * sum would read as the whole), and on a Claude plan (`onPlan`), where it is
 * a list price and not the bill. Null when there were no turns.
 */
export function formatUsage(totals: UsageTotals, onPlan = false): string | null {
  const checks = totals.checks ?? 0;
  if (totals.turns === 0 && checks === 0) return null;
  const tokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const parts = [`${compact(tokens)} tokens`];
  if (totals.turns > 0) parts.push(`${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'}`);
  // "When…" model checks are said apart: they aren't turns.
  if (checks > 0) parts.push(`${checks} ${checks === 1 ? 'check' : 'checks'}`);
  if (totals.durationMs > 0) parts.push(duration(totals.durationMs));
  if (fullyPricedTotals(totals) && !onPlan) {
    parts.unshift(apiPriceWords(totals.costUsd));
  }
  return parts.join(' · ');
}

/** "72% full · 144k of 200k tokens", or null when its engine didn't say. */
export function formatContext(agent: Pick<Agent, 'context'>): string | null {
  const percent = contextPercent(agent);
  if (percent === null || !agent.context) return null;
  const { used, window } = agent.context;
  return `${percent < 1 ? '<1' : percent}% full · ${compact(used)} of ${compact(window)} tokens`;
}

/** Who said a hit's line, when it wasn't the agent itself. */
export function hitSpeaker(hit: SearchHit): string | null {
  if (hit.kind === 'user') return 'You';
  if (hit.kind === 'sent_to_agent') return hit.peerName ? `To ${hit.peerName}` : null;
  if (hit.kind === 'from_agent') return hit.peerName ?? null;
  return null;
}

/** "2:01 PM" today, "Nov 2" this year, "Nov 2, 2025" before. */
export function formatHitTime(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return CLOCK.format(date);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Split text into plain and matching runs for highlighting: every
 * case-insensitive occurrence of any query word is a match.
 */
export function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
  const words = query
    .split(/\s+/)
    .filter(Boolean)
    // Longest first, so "invoice" wins over "in" at the same spot.
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return [{ text, match: false }];
  // With one capturing group, split puts the matches at the odd indices.
  return text
    .split(new RegExp(`(${words.join('|')})`, 'gi'))
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((run) => run.text.length > 0);
}

/**
 * Sidebar order: pinned first, then most recently active. The Chief of Staff
 * is created pinned (it's the one agent you're told to talk to, so it
 * shouldn't move under you), but it's an ordinary pin: unpin it and it sorts
 * by recency like everyone else.
 */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/**
 * A message of yours the agent hasn't read yet: sent after the turn in
 * progress began, so it is queued for the next one.
 */
/** What `isQueued` and `drivingBriefId` read of an agent: its turn, not what it's doing. */
export interface AgentTurn {
  status: Pick<AgentStatus, 'state' | 'since'>;
  takeover?: Pick<AgentTakeover, 'since'>;
}

export function isQueued(message: AgentMessage, agent: AgentTurn): boolean {
  if (message.kind !== 'user') return false;
  // While you drive it, what you send in the chat waits for the hand-back.
  if (agent.takeover) return message.ts > agent.takeover.since;
  const { state, since } = agent.status;
  return state !== 'idle' && since != null && message.ts > since;
}

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export function needsYou(agent: Agent): boolean {
  return agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;
}

/** Its last turn failed, and nothing has been said since. Not while it works again. */
export function failedTurn(agent: Agent): Failure | null {
  return agent.failure && agent.status.state === 'idle' ? agent.failure : null;
}

/** Needs you, or its last turn didn't finish: what the "next needing you" key visits. */
/**
 * Waiting on you: a request, or a turn that failed and needs you to act. A
 * usage limit isn't one: it resets by itself and is quiet (docs/agents.md,
 * "amber means needs you, only"), so it isn't counted in "Needs you · N".
 */
export const needsAttention = (agent: Agent) => {
  if (needsYou(agent)) return true;
  const failure = failedTurn(agent);
  return failure !== null && failure.kind !== 'usage_limit';
};

/** Stopped by a usage limit: paused until it resets, not waiting on you. */
export const usageLimited = (agent: Agent) =>
  !needsYou(agent) && failedTurn(agent)?.kind === 'usage_limit';

/** The text of a failure's first clause: "Didn't finish: Couldn't start Claude Code". */
export function failureLine(failure: Failure, preview: string | null): string {
  if (failure.kind === 'usage_limit') {
    return failure.resetsAt
      ? `Usage limit · resets ${resetWords(failure.resetsAt)}`
      : 'Usage limit reached';
  }
  if (failure.kind === 'signed_out') return 'Claude Code is signed out';
  // The reason first: two lines in the sidebar, and the reason is what matters.
  const clause = (preview ?? '').split(/(?<=[.!?:])\s/)[0].replace(/[.:]$/, '');
  return clause ? `${clause} · didn’t finish` : 'Didn’t finish';
}

const FILE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|css|scss|html?|mdx?|json|ya?ml|toml|rs|py|rb|go|swift|kt|java|svelte|vue|astro|txt|csv|sql|sh)$/i;

/**
 * "PricingTable.tsx" → "the pricing table"; "…/src/App.tsx" → "the app".
 * The file's own name, said as words: a guess at nothing, a filename is
 * just not how a person says what they're working on.
 */
export function plainFileName(path: string): string {
  const base =
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? path;
  const stem = base.replace(FILE_EXT, '');
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words || words === 'index') return 'a file';
  return `the ${words}`;
}

/**
 * What an agent is doing, said the way a person would: the engine's activity
 * line ("Editing PricingTable.tsx", "$ npm test", "Reading …/src/App.tsx")
 * with file names, paths and commands put into words. A line that's already
 * plain ("Drafting the reminders", "Messaging Finance") is left alone.
 */
export function plainActivity(activity: string | null | undefined): string | null {
  const text = activity?.trim();
  if (!text) return null;
  if (text.startsWith('$ ')) return 'Running a command';
  const verb = /^(Editing|Reading|Writing|Listing|Searching for|Fetching)\s+(.+)$/.exec(text);
  if (!verb) return text;
  const [, action, rest] = verb;
  const fileish = /[/\\]/.test(rest) || FILE_EXT.test(rest);
  switch (action) {
    case 'Editing':
    case 'Writing':
      return fileish ? `Working on ${plainFileName(rest)}` : text;
    case 'Reading':
      return fileish ? `Reading ${plainFileName(rest)}` : text;
    case 'Listing':
    case 'Searching for':
      return 'Looking through the files';
    case 'Fetching': {
      const host = /^https?:\/\/([^/\s]+)/.exec(rest)?.[1];
      return host ? `Reading ${host.replace(/^www\./, '')}` : 'Reading a web page';
    }
    default:
      return text;
  }
}

/**
 * An agent's state as another chat shows it, beside its name on a
 * delegation line. `failed` is only said when its newest line is known and is
 * an error; otherwise an idle agent is idle.
 */
export type PeerState =
  | { kind: 'working'; label: string }
  | { kind: 'waiting'; label: string }
  | { kind: 'failed'; label: string }
  | { kind: 'idle'; label: string };

export function peerState(agent: Agent, lastLine?: AgentMessage | null): PeerState {
  if (needsYou(agent)) return { kind: 'waiting', label: 'needs your OK' };
  if (agent.status.state === 'working') {
    const activity = plainActivity(agent.status.activity);
    return { kind: 'working', label: activity ? lowerFirst(activity) : 'working' };
  }
  if (failedTurn(agent) || lastLine?.kind === 'error')
    return { kind: 'failed', label: "didn't finish" };
  return { kind: 'idle', label: 'idle' };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The newest line that says how an agent's last turn went (not a note or card). */
export function lastOutcome(messages: AgentMessage[] | undefined): AgentMessage | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const kind = messages[i].kind;
    if (kind !== 'note' && kind !== 'changes' && kind !== 'session') return messages[i];
  }
  return null;
}

/**
 * The brief this agent is working on: while a turn runs, the newest
 * agent-to-agent group that arrived before the turn began, if nothing of
 * yours came after it. Its first line's id, or null.
 */
export function drivingBriefId(items: ChatItem[], agent: AgentTurn): string | null {
  const { state, since } = agent.status;
  if (state === 'idle' || since == null) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'day') continue;
    if (item.type === 'message') {
      if (
        item.message.ts > since ||
        item.message.kind === 'note' ||
        item.message.kind === 'session'
      )
        continue;
      return null;
    }
    const last = item.messages[item.messages.length - 1];
    if (last.ts > since) continue;
    return last.kind === 'from_agent' ? item.messages[0].id : null;
  }
  return null;
}

/**
 * The newest line where this agent handed work to each peer: the one that
 * shows how that work is going. Lines that only brought work in carry none.
 */
export function newestPeerGroups(items: ChatItem[]): Set<string> {
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== 'peer-group' || seen.has(item.peer.id)) continue;
    if (!item.messages.some((m) => m.kind === 'sent_to_agent')) continue;
    seen.add(item.peer.id);
    ids.add(item.messages[0].id);
  }
  return ids;
}

/** "acme" from "/Users/me/ShipStudio/acme/". */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

/**
 * Changed files by name, as the change card lists them: just the file name,
 * unless two share it, when each of those gets its parent folder too
 * ("app/page.tsx", "blog/page.tsx"). Keyed by path.
 */
export function changedFileLabels(paths: string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = folderName(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(
    paths.map((path) => {
      const name = folderName(path);
      if ((counts.get(name) ?? 0) < 2) return [path, name];
      const parts = path.replace(/\/+$/, '').split('/');
      return [path, parts.length > 1 ? parts.slice(-2).join('/') : name];
    })
  );
}

/**
 * An agent's role for the header, without a folder path in it ("Owns the
 * Acme rebuild in ~/ShipStudio/acme" → "Owns the Acme rebuild"): the
 * project chip beside it already says where it works.
 */
export function roleWithoutPath(role: string): string {
  const path = String.raw`(?:~|\/(?:Users|home|Volumes|private)\b)[^\s,;]*?(?=\.?(?:\s|$|[,;]))`;
  return role
    .replace(new RegExp(String.raw`\s+(?:in|at|from|under|inside)\s+` + path, 'g'), '')
    .replace(new RegExp(path, 'g'), '')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A run of consecutive agent-to-agent lines with the same peer collapses into one row. */
export type ChatItem =
  | { type: 'message'; message: AgentMessage }
  | { type: 'peer-group'; peer: AgentRef; messages: AgentMessage[] }
  | { type: 'day'; ts: number }
  /** What this agent said in a room, folded into one line that opens the room. */
  | { type: 'room'; roomId: string; messages: AgentMessage[] };

const isPeerLine = (m: AgentMessage) => m.kind === 'sent_to_agent' || m.kind === 'from_agent';

/**
 * A time divider marks a new sitting, not a pause: a new day, or three hours
 * of quiet. Any more often and they become noise between every few lines.
 */
const DIVIDER_GAP_MS = 3 * 60 * 60 * 1000;

/** How an agent's own chat folds what its members said in rooms. */
export interface ChatFolding {
  /** A line kept in full even though it was said in a room (its open copy's card). */
  unfolded?: string | null;
  /** Whether lines from this room fold; a room that is gone doesn't. */
  folds?: (roomId: string) => boolean;
}

export function buildChatItems(messages: AgentMessage[], folding: ChatFolding = {}): ChatItem[] {
  const items: ChatItem[] = [];
  let lastTs = 0;
  // The local day `lastTs` falls in, as [start, end): "same day" is a range
  // check, and a Date is made only when a message crosses midnight, not two
  // per message as comparing date strings did.
  let dayStart = 0;
  let dayEnd = 0;
  for (const message of messages) {
    if (
      items.length === 0 ||
      message.ts - lastTs > DIVIDER_GAP_MS ||
      message.ts < dayStart ||
      message.ts >= dayEnd
    ) {
      items.push({ type: 'day', ts: message.ts });
    }
    lastTs = message.ts;
    if (lastTs < dayStart || lastTs >= dayEnd) {
      const day = new Date(lastTs);
      day.setHours(0, 0, 0, 0);
      dayStart = day.getTime();
      day.setDate(day.getDate() + 1);
      dayEnd = day.getTime();
    }
    const previous = items[items.length - 1];
    // Said in a room: the room's thread shows it; here it's one line. A card
    // still waiting on you stays a card, so nothing waits out of sight.
    if (
      message.room &&
      message.approval?.status !== 'pending' &&
      message.id !== folding.unfolded &&
      (folding.folds?.(message.room) ?? true)
    ) {
      if (previous?.type === 'room' && previous.roomId === message.room) {
        previous.messages.push(message);
        continue;
      }
      items.push({ type: 'room', roomId: message.room, messages: [message] });
      continue;
    }
    // The other assistant's side of an import is the conversation itself:
    // shown in full, never folded away like agents' hand-offs.
    if (isPeerLine(message) && message.peer && !isConnectorLine(message)) {
      if (previous?.type === 'peer-group' && previous.peer.id === message.peer.id) {
        previous.messages.push(message);
        continue;
      }
      items.push({ type: 'peer-group', peer: message.peer, messages: [message] });
      continue;
    }
    items.push({ type: 'message', message });
  }
  return items;
}

/** "Today 2:01 PM", "Yesterday 9:12 AM", "Mon, Nov 2 4:00 PM". */
export function formatDivider(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = CLOCK.format(date);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday.getTime()) return `Today ${time}`;
  if (ts >= startOfToday.getTime() - dayMs) return `Yesterday ${time}`;
  return `${SHORT_DAY.format(date)} ${time}`;
}

/**
 * Runs of the same request ("Send an email · Gmail") with nothing of yours
 * between them: each card's place in its run, for "2 of 3 similar requests".
 * What the agent says between cards ("Here's the next one") doesn't break a
 * run; anything you say, or anything else happening, does. Counted from the
 * cards that are here, never from how many the agent might still send.
 */
export function approvalSeries(items: ChatItem[]): Map<string, { index: number; total: number }> {
  const series = new Map<string, { index: number; total: number }>();
  let run: string[] = [];
  let title: string | null = null;
  const close = () => {
    if (run.length > 1) run.forEach((id, i) => series.set(id, { index: i + 1, total: run.length }));
    run = [];
    title = null;
  };
  for (const item of items) {
    if (item.type === 'day') continue;
    if (item.type !== 'message') {
      close();
      continue;
    }
    const m = item.message;
    if (m.kind === 'agent' || m.kind === 'note') continue;
    const a = m.approval;
    if (m.kind !== 'approval' || !a || a.prompt || a.secret) {
      close();
      continue;
    }
    if (a.title !== title) close();
    title = a.title;
    run.push(m.id);
  }
  close();
  return series;
}

/** The centred line for a collapsed run of agent-to-agent messages. */
export function peerGroupLabel(messages: AgentMessage[]): string {
  if (messages.length > 1) return `${messages.length} messages with`;
  return messages[0].kind === 'sent_to_agent' ? 'Messaged' : 'Message from';
}

// Quotes are shared with the phone, which must write and read the same format.
export {
  quoteText,
  withQuotes,
  splitQuotes,
  type BubblePart,
} from '../../packages/companion-protocol/src/quotes';

import type { ResultCard, ResultRef } from '../../packages/companion-protocol/src/results';
export type {
  ResultCard,
  ResultItem,
  ResultRef,
  ShotRole,
} from '../../packages/companion-protocol/src/results';
export {
  beforeAfter,
  CHECKED_HEADING,
  changesLine,
  itemName,
  listedItems,
  newestResults,
  revisingLabel,
  supersededLine,
} from '../../packages/companion-protocol/src/results';

/** "9:24 AM": a message's time, on hover. */
export function formatClock(ts: number): string {
  return CLOCK.format(ts);
}

/** "Tuesday, November 4, 2026 at 9:24:13 AM": the exact time, in its tooltip. */
export function formatExactTime(ts: number): string {
  return EXACT.format(ts);
}

/**
 * What a failed turn's one next step is. The backend tags new lines; older
 * ones are matched on Claude Code's own wordings and on the app's classified
 * message (commands/ai.rs), never on a bare "sign in", which turns up in
 * ordinary prose.
 */
export function errorRemedy(message: Pick<AgentMessage, 'text' | 'failure'>): 'sign-in' | null {
  if (message.failure) return message.failure.kind === 'signed_out' ? 'sign-in' : null;
  const lower = message.text.toLowerCase();
  return /isn't signed in anymore|please run \/login|oauth token has expired|invalid api key|not logged in|session expired/.test(
    lower
  )
    ? 'sign-in'
    : null;
}

/** The last thing you sent before `index`, words and files, to send again. */
export function lastUserMessage(messages: AgentMessage[], index: number): AgentMessage | null {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'user') continue;
    return m.text.trim() || m.attachments?.length ? m : null;
  }
  return null;
}

/**
 * What Retry sends again: the user's message before the newest line, when
 * that line is a turn's error. A take-over's terminal that closed by itself
 * isn't a turn, so it offers none.
 */
export function retrySourceFor(messages: AgentMessage[]): AgentMessage | null {
  const last = messages[messages.length - 1];
  if (last?.kind !== 'error' || last.takeover) return null;
  return lastUserMessage(messages, messages.length - 1);
}

/**
 * What Retry sends again with the failed ask's words: its mentions, its files
 * (by path, already in the agent's home) and, for an "Ask for changes", the
 * result it revises, so the retried ask still updates the same card.
 */
export function retryExtras(
  agent: Agent,
  source: AgentMessage
): { mentions: AgentRef[]; resend: OutgoingAttachment[]; revises?: ResultRef } {
  return {
    mentions: source.mentions ?? [],
    resend: resendable(agent, source),
    ...(source.revises ? { revises: source.revises } : {}),
  };
}

/** A message's files as `agents_send` takes them: copied again from the agent's home. */
export const resendable = (agent: Agent, message: AgentMessage): OutgoingAttachment[] =>
  (message.attachments ?? []).map((a) => ({ name: a.name, path: `${agent.home}/${a.path}` }));

/** A check-in's note is capped (`MAX_NOTE_CHARS` in schedule.rs). */
const RETRY_NOTE_MAX = 560;

/**
 * What a "Retry at <reset>" check-in tells the agent when it fires. A check-in
 * carries words only, so the files that went with the ask are named by path
 * (they stay in the agent's home); the ask gives way to them under the cap.
 */
export function retryNote(text: string, files: string[] = []): string {
  const ask = text.trim();
  const head = 'Claude Code’s usage limit has reset. Carry on with what I asked';
  // At most half the note: as many paths as fit, then how many more.
  let attached = '';
  for (let n = files.length; n > 0 && !attached; n--) {
    const more = n < files.length ? `, and ${files.length - n} more` : '';
    const line = ` Files I attached: ${files.slice(0, n).join(', ')}${more}`;
    if (line.length <= RETRY_NOTE_MAX / 2) attached = line;
  }
  if (!ask) return `${head}.${attached}`;
  const room = RETRY_NOTE_MAX - head.length - 4 - attached.length;
  return `${head}: “${ask.length > room ? `${ask.slice(0, room - 1)}…` : ask}”${attached}`;
}

/** `agents_schedule_create`'s `when` for a moment: whole minutes from now, rounded up. */
export const whenAt = (ts: number, now = Date.now()) =>
  `in ${Math.max(1, Math.ceil((ts - now) / 60_000))} minutes`;

/** The longest a name being typed after @ can run before it's just text. */
const MENTION_MAX = 40;

/**
 * The @mention being typed at the caret, if any: an @ at the start or after
 * whitespace, with no line break between it and the caret. Names have
 * spaces ("Acme Site"), so the query may too.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > MENTION_MAX || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** Agents whose name matches what's typed after @: name starts first, then any word. */
export function mentionCandidates(agents: Agent[], query: string): Agent[] {
  const q = query.toLowerCase();
  const starts = (a: Agent) => a.name.toLowerCase().startsWith(q);
  const words = (a: Agent) =>
    a.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.startsWith(q));
  return [...agents.filter(starts), ...agents.filter((a) => !starts(a) && words(a))];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An "@Name" for each agent, standing alone (not the start of a longer word). */
function mentionPattern(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`(?<=^|\\s)@(${alternatives})(?![\\w])`, 'gi');
}

/** The agents a message @mentions, in the order they first appear. */
export function mentionedAgents(text: string, agents: Agent[]): Agent[] {
  const pattern = mentionPattern(agents.map((a) => a.name));
  if (!pattern) return [];
  const found: Agent[] = [];
  for (const match of text.matchAll(pattern)) {
    const agent = agents.find((a) => a.name.toLowerCase() === match[1].toLowerCase());
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/** Text split around the @mentions a message recorded, for tinting them. */
export function mentionRuns(
  text: string,
  mentions: AgentRef[] = []
): { text: string; mention?: AgentRef }[] {
  const pattern = mentionPattern(mentions.map((m) => m.name));
  if (!pattern) return [{ text }];
  const runs: { text: string; mention?: AgentRef }[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index) });
    const mention = mentions.find((m) => m.name.toLowerCase() === match[1].toLowerCase());
    runs.push({ text: match[0], mention });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** The "What's in flight" overview's place in the selection, beside agent ids (⌘K only). */
export const TEAM_ID = '__team';

/** A reply's first line as plain words, for a one-line row. */
export function replyPreview(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(```|\||---)/.test(l)) ?? '';
  return line
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '');
}

/** What the Team view lists; everything is read from the store, nothing inferred. */
export interface TeamSummary {
  working: Agent[];
  /** Cards to answer, or the failed turn's line (newest in its chat) to act on. */
  needsYou: { agent: Agent; approvals: AgentMessage[]; failure: AgentMessage | null }[];
  /** Stopped by a usage limit, with the line that says when it resets. */
  paused: { agent: Agent; failure: AgentMessage | null }[];
  scheduled: { agent: Agent; checkIn: CheckIn }[];
  replies: { agent: Agent; message: AgentMessage }[];
}

export const TEAM_SCHEDULED_MAX = 5;
export const TEAM_REPLIES_MAX = 6;

/**
 * The overview from the agents and whatever chat lines are loaded for them.
 * Hidden agents are left out, as they are from the badge. Paused routines
 * aren't "next", so they're left out too.
 */
export function summarizeTeam(
  agents: Agent[],
  messages: Record<string, AgentMessage[] | undefined>
): TeamSummary {
  const shown = sortAgents(agents.filter((a) => !a.hidden));
  const scheduled = shown
    .flatMap((agent) =>
      (agent.checkIns ?? []).filter((c) => !c.paused).map((checkIn) => ({ agent, checkIn }))
    )
    .sort((a, b) => a.checkIn.nextAt - b.checkIn.nextAt)
    .slice(0, TEAM_SCHEDULED_MAX);
  const replies = shown
    .flatMap((agent) =>
      (messages[agent.id] ?? [])
        .filter((m) => m.kind === 'agent' && m.text.trim())
        .map((message) => ({ agent, message }))
    )
    .sort((a, b) => b.message.ts - a.message.ts)
    .slice(0, TEAM_REPLIES_MAX);
  return {
    working: shown.filter((a) => a.status.state === 'working' && !needsYou(a)),
    needsYou: shown.filter(needsAttention).map((agent) => {
      const lines = messages[agent.id] ?? [];
      const last = lines[lines.length - 1];
      return {
        agent,
        approvals: lines.filter((m) => m.approval?.status === 'pending'),
        failure: failedTurn(agent) && last?.kind === 'error' ? last : null,
      };
    }),
    paused: shown.filter(usageLimited).map((agent) => {
      const lines = messages[agent.id] ?? [];
      const last = lines[lines.length - 1];
      return { agent, failure: last?.kind === 'error' ? last : null };
    }),
    scheduled,
    replies,
  };
}
