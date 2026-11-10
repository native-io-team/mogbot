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
import type { SettingsProposal } from './policy';
import type { CrossoverAsk, CrossoverAway } from './crossover';

/** What a planned action is (`agents/plan_grant.rs`, `Kind`). */
export type PlanKind =
  | 'push'
  | 'pull_request'
  | 'merge'
  | 'issue'
  | 'comment'
  | 'release'
  | 'deploy'
  | 'publish'
  | 'post'
  | 'send'
  | 'request'
  | 'github';

/** One action on a plan card: what, where, and the agent's words for it. */
export interface PlanAction {
  kind: PlanKind;
  /** Where: a repo (`owner/repo`), a project, a channel, a site. */
  target: string;
  summary: string;
  /** The exact words it sends, posts or comments, when it does. */
  text?: string;
}

/** "Do these under your name?" (`ask_plan`): one card, one Allow, for the whole plan. */
export interface PlanCard {
  actions: PlanAction[];
  why?: string;
}
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
  /** A short progress line the agent wrote mid-turn ("Starting the previews"), kept here, not in the chat. */
  | 'note'
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
  /** When what it ran came back. Absent while it runs, and in older timelines. */
  endedAt?: number;
  /** What a test run printed it came to ("42 passed, 3 failed"). */
  summary?: string;
  /** The last lines a long or failed command printed (finished timelines only). */
  output?: string[];
}

/** A tool known to take a while (`agents::describe::Slow`); a newer Mac may send another. */
export type WorkSlow = 'tests' | 'build' | 'install' | 'deploy' | 'other';

/**
 * The call running right now (`agents::work::LiveCall`): its plain words,
 * when it started, and what it printed so far where the engine streams it.
 */
export interface LiveCall {
  kind: WorkStepKind;
  /** Its working-line words ("Running the Cypress tests"). */
  label: string;
  startedAt: number;
  /** Known to take a while: "This usually takes a few minutes". */
  slow?: WorkSlow;
  /** Its newest lines of output so far. */
  output?: string[];
  /** The engine streams this call's output; when false it appears only once it finishes. */
  streams: boolean;
  /** Its process was using the CPU at the last look; absent when not found. */
  busy?: boolean;
  /** "Stop this step" can find its process. */
  canStop: boolean;
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
  /** While it runs: the call running now, in full. */
  current?: LiveCall;
  /** While it runs: its last sign of life (any engine output, its command's output or CPU). */
  lastSignAt?: number;
  /** While it runs, once it has made no progress for too long: when it last did. */
  quietSince?: number;
  /**
   * While it runs: the project folder it is working in (by its own commands,
   * a session or its binding), so the Projects list shows it there. Older
   * Macs omit it.
   */
  project?: string;
  /** While it runs: it has a tab open in its own browser (the agents' Chrome) right now. */
  ownBrowser?: boolean;
  /**
   * The page was asked for folded lines only (`work: 'summary'`, `lazyWork`):
   * `steps` is empty though the turn kept some. They are read when its
   * "What it did" opens (`agents.workSteps`, `agents_turn_work`). Absent
   * from a Mac that never leaves them out, and from pages that didn't ask.
   */
  stepsOmitted?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  shape: number;
  /**
   * Its key (docs/internal/agent-keys.md): a colourway, a legend and the
   * keyboard key it's bound to. Older Macs omit them: `keyLookFor` draws
   * one from `color`, the name and the role.
   */
  colorway?: string;
  icon?: string;
  boundKey?: string;
  color: string;
  isMain: boolean;
  /**
   * The user's "Admin — can manage and approve for other agents" switch
   * (`agents::admin`). Absent: the default, which is on for the Chief of
   * Staff only (`isAdmin`). Older Macs never send it.
   */
  admin?: boolean;
  /**
   * Its own independence level (`agents/policy.rs`). Absent: the team's
   * (`AgentsOverview.independence`). Older Macs never send it.
   */
  independence?: AgentIndependence;
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
  /**
   * "Runs on": the one account of its engine (`UsageAccount.id`) its turns
   * run on, never another. Absent: any account, in the order turns try
   * them. Older Macs never send it.
   */
  account?: string;
  /**
   * The account its last turn ran on, as it is shown; only while its engine
   * has more than one account. Older Macs never send it.
   */
  ranOn?: { id: string; name: string };
  /** One of its engine's models; null is that engine's default. */
  model: string | null;
  /**
   * How hard its conversation turns think (Claude Code's `--effort`, Codex's
   * reasoning effort); omitted is the engine's default. From a Mac that lists
   * `MAC_FEATURES.effort`.
   */
  effort?: AgentEffort;
  /** What its routines run on; omitted when automatic. */
  routineModel?: string;
  /** The ready-made agent it was made from (`agents.templates`), if any. */
  template?: string;
  /**
   * Its first-open starters (`agents/starters.rs`): three tasks under its
   * welcome, until the user sends anything. Older Macs never send it.
   */
  starters?: AgentStarter[];
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
  /** Every account of its engine is out; its turns carry on with the other engine meanwhile (`crossover`). */
  away?: CrossoverAway;
  /** How full its conversation is, as its engine reported it; omitted when it doesn't say. */
  context?: ContextFill;
  /** You're driving its session in a terminal on the Mac; omitted otherwise. */
  takeover?: AgentTakeover;
  /**
   * The conversation its session (and a turn in progress) belongs to
   * (`conversations.rs`); absent, the first. Omitted while it only ever used the first.
   */
  conversations?: { loaded?: string };
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
  /**
   * `interrupted`: cut off part-way and not picked up by itself; Continue
   * carries on. `engine_missing`: its engine isn't on the Mac any more
   * (older Macs never send it).
   */
  kind: 'usage_limit' | 'signed_out' | 'interrupted' | 'engine_missing' | 'other';
  resetsAt?: number;
}

/**
 * Which day of the month a monthly routine runs on; mirrors
 * `schedule::MonthDay`. `day` is 1–31, or -1 for the last day (a date a
 * month doesn't have runs on its last day); `nth` is 1–4, or -1 for the
 * last, of `weekday` (0 = Sunday).
 */
export type MonthDay = { day: number } | { nth: number; weekday: number };

export type Repeat =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number }
  | {
      kind: 'monthly';
      /** Every this many months, 1–12 (3 is quarterly). */
      months: number;
      on: MonthDay;
      hour: number;
      minute: number;
      /** With `months` over 1: a month it runs in, `year * 12 + month - 1`. */
      from?: number;
    };

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
  /** The model this routine wakes its agent on (`same`: the agent's own); omitted for the agent's routine model. */
  model?: string;
  /** Steps after the first (`note`), each its own turn (`routine_steps::Step`). Macs with `MAC_FEATURES.steps`. */
  then?: RoutineStep[];
  /** A run waiting for the user's OK between two steps, with its card. */
  waiting?: RoutineWaiting;
}

/** A step after a routine's first; mirrors `routine_steps::Step`. */
export interface RoutineStep {
  text: string;
  /** Wait for the user's OK (an "OK to go on?" card) before running it. */
  askFirst?: boolean;
}

/** Mirrors `routine_steps::Waiting`. */
export interface RoutineWaiting {
  runAt: number;
  /** The step it waits to run, counting the first as 1. */
  step: number;
  requestId: string;
  askedAt: number;
}

/** "OK to go on?" between two steps of a routine; mirrors `routine_steps::Gate`. */
export interface RoutineGate {
  checkInId: string;
  routine: string;
  /** The step that just ended, from 1. */
  done: number;
  total: number;
  /** The next step's words, exactly. */
  next: string;
  runAt: number;
}

/** A routine set up with a new agent; mirrors `draft::NewRoutine`. */
export interface NewRoutine {
  when: string;
  note: string;
  then?: RoutineStep[];
}

/** One drafted routine, as the Mac's grammar read it; mirrors `draft::DraftRoutine`. */
export interface DraftRoutine extends NewRoutine {
  /** "every weekday at 08:00", when the grammar could read `when`. */
  readsAs?: string;
  /** Why it can't be set up as drafted. */
  problem?: string;
}

/** "Describe the agent you want", drafted for review; mirrors `draft::Draft`. Nothing is created. */
export interface AgentDraft {
  name: string;
  role: string;
  color: string;
  instructions: string;
  routines: DraftRoutine[];
  /** Apps it will ask to connect when it first needs them. Never a claim that one is connected. */
  apps: string[];
  /** What it says first, in its own voice. Older Macs never send it. */
  welcome?: string;
  /** First tasks to offer, each with the apps it needs; the Mac picks three it can reach. */
  starters?: StarterIdea[];
}

/** A first task its creator suggested; mirrors `starters::Idea`. */
export interface StarterIdea {
  text: string;
  /** Apps (from the draft's `apps`) it can't be done without. */
  needs: string[];
}

/**
 * One first-open starter; mirrors `starters::Starter`. Tapping it sends
 * `text` as the user's message.
 */
export interface AgentStarter {
  text: string;
  /** The app it asks to connect: the one login ask. */
  connect?: string;
}

/** What a draft passes on to Create: its welcome, first tasks and apps. */
export function openingOf(draft: AgentDraft | null | undefined): {
  welcome?: string;
  starters?: StarterIdea[];
  apps?: string[];
} {
  if (!draft) return {};
  return {
    ...(draft.welcome ? { welcome: draft.welcome } : {}),
    ...(draft.starters?.length ? { starters: draft.starters } : {}),
    ...(draft.apps.length ? { apps: draft.apps } : {}),
  };
}

/**
 * Whether a chat still shows its starters: it has some and the user hasn't
 * said anything in it (the Mac clears them on the first message; this
 * covers the moment before the registry catches up).
 */
export function showsStarters(
  agent: { starters?: AgentStarter[] },
  messages: readonly { kind: string }[]
): boolean {
  return !!agent.starters?.length && !messages.some((m) => m.kind === 'user');
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
  outcome:
    | 'running'
    | 'ran'
    | 'retrying'
    | 'failed'
    | 'skipped'
    | 'waiting'
    | 'declined'
    | 'held'
    | 'unknown';
  /** 1 for the run itself, 2 for its first retry. */
  attempt: number;
  /** Why it failed, as the chat said it. */
  detail?: string;
  retryAt?: number;
  /** Connectors Claude Code said need signing in again. */
  signIn?: string[];
  /** Run now, from the popover. */
  manual?: boolean;
  /** A routine in steps: the step it reached, from 1. */
  step?: number;
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

/** Mirrors `store::EFFORTS`: the levels both engines take. */
export type AgentEffort = 'low' | 'medium' | 'high';
export const AGENT_EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high'];

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
  /**
   * Whether "bring your agents, or start fresh?" was answered. Optional: a
   * Mac from before it sends none, and then the phone never asks.
   */
  importChoice?: ImportChoice;
  /** This Mac shows a 24-hour clock (`agents::clock`). Older Macs never send it. */
  hour24?: boolean;
}

/** Mirrors `agents::import_choice::Choice`. */
export type ImportChoice = 'undecided' | 'imported' | 'declined';

/**
 * Mirrors `agents::independence::Level`: how much the user's agents do on
 * their own. It changes what they're told, never what asks for an Allow.
 */
export type AgentIndependence = 'often' | 'judgement' | 'go_hard' | 'full_send';

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
  /** The user's own words, when remembered from what they said in chat (`agents/remember.rs`). */
  said?: string;
}

export interface PermissionRule extends PermissionScope {
  id: string;
  createdAt: number;
}

export interface AgentRef {
  id: string;
  name: string;
}

/**
 * A step-in card (desktop `agents/step_in.rs`): an agent in its own browser
 * needs a person for one step (SSO, a passkey, a 2FA code, a CAPTCHA). Never
 * anything typed: the reason and the page it was on.
 */
export interface StepInCard {
  /** The agent's words: what the user needs to do there. */
  reason: string;
  /** The page's host, for the card. */
  site: string;
  url: string;
  pageTitle?: string;
  /** The agent's tab number. */
  tab: number;
  /** The user is in the tab now, since (ms). Laid over by the Mac, never stored. */
  inSince?: number;
  /** When it is handed back by itself (ms). */
  until?: number;
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
  /** "Change this agent's settings?" (`propose_settings_change`): who, and what changes in plain words. Allow applies it. A Mac without it never sends it. */
  settings?: SettingsProposal;
  /** "Do these under your name?" (`ask_plan`): the actions, numbered. Allow is one OK for each of them. `summary` lists them too, for a phone that doesn't know it. */
  plan?: PlanCard;
  /** "<source> sent what it knows": Allow saves it to memory (a turn the user authorised), Deny ignores it. Its parts are `detail`. */
  handoff?: HandoffCard;
  /** "OK to go on?" between a routine's steps: Allow is Go ahead, Deny is Stop here. */
  gate?: RoutineGate;
  /**
   * "<Agent> needs you in its browser: <reason>" (`ask_user_to_step_in`).
   * Step in happens only at the Mac; the phone offers Not now (Deny), and a
   * plain Allow is refused with "Step in on your Mac". Older Macs never send it.
   */
  stepIn?: StepInCard;
  /** "Carry on with Codex until then?": Always (allow + always), Just this time (allow), Wait (deny). */
  crossover?: CrossoverAsk;
  /** "Run turns on “Personal” first?": a plain Allow / Deny; Allow makes the switch. Nothing waits on it. */
  accountSwitch?: { engine: 'claude' | 'codex'; id: string; name: string };
  /**
   * "Reply in Slack?": the exact words and the thread they go to. A plain
   * Allow / Deny over the same summary; Allow posts them as the user. Older
   * Macs never send it.
   */
  slackReply?: { channel: string; threadTs: string; place: string; text: string };
  /**
   * How risky Allow is, decided on the Mac from the classifiers the levels
   * use (`mcp::risk_of`: Bold's floor for a tool call). Only `low` is
   * answered in place (the Needs you list, a Lock Screen notification);
   * `high` opens in full with the danger icon, and absent (unclassified, an
   * older Mac, a card from before it was recorded) opens in full too. The
   * phone never works risk out from a command's text.
   */
  risk?: 'low' | 'high';
  /**
   * "Bring your work Chrome window to the front so I can use it": Allow means
   * Check again, Deny means Not now. Never a login.
   */
  front?: { site: string; account?: string };
  /**
   * A login card (`request_login`): which app, what the agent may do, and the
   * ways in, best first. Every way in runs on the Mac (`agents.loginStart`);
   * `flow` is its live state. A Mac without the `logins` feature never sends it.
   */
  login?: LoginRequest;
  /**
   * Closed by the Mac because nobody answered (status `expired`): the agent
   * moved on, the wait ran out, or a sign-in became "Maybe later". A
   * one-line receipt; never counted as waiting. Older Macs never send it.
   */
  expiry?: 'moved_on' | 'no_answer' | 'maybe_later';
}

// Logins: identical to src/lib/agentLogins.ts (desktop `agents/logins.rs`).
// Never a credential: names, abilities and the ways in only.

/** `agent_browser`: the agents' own Chrome on the Mac; the phone signs in to it from here. */
export type LoginMethod =
  | 'existing'
  | 'oauth'
  | 'claude_ai'
  | 'gh'
  | 'agent_browser'
  | 'browser'
  | 'key';

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
  /** The page the Mac's browser was asked to open, for "Open again" and "Copy link". */
  url?: string;
  /** When the Mac last asked its browser to open `url` (unix ms). */
  openedAt?: number;
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
  /** Other agents that asked for the same and joined this card: answering it answers them. */
  alsoFor?: string[];
}

/**
 * How the phone sees and drives a sign-in: a window of the agents' own
 * Chrome (screencast out, input in; no Mac permission), a tab of the
 * user's own Chrome (Claude in Chrome), or the agents' profile in a plain
 * window shown through macOS (a site that refuses a driven browser).
 */
export type SigninVia = 'agents_browser' | 'chrome' | 'mac_window';

/**
 * `agents.signinBegin`: a window of the agents' browser (or, for a card
 * without that way in, a tab of the Mac's Chrome), open on the card's site,
 * for this phone alone (`agents/phone_signin.rs`).
 */
export interface SigninBegun {
  sessionId: string;
  /** "figma.com": what the phone and the Mac's bar name. */
  domain: string;
  title: string;
  /** No input for this long and the Mac closes it. */
  idleSeconds: number;
  /** Older Macs send nothing: the user's Chrome. */
  via?: SigninVia;
  /** How long to wait between pictures. */
  frameGapMs?: number;
}

/**
 * `agents.signinFrame`: one picture of that tab. `outside`: it went
 * somewhere that isn't the sign-in, which isn't shown; only Back works.
 * `blocked`: the site refuses a browser the app drives (`blocked` says
 * why); `agents.signinFallback` offers another way.
 */
export interface SigninFrame {
  state: 'live' | 'outside' | 'blocked';
  /** The picture's number: ask for one after it. */
  seq?: number;
  /** The focused field takes a password or code: hide what's typed. */
  secure?: boolean;
  /** Why the site refuses this window. */
  blocked?: string;
  /** Where the tab is, host only. */
  host?: string;
  /** A JPEG, base64. Only when `live`. */
  image?: string;
  /** The picture's size: taps are sent in these pixels. */
  width: number;
  height: number;
}

export type SigninKey =
  | 'enter'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'escape'
  | 'space'
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_left'
  | 'arrow_right';

/**
 * What the phone does on the tab, in the frame's pixels. `type` with
 * `secure`: hidden as it was typed (a password). Never kept or logged by
 * either side; the Mac sends it only to Chrome.
 */
export type SigninInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'type'; text: string; secure?: boolean }
  | { kind: 'key'; key: SigninKey }
  | {
      kind: 'scroll';
      x: number;
      y: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount?: number;
    }
  | { kind: 'back' }
  | { kind: 'reload' };

/** `agents.signinDone`: signed in (the card answered itself), not yet, or can't tell. */
export type SigninOutcome = 'signed_in' | 'signed_out' | 'unknown';

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
    /** One of this Mac's own apps (macOS asks once; said under the list, not per row). */
    macApp?: boolean;
  }[];
  /** Absent for an agent on Codex, which has no browser. */
  /**
   * `on`: its turns get the user's Chrome (the team's browser is set up and on,
   * and this agent's wasn't taken away; never for outside text). `teamOn`: the
   * team's switch. `ownOff`: taken away from this agent.
   */
  browser?: {
    on: boolean;
    teamOn: boolean;
    ownOff: boolean;
    sites: string[];
    /** The Chrome profile (and account) each site was last found signed in to. */
    accounts?: { site: string; browser: string; account?: string }[];
    helperInstalled: boolean;
  };
  secrets: {
    secretId: string;
    name: string;
    purpose: string;
    variables: string[];
    lastUsedAt?: number;
  }[];
  /** Claude Code apps kept from this agent. */
  blockedApps: string[];
  /** Apps the user chose not to connect, team-wide; each can be turned back on. Absent from older Macs. */
  declined?: DeclinedApp[];
}

/** An app the user chose not to connect ("Not needed"); no agent asks for it again. */
export interface DeclinedApp {
  /** The catalogue id, or `other:<title>` for an app it doesn't know. */
  key: string;
  title: string;
  declinedAt: number;
}

/** What a "Not needed" did: its one-line receipt, and the keys an Undo turns back on. */
export interface DeclineReceipt {
  keys: string[];
  line: string;
  /** Waiting cards it put away. */
  closed: number;
}

/** One of the apps the Mac signs in to itself (desktop `app_connect::CatalogueApp`). */
export interface ConnectableApp {
  /** The catalogue's id: "linear". */
  service: string;
  title: string;
  /** What reading lets an agent do. */
  read: string;
  /** What a full grant adds (each time, on a card). */
  write: string;
  /** The connector's host. */
  host: string;
}

/** Who may use a connection, and how. */
export interface AppGrant {
  agentId: string;
  access: 'read' | 'full';
}

/** Where a connection's sign-in is kept: this Mac's Keychain, the GitHub CLI, or claude.ai. */
export type AppConnectionKind = 'oauth' | 'gh' | 'claude_ai';

/** A connection as the phone sees it (`app_connect::PhoneConnection`). Never a token. */
export interface AppConnection {
  connectionId: string;
  service: string;
  title: string;
  account: string;
  kind: AppConnectionKind;
  grants: AppGrant[];
  /** The last sign-in stopped working: it needs signing in again. */
  needsSignIn?: boolean;
  lastUsedAt?: number;
}

/** A connect from the apps screen, under way, failed or stopped, or just done. */
export interface AppConnectFlow {
  service: string;
  /** On a phone, `url` only for its own sheet, never the Mac browser's page. */
  flow?: LoginFlow;
  connected?: { connectionId: string; line: string };
}

/** `agents.apps`: "Apps your agents can use". */
export interface AppsOverview {
  apps: ConnectableApp[];
  connections: AppConnection[];
  flows: AppConnectFlow[];
}

/** `agents.appsPhoneBegin`: what the phone opens. No secret: the PKCE verifier stays on the Mac. */
export interface AppPhoneBegin {
  flowId: string;
  service: string;
  /** The provider's authorization URL, for the system sign-in sheet. */
  url: string;
  /** The companion app's own redirect, which the sheet hands back. */
  redirectUri: string;
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

/**
 * A login the imported agents mentioned, one row per service (desktop
 * `agents/access_check.rs`): reached on this Mac, or the residue.
 */
export type TeamSetupLaterState =
  | { state: 'open' }
  | { state: 'reachable'; via: string }
  | { state: 'not_needed' }
  | { state: 'asked'; agentId: string; requestId: string };

export type TeamSetupLater = {
  key: string;
  /** The catalogue's id, or `other`. */
  service: string;
  title: string;
  agents: string[];
  agentIds: string[];
  /** The one button: "Connect Figma", "Use my browser", "Get your key". */
  action?: string;
  /** A key is the only way in. */
  keyOnly: boolean;
} & TeamSetupLaterState;

/** "Checking what your team can already reach", live. */
export interface TeamSetupCheck {
  running: boolean;
  total: number;
  checked: { title: string; reached: boolean }[];
  /** The browser was part of it. */
  browser: boolean;
  finishedAt?: number;
}

export interface TeamSetupStep {
  id: TeamSetupStepId;
  state: TeamSetupStepState;
  logins?: TeamSetupLogin[];
  /** Logins step: one row per service the imported agents mentioned. */
  later?: TeamSetupLater[];
  /** Logins step: the check, while it runs and once it's done. */
  check?: TeamSetupCheck;
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

/** What an import got out of the other assistant, area by area (`agents/coverage.rs`). */
export interface ImportCoverage {
  areas: {
    area: string;
    label: string;
    /** Facts gathered in this area. */
    facts: number;
    /** It said it has none. */
    none?: boolean;
    /** What's missing, when it isn't confirmed complete. */
    gap?: string;
  }[];
  /** Mentioned in passing and never followed up. */
  openMentions?: string[];
  /** The message limit ended it before everything was covered. */
  capped?: boolean;
}

/** An outside assistant's handover over `ask_chief`, collected into one card (`agents/handoff.rs`). */
export interface HandoffCard {
  source: string;
  parts: number;
}

export interface ImportReview {
  proposals: ImportProposal[];
  chiefNotes?: string;
  summary?: string;
  /** What it gathered by area and every gap; what it gathered is in `chiefNotes`. */
  coverage?: ImportCoverage;
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
  /** A recipe's key look and the independence it suggests (applied only when stricter). */
  look?: { colorway?: string; icon?: string; key?: string; independence?: AgentIndependence };
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
  /** On a note: "Remembered: Lead Gen can always …", with Undo (`agents.revokePermission`) while active. */
  remembered?: RememberedRule;
  /**
   * Came in from Slack (`agents/slack.rs`): on the user's own message, written
   * there ("From Slack · #launch"); on a note, someone else's (`from`).
   * Older Macs never send it.
   */
  via?: MessageVia;
  /**
   * On a note: the one fix it names (`agents/chrome_health.rs`):
   * `user_chrome` is Settings → Agents → Your Chrome on the Mac. The phone
   * shows the note's text, which names where. Older Macs never send it.
   */
  fix?: 'user_chrome' | 'user_chrome_check' | 'disk';
  /**
   * Which of the agent's conversations it was said in (`conversationOf`).
   * Absent on lines from before there were several: the first one's.
   */
  conversation?: string;
  /**
   * Links in the reply to a server on this Mac (`http://localhost:3400`),
   * taken out of the text by the Mac (`agents/local_links.rs`). One the Mac
   * knows serves a project offers Preview (desk) and Watch live (phone);
   * any other is a plain "running on this Mac" chip, never a dead link.
   */
  localLinks?: LocalLink[];
}

/** A link an agent wrote to a server on this Mac (`AgentMessage.localLinks`). */
export interface LocalLink {
  /** As the agent wrote it. Only ever opened on the Mac itself. */
  url: string;
  /** The link's own text, else the host and port ("localhost:3400"). */
  label: string;
  port: number;
  /**
   * The folder whose dev server answers on that port, when the app knows one
   * does: a project, or an agent's copy of one. Absent: nothing the app knows.
   */
  path?: string;
  /** The user's project that folder is (or is a copy of). */
  project?: string;
  /** `path` is an agent's copy of `project`. */
  copy?: boolean;
}

/** The rule behind a "Remembered: …" line. */
/** Where a message came in from, when not the app itself. */
export interface MessageVia {
  /** `slack`. */
  source: string;
  place: string;
  from?: string;
}

/** "From Slack · #launch", or null. */
export function viaLabel(via: MessageVia | undefined | null): string | null {
  if (!via) return null;
  const source = via.source === 'slack' ? 'Slack' : via.source;
  return via.place ? `From ${source} · ${via.place}` : `From ${source}`;
}

export interface RememberedRule {
  ruleId: string;
  /** For every agent, not just this one. */
  team?: boolean;
  /** Still in force; false once undone, on the phone or the desk. */
  active: boolean;
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
  /** Its key's colourway, legend and bound key (agentKeys.ts); older Macs ignore them. */
  colorway?: string;
  icon?: string;
  boundKey?: string;
  role?: string;
  instructions?: string;
  engine?: AgentEngine;
  model?: string;
  project?: string;
  template?: string;
  /** Routines to set up with it (the ones kept from a draft). */
  routines?: NewRoutine[];
  /** From a draft: its welcome, first tasks and the apps its job needs (`openingOf`). */
  welcome?: string;
  starters?: StarterIdea[];
  apps?: string[];
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
  /** Its key's colourway, legend and bound key (agentKeys.ts); older Macs ignore them. */
  colorway?: string;
  icon?: string;
  boundKey?: string;
  role?: string;
  instructions?: string;
  pinned?: boolean;
  hidden?: boolean;
  muted?: boolean;
  engine?: AgentEngine;
  model?: string;
  routineModel?: string;
  /** `low` / `medium` / `high`, or '' for the engine's default. */
  effort?: AgentEffort | '';
  project?: string;
  workDirectly?: boolean;
  /** "Runs on": an account id of its engine, or '' for any account. */
  account?: string;
}

/** What `agents.create` / `agents.update` return: the stored agent, no live state. */
export type StoredAgent = Omit<Agent, 'status' | 'home' | 'ranOn'>;

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
  /** The agent's conversation it was said in: the hit opens it first. Absent for a room's line, or from an older Mac. */
  conversation?: string;
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
  /**
   * As it is shown: the user's name for it; else, for this Mac's own
   * sign-in, who it is signed in as (as the engine recorded it); else
   * "Signed in on this Mac". Older Macs send "This Mac".
   */
  name: string;
  /** The user named it. Absent from older Macs. */
  named?: boolean;
  thisMac: boolean;
  signedIn: boolean;
  /** Who it is signed in as, as the engine recorded it; absent when unknown. */
  email?: string;
  /** The plan's name, only when the engine's own file names it ("Max", "plus"). */
  plan?: string;
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
  /**
   * Windows that would reach 100% at the recent rate before they reset: an
   * ESTIMATE from this account's own readings (`agents::forecast::Pace`).
   * Absent when there's none to say (too few readings, flat use, a crossing
   * after the reset), and from Macs that predate it.
   */
  pace?: UsagePace[];
  /**
   * How the Mac's last check of this account without a turn went
   * (`agents::usage_read`, every 10 minutes while it's open). Absent before
   * the first check, and from Macs that predate it.
   */
  check?: UsageCheck;
  /**
   * The name of an account earlier in the order that this one is a second
   * sign-in of (the same Claude organization, or the same ChatGPT user and
   * workspace, as the engines recorded it). It adds no room. Absent from
   * Macs that predate it, and whenever that isn't known.
   */
  sameAs?: string;
  /**
   * An account earlier in the order this one *may* be the same account as:
   * their weekly readings moved together with the same reset while only one
   * ran turns. A question, never counted. Newer Macs only.
   */
  maybeSameAs?: string;
  /** The organization's name, when the engine recorded it. */
  orgName?: string;
  /** Who used it in the last 7 days, from the turns this app ran on it. */
  spent?: UsageRun[];
  /**
   * "Where did my usage go": each recent rise in its 5-hour and weekly
   * meters, newest first, with the turns this app ran on it in that time.
   */
  changes?: UsageChange[];
}

/** Turns one agent (or one routine of it) ran on an account (`agents::usage_story`). */
export interface UsageRun {
  agentId: string;
  /** The agent's name now; "An agent since deleted" when it is gone. */
  name: string;
  /** The routine's first line, when these turns each ran it alone. */
  routine?: string;
  turns: number;
  /** As the engines reported them. */
  tokens: number;
}

/**
 * One rise in a window's meter and what this app ran on the account while
 * it rose. Points are never split between runs: only their tokens are
 * known. `nothingHere`: nothing this app ran explains it (said only once
 * the Mac was recording turns), so it was used elsewhere.
 */
export interface UsageChange {
  kind: string;
  windowMinutes?: number;
  from: number;
  to: number;
  since: number;
  until: number;
  runs: UsageRun[];
  nothingHere: boolean;
}

/** One check of an account's limits without a turn. */
export interface UsageCheck {
  at: number;
  /**
   * `read`: its windows are from this check. `no_plan`: the engine said this
   * login has no plan limits. `cant_read`: it can't be read without a turn
   * (its next turn reports them). `failed`: no answer this time.
   */
  outcome: 'read' | 'no_plan' | 'cant_read' | 'failed';
  why?: string;
  /**
   * `headers`: read from the rate-limit headers of a one-token request (a
   * setup-token Claude sign-in, which the usage endpoint refuses). Absent:
   * the engine's own usage read. Absent from Macs that predate it.
   */
  via?: 'headers';
}

/** An account and a time (a reset, or when it has room again). */
export interface UsageAccountAt {
  engine: AgentEngine;
  accountId: string;
  accountName: string;
  at: number;
}

/**
 * Every account at once (`agents::compute::Totals`). Room is only what a
 * reading said: an account with no reading is "not read", never counted as
 * having room.
 */
export interface ComputeTotals {
  /** Every account listed. */
  accounts: number;
  /** Of those, signed in (one not signed in is never "not read"). Absent from older Macs. */
  signedIn?: number;
  engines: { engine: AgentEngine; accounts: number; read: number; room: number }[];
  /** With a current reading. */
  read: number;
  /** With room now, by that reading. */
  room: number;
  /** 5-hour (`session`) then weekly; a kind no account reported is absent. */
  windows: {
    family: 'session' | 'weekly';
    read: number;
    room: number;
    soonestReset?: UsageAccountAt;
  }[];
  /** Of the accounts without room, the soonest one has room again. */
  nextRoom?: UsageAccountAt;
  /**
   * An ESTIMATE: an engine that runs out on every one of its accounts at the
   * recent pace, before any resets. Only with 2+ accounts, every one read.
   */
  runOut?: {
    estimate: true;
    engine: AgentEngine;
    reachesAt: number;
    readings: number;
    accounts: number;
  }[];
}

/**
 * When a window runs out at the recent rate, by estimate: the straight line
 * through at least 3 of the account's readings of this instance of the
 * window, over at least 30 minutes, extended from the latest. Only ever sent
 * when it lands after now and before the reset. Never a reading.
 */
export interface UsagePace {
  estimate: true;
  /** The window it is for (`five_hour`, `seven_day`, `primary`, …). */
  kind: string;
  /** That window's reported reset, epoch ms. */
  resetsAt: number;
  /** When it would reach 100%, epoch ms. */
  reachesAt: number;
  /** How many readings, over how many minutes, it rests on. */
  readings: number;
  spanMinutes: number;
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
  /** Every account at once. Absent from Macs that predate it. */
  totals?: ComputeTotals;
  /**
   * This Mac's own sign-in became another account and the one it was isn't
   * connected any more, until the user answers it. Absent when there is
   * none, and from Macs that predate it.
   */
  signInChanges?: SignInChange[];
  now: number;
}

/** This Mac's own sign-in to an engine is now another account (`sameAccount.ts`). */
export interface SignInChange {
  engine: AgentEngine;
  /** Answering it sends this back; it carries no account id. */
  key: string;
  /** When the new sign-in was first seen. */
  at: number;
  nowEmail?: string;
  nowOrgName?: string;
  /** Only when recorded while that account was the one signed in. */
  beforeEmail?: string;
  beforeOrgName?: string;
  /** A weekly reset the previous account reported. */
  beforeWeeklyReset?: number;
  nowWeeklyReset?: number;
  /** Nothing named the previous account: only its weekly reset, which moved. */
  byReset: boolean;
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

/** One agent an export or pasted reply holds (`agents/import_export.rs`). Identical to src/lib/agents.ts. */
export interface ExportImportAgent {
  name: string;
  role: string;
  instructionsChars: number;
  memoryLines: number;
  routines: number;
  watches: number;
  apps: number;
}

/** What a pasted reply holds, what's still missing and the message that asks for it. */
export interface ExportImportPreview {
  source: string;
  format: string;
  verified: boolean;
  agents: ExportImportAgent[];
  main: string | null;
  about: [string, number][];
  problems: string[];
  refused: string[];
  gaps: string[];
  followUp: string | null;
  masked: number;
  read: string[];
  skipped: string[];
}

/** Where the review card went. */
export interface ExportImportPosted {
  chiefId: string;
  requestId: string;
  agents: number;
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

/**
 * A notification the Mac decided this device should show
 * (`companion/alerts.rs`). Ids and one plain line, already redacted.
 */
export interface Alert {
  agentId: string;
  /**
   * The message it's about, so tapping opens the chat there and a second
   * alert for it replaces the first. Absent for a line no message holds.
   */
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
