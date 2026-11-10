/**
 * Usage before the wall: how the plan's limits and a routine's cost are
 * said, on the desk and the phone alike. Pure.
 *
 * Every figure is one an engine reported (`agents_quota`, `agents_usage`);
 * nothing here estimates, extrapolates or fills a gap. No reading, no line.
 */

import { clockFormat, formatClock } from './clock';
import type { AgentEngine, Quota, QuotaWindow, UsageTotals } from './model';

/** The share of a window at which the line turns amber. */
export const QUOTA_WARN_PERCENT = 90;

const ENGINE_SHORT: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex' };
const ENGINE_FULL: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

const CLOCK = { format: formatClock };
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const WEEKDAY_CLOCK = {
  format: (at: number | Date) => clockFormat({
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
}).format(at),
};
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/**
 * A reading older than this says how old it is on the line itself ("· read
 * Tue"): a weekly figure stands until its reset, and use of the same plan in
 * the CLI or on the web since then isn't in it.
 */
export const QUOTA_STALE_MS = 6 * HOUR_MS;

/** Whole days from today to `at`'s day, on this device's calendar. */
function daysAhead(at: number, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor((at - start.getTime()) / DAY_MS);
}

/**
 * The one rule for naming a day, everywhere a reset is said (here, the
 * Retry button, and the Mac's own sentences in `failure::clock_phrase`):
 * today, "tomorrow", the weekday within the week, else the date.
 *
 * When a limit lifts, for a sentence: "3:00 PM" today, "tomorrow 3:00 PM",
 * "Sat 10:00 AM" within the week, else "Nov 14". A weekly limit must never
 * read as a time today.
 */
export function resetPhrase(at: number, now = Date.now()): string {
  const days = daysAhead(at, now);
  if (days <= 0) return CLOCK.format(at);
  if (days === 1) return `tomorrow ${CLOCK.format(at)}`;
  if (days < 7) return WEEKDAY_CLOCK.format(at);
  return DATE.format(at);
}

/** For “Retry …”: “at 3:00 PM” today, else as `resetPhrase` says it. */
export function retryPhrase(at: number, now = Date.now()): string {
  return daysAhead(at, now) <= 0 ? `at ${CLOCK.format(at)}` : resetPhrase(at, now);
}

/** The same, shortest: "3:00 PM" today, else "tomorrow", "Thu", "Nov 14". */
export function resetDay(at: number, now = Date.now()): string {
  const days = daysAhead(at, now);
  if (days <= 0) return CLOCK.format(at);
  if (days === 1) return 'tomorrow';
  if (days < 7) return WEEKDAY.format(at);
  return DATE.format(at);
}

/** When a reading was taken, for the tooltip: "at 3:00 PM" today, else with its day. */
export function readPhrase(at: number, now = Date.now()): string {
  const ago = -daysAhead(at, now);
  if (ago <= 0) return `at ${CLOCK.format(at)}`;
  if (ago === 1) return `yesterday at ${CLOCK.format(at)}`;
  if (ago < 7) return `${WEEKDAY.format(at)} at ${CLOCK.format(at)}`;
  return `on ${DATE.format(at)} at ${CLOCK.format(at)}`;
}

/** The same, shortest, for the line: "9:00 AM", "yesterday", "Tue", "Oct 28". */
export function readDay(at: number, now = Date.now()): string {
  const ago = -daysAhead(at, now);
  if (ago <= 0) return CLOCK.format(at);
  if (ago === 1) return 'yesterday';
  if (ago < 7) return WEEKDAY.format(at);
  return DATE.format(at);
}

/** "5-hour", "weekly", or the engine's own word for a window we don't know. */
export function windowName(w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>): string {
  const minutes = w.windowMinutes;
  if (w.kind === 'five_hour' || minutes === 300) return '5-hour';
  if (w.kind === 'seven_day' || minutes === 7 * 24 * 60) return 'weekly';
  if (w.kind === 'seven_day_opus') return 'weekly Opus';
  if (w.kind === 'seven_day_sonnet') return 'weekly Sonnet';
  return w.kind.replace(/_/g, ' ');
}

const usedUp = (w: QuotaWindow) => w.limited || (w.usedPercent ?? 0) >= 100;
const current = (w: QuotaWindow, now: number) => w.resetsAt === undefined || w.resetsAt > now;

export type QuotaTone = 'calm' | 'warning' | 'limited';

export interface QuotaLine {
  engine: AgentEngine;
  /** "Claude usage 85% · resets Thu", "Claude out of usage until 3:00 PM". */
  text: string;
  tone: QuotaTone;
  /** Which window, when it was read, and that other use counts too. */
  detail: string;
  /** The figure shown, when there is one. */
  percent?: number;
}

/**
 * One line per engine that reported its plan: a used-up window first (the
 * one that lifts last, since that's when work can resume), else the fullest
 * window with a figure. Windows past their reset are history: left out.
 */
export function quotaLines(quotas: Quota[], now = Date.now()): QuotaLine[] {
  const lines: QuotaLine[] = [];
  for (const q of quotas) {
    const windows = q.windows.filter((w) => current(w, now));
    const name = ENGINE_SHORT[q.engine] ?? q.engine;
    const full = ENGINE_FULL[q.engine] ?? q.engine;
    const read = (w: QuotaWindow) =>
      `As ${full} reported it ${readPhrase(w.observedAt, now)}, for its ${windowName(w)} limit. ` +
      'Use of the same plan anywhere else counts too.';
    const out = windows.filter(usedUp).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    if (out) {
      lines.push({
        engine: q.engine,
        text: out.resetsAt
          ? `${name} out of usage until ${resetDay(out.resetsAt, now)}`
          : `${name} out of usage`,
        tone: 'limited',
        detail: read(out),
        percent: out.usedPercent,
      });
      continue;
    }
    const fullest = windows
      .filter((w) => w.usedPercent !== undefined)
      .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    if (!fullest || fullest.usedPercent === undefined) continue;
    // Floored: "90%" never shows on a window that hasn't reached it.
    const shown = Math.max(0, Math.floor(fullest.usedPercent));
    const reset = fullest.resetsAt ? ` · resets ${resetDay(fullest.resetsAt, now)}` : '';
    // An old figure says so on the line, not only in the tooltip (which the
    // phone doesn't have). A used-up window needs no age: it stays used up
    // until its reset, which the line names.
    const age =
      now - fullest.observedAt > QUOTA_STALE_MS
        ? ` · read ${readDay(fullest.observedAt, now)}`
        : '';
    lines.push({
      engine: q.engine,
      text: `${name} usage ${shown}%${reset}${age}`,
      tone: fullest.usedPercent >= QUOTA_WARN_PERCENT ? 'warning' : 'calm',
      detail: read(fullest),
      percent: shown,
    });
  }
  return lines;
}

/** "38k tokens": every token a run reported, cache included. */
export function tokenCount(t: UsageTotals): string {
  const n = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return `${compactTokens(n)} tokens`;
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Whether Claude has reported a plan (Pro or Max): a current Claude reading.
 * On a plan, Claude Code's dollar figure is a list price, not the user's
 * bill, so costs are said in tokens instead (`routineWeekLine`, the editor's
 * and the phone's usage).
 */
export function onClaudePlan(lines: Pick<QuotaLine, 'engine'>[]): boolean {
  return lines.some((l) => l.engine === 'claude');
}

/** A Claude Code price, said as what it is: "$0.84 at API prices". */
export function apiPrice(usd: number): string {
  return `${usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`} at API prices`;
}

/**
 * A routine's week in a few words: "$0.84 at API prices this week" when
 * every run was priced and Claude reported no plan, else its tokens ("38k
 * tokens this week": a plan's figure isn't a bill, and Codex reports no
 * price). Null when it hasn't run on its own this week.
 */
export function routineWeekLine(t: UsageTotals | undefined, onPlan = false): string | null {
  if (!t || t.turns + (t.checks ?? 0) === 0) return null;
  const checks = t.checks ? `${t.checks} check${t.checks === 1 ? '' : 's'} · ` : '';
  if (fullyPriced(t) && !onPlan) {
    return `${checks}${apiPrice(t.costUsd)} this week`;
  }
  return `${checks}${tokenCount(t)} this week`;
}

/**
 * Every turn and every "When…" model check in `t` reported a price, so
 * `costUsd` is the whole of it (a partial sum would read as the whole).
 */
export function fullyPriced(t: UsageTotals): boolean {
  return t.pricedTurns + (t.pricedChecks ?? 0) === t.turns + (t.checks ?? 0);
}

/** Several weeks' totals as one; undefined for none. */
export function sumTotals(list: UsageTotals[]): UsageTotals | undefined {
  if (list.length === 0) return undefined;
  return list.reduce((a, t) => ({
    turns: a.turns + t.turns,
    inputTokens: a.inputTokens + t.inputTokens,
    outputTokens: a.outputTokens + t.outputTokens,
    cacheReadTokens: a.cacheReadTokens + t.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + t.cacheWriteTokens,
    costUsd: a.costUsd + t.costUsd,
    pricedTurns: a.pricedTurns + t.pricedTurns,
    durationMs: a.durationMs + t.durationMs,
    checks: (a.checks ?? 0) + (t.checks ?? 0),
    pricedChecks: (a.pricedChecks ?? 0) + (t.pricedChecks ?? 0),
  }));
}

/** What a dollar figure from Claude Code is: its own price, not the user's bill. */
export const COST_BASIS_NOTE =
  'Priced by Claude Code at API list rates. On a Pro or Max plan it is not what you are billed.';
