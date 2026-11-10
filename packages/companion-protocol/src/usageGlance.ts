/**
 * Usage at a glance and in full: the stack of accounts agents run on, as
 * the desk's sidebar meter and Usage view and the phone's Usage screen say
 * it, worded once here so the two never disagree. Pure.
 *
 * The rules (Never Assume Data):
 * - **Room is only what a reading said.** Each account is a segment of the
 *   stack, filled to what is left of its tighter limit (5-hour or weekly).
 *   An account with no reading is an empty, dashed segment, never full.
 * - **A second sign-in of the same account** (`UsageAccountLine.sameAs`,
 *   from the engines' own records) adds no room: its key says so plainly
 *   with the one fix, and the meter leaves it out, with one line under it
 *   instead (`meterKeys`, `sameNotes`; words in `sameAccount.ts`).
 * - **This Mac's sign-in became another account** and the one it was isn't
 *   connected: said once, until answered (`signInChanged`).
 * - **Estimates say so.** The one forward-looking line ("Runs out ~Thu") is
 *   the Mac's estimate across accounts (`totals.runOut`), labelled, and
 *   absent with too little history.
 * - **"Where did my usage go"** lists what this app ran while a meter rose
 *   and never splits points between runs; when nothing here ran, it says the
 *   account was used elsewhere.
 */

import type {
  AgentEngine,
  QuotaWindow,
  UsageAccount,
  UsageAccountLine,
  UsageChange,
  UsageInventory,
  UsagePace,
  UsageRun,
} from './model';
import { QUOTA_WARN_PERCENT, resetPhrase } from './quota';
import { planLabel } from './usage';
import { roughWhen } from './usageSheet';
import { accountLabel, switcherView, type SwitcherRow } from './accountSwitcher';
import { sameAccountLine, sameAccountNote, signInChangedText } from './sameAccount';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** At or under this much left, an account is low. */
export const LOW_LEFT = 10;
/** At or over this much left on the account in use, there is plenty. */
export const PLENTY_LEFT = 50;

/** "Out of usage": the one phrase for an account at its limit, everywhere. */
export const OUT_OF_USAGE = 'Out of usage';

export type AccountKeyState = 'in_use' | 'next' | 'ready' | 'out' | 'off' | 'same' | 'unread';
export type KeyTone = 'calm' | 'warning' | 'limited' | 'quiet';

/** One limit of an account, as its card draws it. */
export interface KeyLimit {
  key: string;
  /** "5-hour", "Weekly". */
  label: string;
  /** 0–100 left, never more than reported. */
  left: number;
  tone: 'calm' | 'warning' | 'limited';
  /** "in 3 h", "in 5 days"; absent when no reset was reported. */
  resetsIn?: string;
  /** "3:20 PM", "Sat 10:00 AM". */
  resetsAt?: string;
  /** The Mac's estimate for this limit, said as one. */
  pace?: { text: string; basis: string };
  /** A per-model limit ("Weekly · Opus"): it stops only that model, so the key's room leaves it out. */
  model?: boolean;
  /** "3d 12h" until it refills. */
  countdown?: string;
  /** What would be left now had it been spent evenly through the window (the pace marker), 0–100. */
  evenLeft?: number;
  paceState?: 'ahead' | 'on' | 'under';
  /** "On pace — lasts until it refills", "Ahead of pace — at this rate it runs out Thu, 2 days before it refills". */
  paceWord?: string;
  /** The Mac's estimate of when it runs out, before the reset: `along` the time left, 0 now to 1 the reset. */
  runOut?: { at: number; along: number; text: string };
}

/** One rise in a meter, said for "Where did my usage go". */
export interface ChangeLine {
  key: string;
  /** "Weekly 68% → 33% left": said as what is left, as every figure is. */
  title: string;
  /** "Sat 11:40 PM – Sun 7:10 AM". */
  when: string;
  /** "Riley · 3 turns · 1.2M tokens", "Max: Morning brief · 1 turn · 300k tokens". */
  runs: string[];
  /** When nothing this app ran explains it. */
  elsewhere: string | null;
}

/** One account as a key in the stack. */
export interface StackKey {
  key: string;
  engine: AgentEngine;
  id: string;
  name: string;
  /** Its place in its engine's order, from 1. */
  position: number;
  /** What tells it apart: plan, organization, who it's signed in as, this Mac's own. */
  detail: string[];
  state: AccountKeyState;
  /** "In use", "Next", "Ready", "Out of usage until Sat 10:00 AM", "Not signed in", "Same account", "No reading yet". */
  stateLabel: string;
  /** The account it is a second sign-in of, by the name that one's key shows. */
  sameAs: string | null;
  /** The limit that stops its turns first, with its pace marker and countdown; null when it has no room or no reading. */
  tight: KeyLimit | null;
  /** Left of its tighter limit, 0–100; null with no reading (or adding no room). */
  left: number | null;
  tone: KeyTone;
  limits: KeyLimit[];
  /** "Riley · 1.2M tokens · 14 turns", this week, most first. */
  spent: string[];
  changes: ChangeLine[];
  /**
   * The one fix for a sign-in problem. A duplicate's (`sign_in_other`) can
   * also be removed, unless it is this Mac's own sign-in.
   */
  fix: { action: 'sign_in' | 'sign_in_other' | 'remove'; text: string } | null;
  canUse: boolean;
  signedIn: boolean;
  thisMac: boolean;
  pinnedBy: string[];
}

export interface StackEngine {
  engine: AgentEngine;
  label: string;
  keys: StackKey[];
}

/** A window near its reset with room left, on the account agents use next. */
export interface SpareNudge {
  /** "62% of Work’s week resets in 9 h". */
  text: string;
  question: string;
  /** What it would spend it on: the waiting items, first few. */
  items: string[];
  more: number;
  /** Nothing waiting: the list needs something first. */
  empty: boolean;
}

/** Every account nearly or wholly out: the options, calmly. */
export interface LowBar {
  text: string;
  /** "Wait until Sat 10:00 AM", when a reset was reported. */
  waitUntil: string | null;
  /** Another engine has room, by reading. */
  otherEngine: AgentEngine | null;
}

/** This Mac's own sign-in is another account now: said once, until answered. */
export interface SignInChangedNotice {
  engine: AgentEngine;
  /** Sent back when it's answered (`agents_usage_sign_in_seen`). */
  key: string;
  text: string;
}

/**
 * The glance in plain words, for the sidebar row and the phone's Agents
 * list: what the agents can still do and when it refills, in words anyone
 * reads. "Usage" is the label the row carries; these are its figures.
 */
export interface GlanceRowWords {
  /** "57% left this week", "57% left for now", "Out of usage", "Not checked yet". */
  figure: string;
  /** "Refills in 3d 12h" ("Refills Sat 10:00 AM" when out); absent when no reset was reported. */
  refill: string | null;
  /** "2 accounts": only with more than one real account. */
  count: string | null;
  /** The user has something to do (nearly out everywhere, nothing signed in). */
  needsYou: boolean;
}

/** The figure that matters: the tighter limit of the account in use (else the roomiest), and its refill. */
function rowWords(
  keys: StackKey[],
  counted: StackKey[],
  read: StackKey[],
  roomy: StackKey[],
  tone: 'calm' | 'warning' | 'limited',
  back: number | null,
  soonest: { resetsAt: string } | null,
  now: number
): GlanceRowWords {
  const count = counted.length > 1 ? plural(counted.length, 'account') : null;
  const needsYou = tone === 'warning';
  if (counted.length === 0) {
    return {
      figure: keys.length === 0 ? 'No accounts yet' : 'Not signed in',
      refill: null,
      count,
      needsYou: true,
    };
  }
  if (read.length === 0) return { figure: 'Not checked yet', refill: null, count, needsYou };
  if (roomy.length === 0) {
    const at = back ? resetPhrase(back, now) : (soonest?.resetsAt ?? null);
    return { figure: OUT_OF_USAGE, refill: at ? `Refills ${at}` : null, count, needsYou };
  }
  const using =
    roomy.find((k) => k.state === 'in_use') ??
    roomy.reduce((a, b) => ((b.left ?? 0) > (a.left ?? 0) ? b : a));
  const tight = using.tight;
  const left = tight?.left ?? using.left ?? 0;
  return {
    figure: `${left}% left ${tight?.label === 'Weekly' ? 'this week' : 'for now'}`,
    refill: tight?.countdown ? `Refills in ${tight.countdown}` : null,
    count,
    needsYou,
  };
}

export interface UsageGlance {
  engines: StackEngine[];
  /** The row's plain words: what's left, when it refills. */
  row: GlanceRowWords;
  /** Every key, engine by engine, in order. */
  keys: StackKey[];
  /** The keys the meter draws: a second sign-in of an account adds no segment. */
  meterKeys: StackKey[];
  /** One line each for those left out: "Personal is the same Claude account as Work — adds no extra room". */
  sameNotes: string[];
  signInChanged: SignInChangedNotice | null;
  /** "Plenty of room", "Runs out ~Thu, 2 days before reset", "Out of usage until 3:20 PM". */
  headline: string;
  /**
   * Signed in but nothing read yet: the headline is a quiet line, not the
   * display figure (the biggest type on the page is for a reading).
   */
  unread: boolean;
  /** The headline is an estimate: what it rests on. */
  estimate: string | null;
  /**
   * Warning only when the user has a choice to make (nearly out everywhere,
   * nothing signed in); an estimate or a handover to the next account is
   * calm. Amber means "needs you".
   */
  tone: 'calm' | 'warning' | 'limited';
  /** "2 accounts · resets Sat 10:00 AM". */
  summary: string;
  /** The soonest reset of any read account's limit. */
  soonest: { label: string; resetsIn: string; resetsAt: string; account: string } | null;
  nudge: SpareNudge | null;
  /**
   * Who used the accounts this week, most first, from the turns this app ran
   * (tokens as the engines reported them): the Tokens view. Never a cost.
   */
  burning: BurnLine[];
  low: LowBar | null;
}

/** "in 40 min", "in 9 h", "in 3 days". */
export function relativeIn(at: number, now = Date.now()): string {
  const ahead = Math.max(0, at - now);
  if (ahead < HOUR_MS) return `in ${Math.max(1, Math.round(ahead / MINUTE_MS))} min`;
  if (ahead < 48 * HOUR_MS) return `in ${Math.round(ahead / HOUR_MS)} h`;
  return `in ${Math.round(ahead / DAY_MS)} days`;
}

/** "1.2M", "300k", "900". */
export function tokensShortly(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const isSession = (w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>) =>
  w.kind === 'five_hour' || w.windowMinutes === 300;
const isWeek = (w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>) =>
  w.kind === 'seven_day' || w.windowMinutes === 7 * 24 * 60;
const live = (w: QuotaWindow, now: number) => w.resetsAt === undefined || w.resetsAt > now;
const leftOf = (w: QuotaWindow) =>
  w.limited ? 0 : 100 - Math.max(0, Math.min(100, Math.ceil(w.usedPercent ?? 0)));

function paceFor(paces: UsagePace[] | undefined, w: QuotaWindow, now: number) {
  const p = paces?.find(
    (x) =>
      x.kind === w.kind &&
      w.resetsAt !== undefined &&
      Math.abs(x.resetsAt - w.resetsAt) <= 30 * MINUTE_MS
  );
  if (!p || p.estimate !== true || !(p.reachesAt > now) || !(p.reachesAt < p.resetsAt)) {
    return undefined;
  }
  const m = p.spanMinutes;
  const span =
    m < 90
      ? `${m} minutes`
      : m < 48 * 60
        ? `${Math.round(m / 60)} hours`
        : `${Math.round(m / 1440)} days`;
  return {
    text: `At this pace it runs out ${roughWhen(p.reachesAt, now)}`,
    basis: `Estimate from ${p.readings} readings over ${span}`,
  };
}

/** How long a window is, from what the engine said; null when it didn't. */
export function windowLength(w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>): number | null {
  if (w.windowMinutes && w.windowMinutes > 0) return w.windowMinutes * MINUTE_MS;
  if (w.kind === 'five_hour') return 5 * HOUR_MS;
  if (w.kind.startsWith('seven_day')) return 7 * DAY_MS;
  return null;
}

/** "3d 12h", "4h 20m", "35m": until a reset. */
export function countdown(at: number, now: number): string {
  const ms = Math.max(0, at - now);
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / HOUR_MS);
  const m = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** A per-model weekly limit's model: `seven_day_opus` → "Opus". */
function modelOf(kind: string): string | null {
  const m = /^seven_day_(.+)$/.exec(kind);
  if (!m) return null;
  return m[1]
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/** More than this many points from even, it is ahead or under pace. */
const PACE_SLACK = 5;

/**
 * Where a limit stands against time: what would be left had it been spent
 * evenly through the window (the pace marker), whether it is ahead (spent
 * faster than time passed), on or under pace, and in words what that means.
 * The run-out, when the Mac has one, is its estimate and says so.
 */
function paceOf(
  w: QuotaWindow,
  left: number,
  estimate: UsagePace | undefined,
  now: number
): Pick<KeyLimit, 'evenLeft' | 'paceState' | 'paceWord' | 'runOut'> {
  const length = windowLength(w);
  if (!length || w.resetsAt === undefined || left <= 0) return {};
  const remaining = Math.max(0, Math.min(1, (w.resetsAt - now) / length));
  const evenLeft = Math.round(remaining * 100);
  const gap = evenLeft - left; // positive: less left than even pace leaves
  const paceState = gap > PACE_SLACK ? 'ahead' : gap < -PACE_SLACK ? 'under' : 'on';
  const runOut =
    estimate && estimate.reachesAt > now && estimate.reachesAt < w.resetsAt
      ? {
          at: estimate.reachesAt,
          // Along the time left until the reset: 0 now, 1 the reset.
          along: (estimate.reachesAt - now) / Math.max(1, w.resetsAt - now),
          text: `Runs out ${roughWhen(estimate.reachesAt, now)}`,
        }
      : undefined;
  let paceWord: string;
  if (runOut) {
    const early = Math.round((w.resetsAt - runOut.at) / DAY_MS);
    const ahead = early >= 1 ? `${plural(early, 'day')} before it refills` : 'before it refills';
    paceWord = `Ahead of pace — at this rate it runs out ${roughWhen(runOut.at, now)}, ${ahead}`;
  } else if (paceState === 'ahead') {
    paceWord = 'Ahead of pace — used faster than time has passed';
  } else if (paceState === 'under') {
    paceWord = 'Under pace — room to spare before it refills';
  } else {
    paceWord = 'On pace — lasts until it refills';
  }
  return { evenLeft, paceState, paceWord, ...(runOut ? { runOut } : {}) };
}

function limitsOf(line: UsageAccountLine | undefined, now: number): KeyLimit[] {
  if (!line || !line.signedIn) return [];
  const windows = line.windows.filter((w) => live(w, now));
  const models = windows
    .filter((w) => modelOf(w.kind) !== null)
    .map((w) => [`Weekly · ${modelOf(w.kind)}`, w, true] as const);
  const out: KeyLimit[] = [];
  for (const [label, pick, model] of [
    ['5-hour', windows.find(isSession), false] as const,
    ['Weekly', windows.find(isWeek), false] as const,
    ...models,
  ]) {
    if (!pick || (pick.usedPercent === undefined && !pick.limited)) continue;
    const left = line.out && !model ? 0 : leftOf(pick);
    const estimate = line.pace?.find(
      (x) =>
        x.kind === pick.kind &&
        x.estimate === true &&
        pick.resetsAt !== undefined &&
        Math.abs(x.resetsAt - pick.resetsAt) <= 30 * MINUTE_MS
    );
    const pace = left > 0 && !line.out ? paceFor(line.pace, pick, now) : undefined;
    out.push({
      key: `${line.engine}:${line.id}:${pick.kind}`,
      label,
      left,
      ...(model ? { model: true } : {}),
      // Amber only when nearly out: a pace estimate is information, never an alarm.
      tone: left <= 0 ? 'limited' : 100 - left >= QUOTA_WARN_PERCENT ? 'warning' : 'calm',
      ...(pick.resetsAt
        ? {
            resetsIn: relativeIn(pick.resetsAt, now),
            resetsAt: resetPhrase(pick.resetsAt, now),
            countdown: countdown(pick.resetsAt, now),
          }
        : {}),
      ...(pace ? { pace } : {}),
      ...paceOf(pick, left, line.out ? undefined : estimate, now),
    });
  }
  return out;
}

function runLine(r: UsageRun): string {
  const who = r.routine ? `${r.name}: ${r.routine}` : r.name;
  return `${who} · ${plural(r.turns, 'turn')} · ${tokensShortly(r.tokens)} tokens`;
}

/** Where an account is used outside these agents, by engine. */
export function elsewhereLine(engine: AgentEngine): string {
  return engine === 'codex'
    ? 'Nothing these agents ran explains this. It was used somewhere else: a Codex terminal, ChatGPT, or another computer.'
    : 'Nothing these agents ran explains this. It was used somewhere else: a Claude Code terminal, claude.ai, the Claude app, or another computer.';
}

function whenSpan(since: number, until: number, now: number): string {
  return `${resetPhrase(since, now)} – ${resetPhrase(until, now)}`;
}

export function changeLines(
  engine: AgentEngine,
  changes: UsageChange[] | undefined,
  now = Date.now()
): ChangeLine[] {
  return (changes ?? []).map((c) => {
    const label = isSession(c) ? '5-hour' : isWeek(c) ? 'Weekly' : c.kind.replace(/_/g, ' ');
    return {
      key: `${c.kind}:${c.since}`,
      title: `${label} ${100 - Math.ceil(c.from)}% → ${100 - Math.ceil(c.to)}% left`,
      when: whenSpan(c.since, c.until, now),
      runs: c.runs.map(runLine),
      elsewhere: c.nothingHere ? elsewhereLine(engine) : null,
    };
  });
}

function detailOf(a: UsageAccount, line: UsageAccountLine | undefined, name: string): string[] {
  const out: string[] = [];
  const plan = a.plan ?? line?.plan;
  // Each detail once, and never what the name already says ("Claude Max").
  if (plan && !name.endsWith(` ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`)) {
    out.push(planLabel(plan));
  }
  if (
    line?.orgName &&
    line.orgName !== name &&
    !/'s Organization$|’s Organization$/.test(line.orgName)
  ) {
    out.push(line.orgName);
  }
  if (a.email && a.email !== name) out.push(a.email);
  if (a.thisMac) out.push('this Mac’s own sign-in');
  return out;
}

function keyOf(
  row: SwitcherRow,
  position: number,
  a: UsageAccount,
  line: UsageAccountLine | undefined,
  nextId: string | undefined,
  now: number,
  /** The account it's a second sign-in of, by the name its own key shows. */
  same: string | undefined
): StackKey {
  const limits = limitsOf(line, now);
  // The limits that stop every turn; a per-model one stops only its model.
  const general = limits.filter((l) => !l.model);
  const read = general.length > 0;
  const left =
    !row.signedIn || same
      ? null
      : row.tone === 'out'
        ? 0
        : read
          ? Math.min(...general.map((l) => l.left))
          : null;
  const tightest = general.reduce<KeyLimit | null>(
    (a, l) => (a === null || l.left < a.left ? l : a),
    null
  );
  let state: AccountKeyState;
  let stateLabel: string;
  if (!row.signedIn) {
    state = 'off';
    stateLabel = 'Not signed in';
  } else if (same) {
    state = 'same';
    stateLabel = 'Same account';
  } else if (row.tone === 'out') {
    state = 'out';
    stateLabel = row.state;
  } else if (left === 0) {
    // A reading says a limit is used up before a turn has hit it.
    const spent = limits.find((l) => l.left === 0);
    state = 'out';
    stateLabel = spent?.resetsAt ? `${OUT_OF_USAGE} until ${spent.resetsAt}` : OUT_OF_USAGE;
  } else if (row.inUse) {
    state = 'in_use';
    stateLabel = 'In use';
  } else if (row.id === nextId) {
    state = 'next';
    stateLabel = 'Next';
  } else {
    state = read ? 'ready' : 'unread';
    stateLabel = read ? 'Ready' : 'No reading yet';
  }
  const tone: KeyTone =
    state === 'off' || state === 'same' || left === null
      ? 'quiet'
      : left <= 0
        ? 'limited'
        : left <= LOW_LEFT || limits.some((l) => l.tone === 'warning')
          ? 'warning'
          : 'calm';
  const fix: StackKey['fix'] = !row.signedIn
    ? { action: 'sign_in', text: 'Sign in to use it.' }
    : same
      ? { action: 'sign_in_other', text: `${sameAccountLine(row.engine, same)}.` }
      : null;
  return {
    key: row.key,
    engine: row.engine,
    id: row.id,
    name: row.name,
    position,
    detail: detailOf(a, line, row.name),
    state,
    stateLabel,
    sameAs: same ?? null,
    left,
    tight: same || left === null || left === 0 ? null : tightest,
    tone,
    limits: same ? [] : limits,
    spent: (line?.spent ?? [])
      .slice(0, 5)
      .map((r) => `${r.name} · ${tokensShortly(r.tokens)} tokens · ${plural(r.turns, 'turn')}`),
    changes: changeLines(row.engine, line?.changes, now),
    fix,
    canUse: row.canUse && !same,
    signedIn: row.signedIn,
    thisMac: row.thisMac,
    pinnedBy: row.pinnedBy,
  };
}

/** Two keys never read the same: a repeated name says its place too. */
function distinct(keys: StackKey[]): StackKey[] {
  return keys.map((k) => {
    const twins = keys.filter((o) => o.engine === k.engine && o.name === k.name);
    return twins.length > 1 ? { ...k, name: `${k.name} (${k.position})` } : k;
  });
}

function nudgeOf(
  inv: UsageInventory | null | undefined,
  now: number,
  keys: StackKey[] = []
): SpareNudge | null {
  const s = inv?.spare.find((w) => w.next && w.resetsAt > now);
  if (!inv || !s) return null;
  // The account by the name its key shows (an email, "Work"), never the
  // inventory's own ("This Mac") two lines under the key that says otherwise.
  const name =
    keys.find((k) => k.engine === s.engine && k.id === s.accountId)?.name ?? s.accountName;
  const unused = Math.max(0, Math.floor(100 - s.usedPercent));
  const what = isSession(s) ? '5-hour limit' : isWeek(s) ? 'week' : s.kind.replace(/_/g, ' ');
  const waiting = inv.backlog.filter((i) => i.state === 'waiting');
  return {
    text: `${unused}% of ${name}’s ${what} resets ${relativeIn(s.resetsAt, now)}`,
    question:
      waiting.length > 0
        ? 'Give agents something to do before it goes?'
        : 'Add something to your spare-capacity list to use it.',
    items: waiting.slice(0, 3).map((i) => i.text),
    more: Math.max(0, waiting.length - 3),
    empty: waiting.length === 0,
  };
}

/** One agent (or one of its routines) and what it used this week. */
export interface BurnLine {
  key: string;
  /** "Chief of Staff", "Finance: Monday numbers". */
  name: string;
  tokens: number;
  /** "4.8M tokens · 23 turns". */
  detail: string;
  /** Of everyone's tokens this week, 0–100. */
  share: number;
}

/** Every real account's `spent`, added up by agent: this week, most first. */
function burningOf(inv: UsageInventory | null | undefined, keys: StackKey[]): BurnLine[] {
  const real = new Set(keys.filter((k) => k.state !== 'same').map((k) => `${k.engine}:${k.id}`));
  const by = new Map<string, { name: string; tokens: number; turns: number }>();
  for (const line of inv?.accounts ?? []) {
    if (!real.has(`${line.engine}:${line.id}`)) continue;
    for (const r of line.spent ?? []) {
      const key = r.routine ? `${r.agentId}:${r.routine}` : r.agentId;
      const was = by.get(key) ?? {
        name: r.routine ? `${r.name}: ${r.routine}` : r.name,
        tokens: 0,
        turns: 0,
      };
      by.set(key, { ...was, tokens: was.tokens + r.tokens, turns: was.turns + r.turns });
    }
  }
  const total = [...by.values()].reduce((s, b) => s + b.tokens, 0);
  return [...by.entries()]
    .map(([key, b]) => ({
      key,
      name: b.name,
      tokens: b.tokens,
      detail: `${tokensShortly(b.tokens)} tokens · ${plural(b.turns, 'turn')}`,
      share: total > 0 ? Math.round((b.tokens / total) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * The whole stack. `accounts` is the order turns try them
 * (`agents.accounts`); `inventory` brings each one's readings.
 */
export function usageGlance(
  accounts: UsageAccount[],
  inventory: UsageInventory | null | undefined,
  opts: {
    now?: number;
    engines?: AgentEngine[];
    pins?: { engine: AgentEngine; account: string; name: string }[];
  } = {}
): UsageGlance {
  const now = opts.now ?? Date.now();
  // By default, only engines with an account signed in: an engine nobody
  // uses isn't part of the stack.
  const engines0 = opts.engines ?? [
    ...new Set(accounts.filter((a) => a.signedIn).map((a) => a.engine)),
  ];
  const view = switcherView(accounts, inventory, { now, engines: engines0, pins: opts.pins });
  const engines: StackEngine[] = view.map((e) => {
    const lines = (id: string) =>
      inventory?.accounts.find((l) => l.engine === e.engine && l.id === id);
    // The Mac names the first sign-in by its own name for it ("This Mac"):
    // said here by the name that account's key shows.
    const sameName = (id: string) => {
      const said = lines(id)?.sameAs;
      if (!said) return undefined;
      const first = inventory?.accounts.find((l) => l.engine === e.engine && l.name === said);
      return (
        (first && e.rows.find((r) => r.id === first.id)?.name) ??
        accountLabel({ engine: e.engine, name: said })
      );
    };
    // "Next": the one turns move to when the one in use runs out.
    const inUse = e.rows.findIndex((r) => r.inUse);
    const next = e.rows.find(
      (r, i) => i > inUse && inUse >= 0 && r.signedIn && r.tone !== 'out' && !lines(r.id)?.sameAs
    );
    const keys = e.rows.map((row, i) =>
      keyOf(
        row,
        i + 1,
        accounts.find((a) => a.engine === e.engine && a.id === row.id) as UsageAccount,
        lines(row.id),
        next?.id,
        now,
        sameName(row.id)
      )
    );
    return { engine: e.engine, label: e.label, keys: distinct(keys) };
  });
  const keys = engines.flatMap((e) => e.keys);
  const counted = keys.filter((k) => k.signedIn && k.state !== 'same');
  const read = counted.filter((k) => k.left !== null);
  const roomy = read.filter((k) => (k.left ?? 0) > 0);

  // The soonest reset of any limit of an account that counts.
  const resets = counted
    .flatMap((k) =>
      (inventory?.accounts.find((l) => l.engine === k.engine && l.id === k.id)?.windows ?? [])
        .filter((w) => w.resetsAt && w.resetsAt > now && (isSession(w) || isWeek(w)))
        .map((w) => ({ w, k }))
    )
    .sort((a, b) => (a.w.resetsAt as number) - (b.w.resetsAt as number));
  const first = resets[0];
  const soonest = first
    ? {
        label: isSession(first.w) ? '5-hour' : 'Weekly',
        resetsIn: relativeIn(first.w.resetsAt as number, now),
        resetsAt: resetPhrase(first.w.resetsAt as number, now),
        account: first.k.name,
      }
    : null;

  const t = inventory?.totals;
  const runOut = (t?.runOut ?? []).filter((r) => r.estimate === true && r.reachesAt > now);
  let headline: string;
  let estimate: string | null = null;
  let tone: UsageGlance['tone'] = 'calm';
  const back = t?.nextRoom && t.nextRoom.at > now ? t.nextRoom : undefined;
  if (counted.length === 0) {
    headline = keys.length === 0 ? 'No accounts yet' : 'No account is signed in';
    tone = 'warning';
  } else if (read.length === 0) {
    headline = 'No usage reading yet';
  } else if (roomy.length === 0) {
    tone = 'limited';
    headline = back
      ? `${OUT_OF_USAGE} until ${resetPhrase(back.at, now)}`
      : `${OUT_OF_USAGE} everywhere`;
  } else if (runOut.length > 0) {
    const r = runOut.reduce((a, b) => (b.reachesAt < a.reachesAt ? b : a));
    const engineResets = resets
      .filter((x) => x.k.engine === r.engine && isWeek(x.w))
      .map((x) => x.w.resetsAt as number);
    const after = engineResets.length ? Math.max(...engineResets) : undefined;
    const gap = after ? Math.round((after - r.reachesAt) / DAY_MS) : 0;
    // "~" marks the estimate, unless the phrase says so itself ("in about an hour").
    const when = roughWhen(r.reachesAt, now);
    headline = `Runs out ${when.startsWith('in about') ? when : `~${when}`}${gap >= 1 ? `, ${plural(gap, 'day')} before reset` : ''}`;
    estimate = `Estimate from ${r.readings} readings across ${plural(r.accounts, 'account')}`;
    // An estimate is information: in ink, never the colour that says "needs you".
  } else if (read.every((k) => (k.left ?? 0) <= LOW_LEFT)) {
    headline = 'Nearly out on every account';
    tone = 'warning';
  } else {
    const using = read.find((k) => k.state === 'in_use');
    const nextUp = read.find((k) => k.state === 'next' && (k.left ?? 0) > LOW_LEFT);
    if (using && (using.left ?? 0) <= LOW_LEFT && nextUp) {
      // Turns move on by themselves: nothing for the user to do.
      headline = `${using.name} is low · ${nextUp.name} is next`;
    } else if (using && (using.left ?? 0) >= PLENTY_LEFT) {
      headline = 'Plenty of room';
    } else {
      headline = 'Room to work';
    }
  }

  const n = counted.length;
  const summary = [
    n > 0 ? plural(n, 'account') : null,
    soonest ? `resets ${soonest.resetsAt}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // Engines whose every read account is nearly or wholly out.
  const readOf = (e: StackEngine) =>
    e.keys.filter((k) => k.signedIn && k.state !== 'same' && k.left !== null);
  const lowEngines = engines.filter(
    (e) => readOf(e).length > 0 && readOf(e).every((k) => (k.left ?? 0) <= LOW_LEFT)
  );
  const other = engines.find(
    (o) => !lowEngines.includes(o) && readOf(o).some((k) => (k.left ?? 0) > LOW_LEFT)
  );
  const wait = back
    ? `Wait until ${resetPhrase(back.at, now)}`
    : soonest
      ? `Wait until ${soonest.resetsAt}`
      : null;
  let low: LowBar | null = null;
  if (lowEngines.length > 0 && other) {
    low = {
      text: `Every ${lowEngines[0].label} account is nearly out of usage.`,
      waitUntil: null,
      otherEngine: other.engine,
    };
  } else if (lowEngines.length > 0) {
    low = {
      text:
        roomy.length === 0
          ? `Every account is ${OUT_OF_USAGE.toLowerCase()}.`
          : 'Every account is nearly out of usage.',
      waitUntil: wait,
      otherEngine: null,
    };
  }

  const row = rowWords(keys, counted, read, roomy, tone, back?.at ?? null, soonest, now);

  // This Mac's sign-in became another account: the first engine's, said once.
  const change = (inventory?.signInChanges ?? []).find((c) =>
    engines.some((e) => e.engine === c.engine)
  );
  const macName =
    keys.find((k) => change && k.engine === change.engine && k.thisMac)?.name ??
    'this Mac’s sign-in';

  return {
    engines,
    keys,
    row,
    meterKeys: keys.filter((k) => k.state !== 'same'),
    sameNotes: keys
      .filter((k) => k.state === 'same' && k.sameAs)
      .map((k) => sameAccountNote(k.engine, k.name, k.sameAs as string)),
    signInChanged: change
      ? { engine: change.engine, key: change.key, text: signInChangedText(change, macName) }
      : null,
    headline,
    unread: counted.length > 0 && read.length === 0,
    estimate,
    tone,
    summary,
    soonest,
    nudge: nudgeOf(inventory, now, keys),
    burning: burningOf(inventory, keys),
    low,
  };
}
