/**
 * The usage ring and its Usage sheet, as figures and words, for the phone's
 * chat header and the desk's alike. Pure, and only what the Mac serves: the
 * agent's context as its engine reported it (`Agent.context`,
 * agents/context.rs), the plan's windows (`agents.quota`) and every
 * account's (`agents.usagePlan`). No reading, no row.
 *
 * One thing here is an estimate, and is always said as one: the pace line
 * ("At this pace you'll hit the limit this afternoon, before it resets at
 * 4:00 PM"), from the Mac's `UsagePace` (agents/forecast.rs `pace`). The Mac
 * sends one only with enough readings and only when it lands before the
 * reset; nothing here computes or fills one in.
 *
 * Each reading shows once (`usageSheet`): the account this agent's turns run
 * on, with its 5-hour and weekly limits, at the top; every other account
 * below. The plan's own windows (`agents.quota`) are that same account's
 * reading, so they stand in for it only when the Mac hasn't said which
 * account they belong to.
 */

import type {
  AgentEngine,
  ContextFill,
  Quota,
  QuotaWindow,
  UsageAccountLine,
  UsageInventory,
  UsagePace,
} from './model';
import {
  QUOTA_STALE_MS,
  QUOTA_WARN_PERCENT,
  readDay,
  resetPhrase,
  retryPhrase,
  windowName,
} from './quota';
import { accountTags, accountUsage, type UsageTone } from './usage';

/** When a window runs out at the recent rate: always with what it rests on. */
export interface PaceLine {
  /** "At this pace you'll hit the limit Mon afternoon, before it resets Mon 4:00 PM". */
  text: string;
  /** "Estimate from 6 readings over 2 hours". */
  basis: string;
}

/** One figure with its bar: "32% used", and the line under it. */
export interface UsageMeter {
  key: string;
  label: string;
  /** 0–100, floored: "90%" never shows on a window that hasn't reached it. */
  percent: number;
  /** "Resets at 3:20 PM", "319.9K of 1M tokens". */
  detail: string;
  tone: UsageTone;
  /** Only when the Mac sent one for this window. */
  pace?: PaceLine;
}

const toneOf = (percent: number, limited = false): UsageTone =>
  limited || percent >= 100 ? 'limited' : percent >= QUOTA_WARN_PERCENT ? 'warning' : 'calm';

/** "319.9K", "1M", "850": a token count, short. */
export function tokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** "32% used · 319.9K of 1M tokens"; null when the engine hasn't reported it. */
export function contextMeter(context: ContextFill | undefined): UsageMeter | null {
  if (!context || !(context.window > 0) || context.used < 0) return null;
  const percent = Math.min(100, Math.floor((context.used / context.window) * 100));
  return {
    key: 'context',
    label: `${percent}% used`,
    percent,
    detail: `${tokensShort(context.used)} of ${tokensShort(context.window)} tokens`,
    tone: toneOf(percent),
  };
}

const live = (w: QuotaWindow, now: number) => w.resetsAt === undefined || w.resetsAt > now;
const usedOf = (w: QuotaWindow) =>
  w.limited ? 100 : Math.max(0, Math.min(100, Math.floor(w.usedPercent ?? 0)));
const isSession = (w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>) =>
  w.kind === 'five_hour' || w.windowMinutes === 300;

/** "Resets at 3:20 PM" today, "Resets tomorrow 3:20 PM", "Resets Mon 4:00 PM". */
export function resetsLine(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return 'Reset time not reported';
  const phrase = resetPhrase(at, now);
  return /^\d/.test(phrase) ? `Resets at ${phrase}` : `Resets ${phrase}`;
}

/** An old reading says how old: a figure stands until reset, but use elsewhere since isn't in it. */
const aged = (w: QuotaWindow, now: number) =>
  now - w.observedAt > QUOTA_STALE_MS ? ` · read ${readDay(w.observedAt, now)}` : '';

/** A weekly window's name: "All models", "Opus", "Sonnet". */
export function weeklyLabel(w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>): string {
  if (w.kind === 'seven_day_opus') return 'Opus';
  if (w.kind === 'seven_day_sonnet') return 'Sonnet';
  if (w.kind === 'seven_day' || w.windowMinutes === 7 * 24 * 60) return 'All models';
  const name = windowName(w);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * A meter's name in an account's list, where the 5-hour and the weekly
 * limits sit together: "5-hour limit", "Weekly · All models", "Weekly · Opus".
 */
export function limitLabel(w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>): string {
  return isSession(w) ? '5-hour limit' : `Weekly · ${weeklyLabel(w)}`;
}

/** The 5-hour window first, then the all-models week, then each model's. */
const windowOrder = (w: QuotaWindow) => (isSession(w) ? 0 : w.kind === 'seven_day' ? 1 : 2);

/* --------------------------------------------------------------- pace */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function daysAhead(at: number, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor((at - start.getTime()) / DAY_MS);
}

/**
 * A rough time, because it's an estimate: "in about 40 minutes", "in about
 * 2 hours", then a part of a day ("this afternoon", "tomorrow morning", "Mon
 * evening"), never a minute it can't know.
 */
export function roughWhen(at: number, now = Date.now()): string {
  const ahead = at - now;
  if (ahead < HOUR_MS) {
    const minutes = Math.max(5, Math.round(ahead / (5 * MINUTE_MS)) * 5);
    return minutes >= 60 ? 'in about an hour' : `in about ${minutes} minutes`;
  }
  if (ahead < 3 * HOUR_MS) {
    const hours = Math.round(ahead / HOUR_MS);
    return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`;
  }
  const hour = new Date(at).getHours();
  const part =
    hour < 5
      ? 'early'
      : hour < 12
        ? 'morning'
        : hour < 17
          ? 'afternoon'
          : hour < 21
            ? 'evening'
            : 'night';
  const days = daysAhead(at, now);
  if (days >= 7) return DATE.format(at);
  const day = days <= 0 ? 'this' : days === 1 ? 'tomorrow' : WEEKDAY.format(at);
  if (part === 'early') return days <= 0 ? 'early this morning' : `early ${day} morning`;
  if (days <= 0) return part === 'night' ? 'tonight' : `this ${part}`;
  return `${day} ${part}`;
}

/** "6 readings over 2 hours". */
function basisOf(p: UsagePace): string {
  const m = p.spanMinutes;
  const span =
    m < 90
      ? `${m} minutes`
      : m < 48 * 60
        ? `${Math.round(m / 60)} hours`
        : `${Math.round(m / (24 * 60))} days`;
  return `Estimate from ${p.readings} readings over ${span}`;
}

/**
 * The pace line for a window, from the Mac's estimate. Null without one, or
 * with one that no longer says anything (the crossing or the reset passed
 * since the Mac sent it).
 */
export function paceLine(p: UsagePace | undefined, now = Date.now()): PaceLine | null {
  if (!p || p.estimate !== true) return null;
  if (!(p.reachesAt > now) || !(p.reachesAt < p.resetsAt)) return null;
  return {
    text: `At this pace you’ll hit the limit ${roughWhen(p.reachesAt, now)}, before it resets ${retryPhrase(p.resetsAt, now)}`,
    basis: basisOf(p),
  };
}

/** Two reports of one window instance: Claude Code's reset can move a little. */
const SAME_RESET_MS = 30 * MINUTE_MS;

const paceFor = (paces: UsagePace[] | undefined, w: QuotaWindow) =>
  w.resetsAt === undefined
    ? undefined
    : paces?.find(
        (p) => p.kind === w.kind && Math.abs(p.resetsAt - (w.resetsAt as number)) <= SAME_RESET_MS
      );

const meterOf = (
  key: string,
  label: string,
  w: QuotaWindow,
  now: number,
  pace?: UsagePace
): UsageMeter | null => {
  // A window with no figure and not used up has nothing to draw.
  if (w.usedPercent === undefined && !w.limited) return null;
  const percent = usedOf(w);
  const line = percent < 100 ? paceLine(pace, now) : null;
  return {
    key,
    label,
    percent,
    detail: `${resetsLine(w.resetsAt, now)}${aged(w, now)}`,
    tone: toneOf(percent, w.limited),
    ...(line ? { pace: line } : {}),
  };
};

export interface PlanUsage {
  /** The 5-hour window: "5-hour limit". */
  session: UsageMeter | null;
  /** Each weekly window: "All models", then any per-model ones. */
  weekly: UsageMeter[];
}

/**
 * One engine's plan, as it reported it; null when it hasn't. `inventory`
 * (when read) brings the pace: an account of this engine whose estimate is
 * for the same window instance.
 */
export function planUsage(
  quotas: Quota[] | null | undefined,
  engine: AgentEngine,
  now = Date.now(),
  inventory?: UsageInventory | null
): PlanUsage | null {
  const q = quotas?.find((x) => x.engine === engine);
  const windows = q?.windows.filter((w) => live(w, now)) ?? [];
  const paces = (inventory?.accounts ?? [])
    .filter((a) => a.engine === engine && !a.out)
    .flatMap((a) => a.pace ?? []);
  const sessionWindow = windows.find(isSession);
  const session = sessionWindow
    ? meterOf('session', '5-hour limit', sessionWindow, now, paceFor(paces, sessionWindow))
    : null;
  const weekly = windows
    .filter((w) => !isSession(w))
    .sort((a, b) => Number(b.kind === 'seven_day') - Number(a.kind === 'seven_day'))
    .map((w) => meterOf(`week:${w.kind}`, weeklyLabel(w), w, now, paceFor(paces, w)))
    .filter((m): m is UsageMeter => m !== null);
  return session || weekly.length ? { session, weekly } : null;
}

/** The header ring: the current 5-hour window's share, or null with no reading. */
export function ringPercent(
  quotas: Quota[] | null | undefined,
  engine: AgentEngine,
  now = Date.now()
): { percent: number; tone: UsageTone } | null {
  const s = planUsage(quotas, engine, now)?.session;
  return s ? { percent: s.percent, tone: s.tone } : null;
}

const ENGINE_NAME: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex' };

export interface AccountBlock {
  key: string;
  engine: AgentEngine;
  /** "Claude · Work". */
  title: string;
  /** "Work", "This Mac". */
  name: string;
  /** Its engine's next turn runs on it. */
  next: boolean;
  /** "Max plan", "Next turns run here". */
  tags: string[];
  meters: UsageMeter[];
  /** When there's nothing to draw a bar for: "Not signed in", "Out of usage until …". */
  state: string | null;
  tone: UsageTone;
}

/** One block per account the Mac knows, Claude's then Codex's, each with its windows. */
export function accountBlocks(
  inventory: UsageInventory | null | undefined,
  now = Date.now()
): AccountBlock[] {
  const accounts = [...(inventory?.accounts ?? [])].sort(
    (a, b) => Number(a.engine !== 'claude') - Number(b.engine !== 'claude')
  );
  return accounts.map((a: UsageAccountLine) => {
    const meters = a.windows
      .filter((w) => live(w, now))
      .sort((x, y) => windowOrder(x) - windowOrder(y))
      .map((w) => meterOf(`${a.id}:${w.kind}`, limitLabel(w), w, now, paceFor(a.pace, w)))
      .filter((m): m is UsageMeter => m !== null);
    const usage = accountUsage(a, now);
    const showState = !a.signedIn || a.out || meters.length === 0;
    return {
      key: `${a.engine}:${a.id}`,
      engine: a.engine,
      title: `${ENGINE_NAME[a.engine] ?? a.engine} · ${a.name}`,
      name: a.name,
      next: a.next,
      tags: accountTags(a),
      meters: a.out ? [] : meters,
      state: showState ? usage.text : null,
      tone: usage.tone,
    };
  });
}

/** The top of the sheet: the limits this agent's turns run against. */
export interface ActiveUsage {
  /** "This Mac · Max plan · Next turns run here"; null when the Mac hasn't said whose. */
  account: string | null;
  /** The 5-hour limit, then the weekly ones. */
  meters: UsageMeter[];
  /** When there's nothing to draw a bar for: "Not signed in", "Out of usage until …". */
  state: string | null;
  tone: UsageTone;
}

export interface UsageSheet {
  /** This agent's engine's account; null with no reading at all. */
  active: ActiveUsage | null;
  /** Every other account, each with its own limits. Never the active one again. */
  others: AccountBlock[];
}

/**
 * The Usage sheet's limits, each reading once: the account the agent's next
 * turns run on (its engine's `next`, else this Mac's sign-in) at the top,
 * every other account under it.
 *
 * The plan's windows (`quotas`) are the same reading as that account's, so
 * they're drawn only when no account of this engine has one of its own (a
 * Mac that serves no inventory, or one that couldn't say which account a
 * reading came from); then the top says no account name, rather than guess.
 */
export function usageSheet(
  quotas: Quota[] | null | undefined,
  engine: AgentEngine,
  inventory: UsageInventory | null | undefined,
  now = Date.now()
): UsageSheet {
  const blocks = accountBlocks(inventory, now);
  const mine = blocks.filter((b) => b.engine === engine);
  const thisMac = new Set(
    (inventory?.accounts ?? []).filter((a) => a.thisMac).map((a) => `${a.engine}:${a.id}`)
  );
  const current =
    mine.find((b) => b.next) ?? mine.find((b) => thisMac.has(b.key)) ?? mine[0] ?? null;
  const readByAccount = mine.some((b) => b.meters.length > 0);
  const plan = readByAccount ? null : planUsage(quotas, engine, now, inventory);
  if (plan) {
    const meters = [plan.session, ...plan.weekly]
      .filter((m): m is UsageMeter => m !== null)
      .map((m) => (m.key === 'session' ? m : { ...m, label: `Weekly · ${m.label}` }));
    return {
      active: { account: null, meters, state: null, tone: 'calm' },
      others: blocks,
    };
  }
  if (!current) return { active: null, others: blocks };
  return {
    active: {
      account: [current.name, ...current.tags].join(' · '),
      meters: current.meters,
      state: current.state,
      tone: current.tone,
    },
    others: blocks.filter((b) => b !== current),
  };
}
