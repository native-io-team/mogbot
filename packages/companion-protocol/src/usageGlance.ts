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
 *   from the engines' own records) is drawn but adds no room, and says why.
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
import { ACCOUNT_ENGINE_LABEL, switcherView, type SwitcherRow } from './accountSwitcher';

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
}

/** One rise in a meter, said for "Where did my usage go". */
export interface ChangeLine {
  key: string;
  /** "Weekly 32% → 67% used". */
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
  /** "In use", "Next", "Ready", "Out of usage until Sat 10:00 AM", "Not signed in", "Same account as …", "No reading yet". */
  stateLabel: string;
  /** Left of its tighter limit, 0–100; null with no reading (or adding no room). */
  left: number | null;
  tone: KeyTone;
  limits: KeyLimit[];
  /** "Riley · 1.2M tokens · 14 turns", this week, most first. */
  spent: string[];
  changes: ChangeLine[];
  /** The one fix for a sign-in problem. */
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

export interface UsageGlance {
  engines: StackEngine[];
  /** Every key, engine by engine, in order. */
  keys: StackKey[];
  /** "Plenty of room", "Runs out ~Thu, 2 days before reset", "Out of usage until 3:20 PM". */
  headline: string;
  /** The headline is an estimate: what it rests on. */
  estimate: string | null;
  tone: 'calm' | 'warning' | 'limited';
  /** "2 accounts · resets Sat 10:00 AM". */
  summary: string;
  /** The soonest reset of any read account's limit. */
  soonest: { label: string; resetsIn: string; resetsAt: string; account: string } | null;
  nudge: SpareNudge | null;
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

function limitsOf(line: UsageAccountLine | undefined, now: number): KeyLimit[] {
  if (!line || !line.signedIn) return [];
  const windows = line.windows.filter((w) => live(w, now));
  const out: KeyLimit[] = [];
  for (const [label, pick] of [
    ['5-hour', windows.find(isSession)],
    ['Weekly', windows.find(isWeek)],
  ] as const) {
    if (!pick || (pick.usedPercent === undefined && !pick.limited)) continue;
    const left = line.out ? 0 : leftOf(pick);
    const pace = left > 0 && !line.out ? paceFor(line.pace, pick, now) : undefined;
    out.push({
      key: `${line.engine}:${line.id}:${pick.kind}`,
      label,
      left,
      tone: left <= 0 ? 'limited' : 100 - left >= QUOTA_WARN_PERCENT || pace ? 'warning' : 'calm',
      ...(pick.resetsAt
        ? { resetsIn: relativeIn(pick.resetsAt, now), resetsAt: resetPhrase(pick.resetsAt, now) }
        : {}),
      ...(pace ? { pace } : {}),
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
      title: `${label} ${Math.floor(c.from)}% → ${Math.floor(c.to)}% used`,
      when: whenSpan(c.since, c.until, now),
      runs: c.runs.map(runLine),
      elsewhere: c.nothingHere ? elsewhereLine(engine) : null,
    };
  });
}

function detailOf(a: UsageAccount, line: UsageAccountLine | undefined): string[] {
  const out: string[] = [];
  const plan = a.plan ?? line?.plan;
  if (plan) out.push(planLabel(plan));
  if (line?.orgName && !/'s Organization$|’s Organization$/.test(line.orgName)) {
    out.push(line.orgName);
  }
  if (a.email && a.email !== a.name) out.push(a.email);
  if (a.thisMac) out.push('this Mac’s own sign-in');
  return out;
}

function keyOf(
  row: SwitcherRow,
  position: number,
  a: UsageAccount,
  line: UsageAccountLine | undefined,
  nextId: string | undefined,
  now: number
): StackKey {
  const limits = limitsOf(line, now);
  const read = limits.length > 0;
  const same = line?.sameAs;
  const left =
    !row.signedIn || same
      ? null
      : row.tone === 'out'
        ? 0
        : read
          ? Math.min(...limits.map((l) => l.left))
          : null;
  let state: AccountKeyState;
  let stateLabel: string;
  if (!row.signedIn) {
    state = 'off';
    stateLabel = 'Not signed in';
  } else if (same) {
    state = 'same';
    stateLabel = `Same account as ${same}`;
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
      ? {
          action: 'sign_in_other',
          text: `It’s signed in to the same ${ACCOUNT_ENGINE_LABEL[row.engine]} account as ${same}, so it adds no room. Sign it in again with a different account (sign out of ${row.engine === 'codex' ? 'ChatGPT' : 'claude.ai'} in your browser first), or remove it.`,
        }
      : null;
  return {
    key: row.key,
    engine: row.engine,
    id: row.id,
    name: row.name,
    position,
    detail: detailOf(a, line),
    state,
    stateLabel,
    left,
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
        now
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
    tone = 'warning';
  } else if (read.every((k) => (k.left ?? 0) <= LOW_LEFT)) {
    headline = 'Nearly out on every account';
    tone = 'warning';
  } else {
    const using = read.find((k) => k.state === 'in_use');
    const nextUp = read.find((k) => k.state === 'next' && (k.left ?? 0) > LOW_LEFT);
    if (using && (using.left ?? 0) <= LOW_LEFT && nextUp) {
      headline = `${using.name} is low · ${nextUp.name} is next`;
      tone = 'warning';
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

  return {
    engines,
    keys,
    headline,
    estimate,
    tone,
    summary,
    soonest,
    nudge: nudgeOf(inventory, now, keys),
    low,
  };
}
