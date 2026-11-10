/**
 * The "When…" composer's words and rules, shared by the desk's
 * (`AgentWhenRoutine`) and the phone's (`components/whenComposer.tsx`), so a
 * "When…" routine is set up in the same words, with the same choices, on
 * either. Backend: `src-tauri/src/agents/watch.rs`.
 *
 * GitHub and folders are checked for free; an app source (Linear, anything
 * else) is a short read-only model call per check, at least 15 minutes
 * apart and at most 24 a day, sealed to that one app (`watch_seal.rs`).
 */

import type { WatchSource } from './model';
import { DEFAULT_MAX_CHECKS_PER_DAY, describeEvery, describeWatchSource } from './schedule';

export type WhenKind = Exclude<WatchSource['kind'], 'unknown'>;

/** "At a time / When…": the kind of a new routine. */
export type RoutineMode = 'time' | 'when';
export const ROUTINE_MODES: { value: RoutineMode; label: string }[] = [
  { value: 'time', label: 'At a time' },
  { value: 'when', label: 'When…' },
];

/** The composer's labels, in the order they appear. */
export const WHEN_WORDS = {
  source: 'When this happens',
  every: 'Check every',
  through: 'Through',
  what: 'What',
  folderPlaceholder: 'Folder, e.g. ~/Downloads/invoices',
  checkPlaceholder: 'What to look for, e.g. a new email from dana@acme.com',
  whatPlaceholder: 'Triage it and tell me if it’s urgent',
  firstCheck: 'The first check only notes what’s already there, so nothing old starts work.',
} as const;

export interface WhenSourceChoice {
  kind: WhenKind;
  label: string;
  /** How it's checked, and what that costs. */
  how: string;
}

/**
 * The sources, in plain words. `mac` is where it's said from: "this Mac" on
 * the desk, "your Mac" on the phone.
 */
export function whenSources(mac: 'this Mac' | 'your Mac' = 'this Mac'): WhenSourceChoice[] {
  return [
    {
      kind: 'github_mentions',
      // "you", as the routine reads back once added ("When someone mentions you…").
      label: 'Someone mentions you on GitHub',
      how: `Free · checked from ${mac}`,
    },
    {
      kind: 'github_assigned',
      label: 'An issue or PR is assigned to you',
      how: `Free · checked from ${mac}`,
    },
    {
      kind: 'linear_assigned',
      label: 'A Linear issue is assigned to you',
      how: 'Through your Linear app · uses a little of your usage each check',
    },
    { kind: 'new_file', label: 'A new file appears in a folder', how: 'Free · reads the folder' },
    {
      kind: 'custom',
      label: 'Something else…',
      how: 'You say what, in one app · uses a little of your usage each check',
    },
  ];
}

/** How often each kind of source can be checked: a folder is free, a model check isn't. */
export function whenIntervals(kind: WhenKind): number[] {
  if (kind === 'new_file') return [1, 5, 10, 30];
  if (kind === 'github_mentions' || kind === 'github_assigned') return [5, 10, 30, 60];
  return [15, 30, 60, 240];
}

/** The intervals offered: the kind's own, plus the routine's current one when it's off them. */
export function whenIntervalChoices(kind: WhenKind, every: number): number[] {
  const offered = whenIntervals(kind);
  return offered.includes(every) ? offered : [...offered, every].sort((a, b) => a - b);
}

export const DEFAULT_WHEN_EVERY = 10;
/** An app check's default: each one is a model call. */
export const DEFAULT_WHEN_MODEL_EVERY = 30;

export const whenKindUsesModel = (kind: WhenKind) =>
  kind === 'linear_assigned' || kind === 'custom';

/** The interval after picking `next` over `prev`: a model check starts at 30 min. */
export function everyAfterPick(prev: WhenKind, next: WhenKind, every: number): number {
  const allowed = whenIntervals(next);
  if (whenKindUsesModel(next) && !whenKindUsesModel(prev)) return DEFAULT_WHEN_MODEL_EVERY;
  if (every < allowed[0])
    return allowed.includes(DEFAULT_WHEN_EVERY) ? DEFAULT_WHEN_EVERY : allowed[0];
  return every;
}

/** "10 min", "1 hour": the interval chips, after "Check every". */
export function shortEvery(minutes: number): string {
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`;
  return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

/** The source the composer would save. */
export function whenSourceOf(
  kind: WhenKind,
  folder: string,
  check: string,
  app: string
): WatchSource {
  if (kind === 'new_file') return { kind, folder };
  if (kind === 'custom') return { kind, check, app };
  return { kind };
}

/** What the composer still needs before it can add, in its words; `null` when nothing. */
export function whenMissing(kind: WhenKind, folder: string, check: string, app: string) {
  if (kind === 'new_file' && !folder.trim()) return 'Which folder?';
  if (kind === 'custom' && !check.trim()) return 'What should it look out for?';
  if (kind === 'custom' && !app) return 'Which app should it check?';
  return null;
}

/**
 * The echo, as the time picker's: what it waits for, then what it does
 * ("When someone mentions you on GitHub — Triage it"). A check in the user's
 * own words is quoted, so it reads whatever they typed.
 */
export function whenEcho(agentName: string, source: WatchSource, note: string): string {
  const waitsFor =
    source.kind === 'custom'
      ? `When ${agentName} finds “${describeWatchSource(source)}”`
      : `When ${describeWatchSource(source)}`;
  const what = note.trim().replace(/\s+/g, ' ');
  return what ? `${waitsFor} — ${what}` : waitsFor;
}

/** Model checks a day at this interval, at most the cap. */
export function whenChecksPerDay(every: number): number {
  return Math.min(Math.floor((24 * 60) / Math.max(every, 1)), DEFAULT_MAX_CHECKS_PER_DAY);
}

/** What each check costs, said before it's added. */
export function whenCost(agentName: string, source: WatchSource, every: number): string {
  return source.kind === 'linear_assigned' || source.kind === 'custom'
    ? `Each check uses a little of ${agentName}’s usage and can only read that app, up to ${whenChecksPerDay(every)} a day.`
    : 'Checks are free.';
}

/** The line under the echo: what it costs, and that the first check fires nothing. */
export function whenReadback(agentName: string, source: WatchSource, every: number): string {
  return `${whenCost(agentName, source, every)} ${WHEN_WORDS.firstCheck}`;
}

/** Said in place of "Through" when the agent has no app a check can read. */
export function whenNoApps(agentName: string): string {
  return `It checks through an app connected under Apps and given to ${agentName}. Apps connected on claude.ai can’t be used here.`;
}

/** The "Check every" chips' spoken label: "every 10 min". */
export const whenEverySpoken = describeEvery;

/* ------------------------------------------------- apps a check can read */

/** An app a check can read through: `value` is what the routine saves as `app`. */
export interface WhenApp {
  value: string;
  label: string;
}

/** What `whenApps` reads of one of our own connections (`connections::Connection`). */
export interface WhenConnection {
  service: string;
  title: string;
  account: string;
  kind: { type: string };
  serverKey: string;
  needsSignIn?: boolean;
  grants: { agentId: string }[];
}

/** What `whenApps` reads of one of Claude Code's own servers (`apps::App`). */
export interface WhenClaudeApp {
  name: string;
  target: string;
  source: 'user' | 'claudeAi' | 'other' | string;
  /** As Claude Code reported it: `connected`, `needs_auth`, `error` or `unknown`. */
  status?: string;
}

/** A Claude Code app's name, as people say it ("google-drive" → "Google Drive"). */
export function appTitle(app: { name: string; source: string }): string {
  if (app.source === 'claudeAi') return app.name.replace(/^claude\.ai\s+/, '');
  // Config keys are lowercase ids ("figma", "google-drive"); show them as names.
  return app.name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The apps `agentId`'s check can read through, ours first: our own
 * connections given to this agent and signed in (by server key, the name its
 * tools carry), then servers set up in Claude Code itself. A claude.ai
 * connector can't be loaded into the sealed check. `linear`: whether either
 * has Linear.
 */
export function whenApps(
  agentId: string,
  connections: WhenConnection[],
  claude: WhenClaudeApp[]
): { apps: WhenApp[]; linear: boolean } {
  const ours = connections.filter(
    (c) => c.kind.type === 'oauth' && !c.needsSignIn && c.grants.some((g) => g.agentId === agentId)
  );
  const title = (c: WhenConnection) =>
    ours.filter((o) => o.title === c.title).length > 1 ? `${c.title} (${c.account})` : c.title;
  const theirs = claude.filter(
    (a) => a.source !== 'claudeAi' && !ours.some((c) => c.serverKey === a.name)
  );
  return {
    apps: [
      ...ours.map((c) => ({ value: c.serverKey, label: title(c) })),
      ...theirs.map((a) => ({ value: a.name, label: appTitle(a) })),
    ],
    linear:
      ours.some((c) => c.service === 'linear') ||
      theirs.some((a) => /linear/i.test(a.name) || /linear\.app/i.test(a.target)),
  };
}

/** The sources offered: Linear only when this agent can read a Linear app. */
export function whenSourceChoices(
  hasLinear: boolean,
  mac: 'this Mac' | 'your Mac' = 'this Mac'
): WhenSourceChoice[] {
  return whenSources(mac).filter((s) => s.kind !== 'linear_assigned' || hasLinear);
}

/* ------------------------------------------------- Check now */

/** What Check now came to; mirrors `watch::CheckOutcome`. */
export interface WatchCheckOutcome {
  found: number;
  baseline: boolean;
  /** A model check found nothing before its baseline; the next check confirms it. */
  unconfirmed?: boolean;
  error?: string;
  paused?: string;
  /** A model check: what it ran on ("Claude Code", "Codex"). */
  engine?: string;
}

/** What Check now came to, in a line; a model check says what it ran on. */
export function describeWatchCheck(o: WatchCheckOutcome): string {
  if (o.paused) return o.paused;
  if (o.error) return `Check failed: ${o.error}`;
  const on = o.engine ? ` Checked on ${o.engine}.` : '';
  if (o.baseline) return `Noted what’s there now; anything new from here starts work.${on}`;
  if (o.unconfirmed)
    return `Found nothing. The next check confirms that before anything starts work.${on}`;
  if (o.found > 0) return `Found ${o.found} new; it’s on it.${on}`;
  return `Nothing new.${on}`;
}

/* ------------------------------------------------- what the Mac offers */

/** A folder on the Mac a "new file" routine can watch, from the phone. */
export interface WhenFolder {
  /** Absolute, as the routine saves it. */
  path: string;
  /** "~/Downloads". */
  label: string;
}

/**
 * What the phone's composer may offer for one agent (`agents.watch.options`):
 * the apps its check could read through (read by `whenApps`, as the desk
 * does) and the folders on the Mac a phone may pick from.
 */
export interface WatchOptions {
  connections: WhenConnection[];
  claudeApps: WhenClaudeApp[];
  folders: WhenFolder[];
}
