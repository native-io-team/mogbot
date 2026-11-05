/**
 * Usage before the wall: how the plan's limits and a routine's cost are
 * said, on the desk and the phone alike. Pure.
 *
 * Every figure is one an engine reported (`agents_quota`, `agents_usage`);
 * nothing here estimates, extrapolates or fills a gap. No reading, no line.
 */

import type { AgentEngine, Quota, QuotaWindow, UsageTotals } from './model';

/** The share of a window at which the line turns amber. */
export const QUOTA_WARN_PERCENT = 90;

const ENGINE_SHORT: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex' };
const ENGINE_FULL: Record<AgentEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const WEEKDAY_CLOCK = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from today to `at`'s day, on this device's calendar. */
function daysAhead(at: number, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor((at - start.getTime()) / DAY_MS);
}

/**
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
  /** "Claude usage 85% · resets Thu", "Claude usage limit · resets 3:00 PM". */
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
      `As ${full} reported it at ${CLOCK.format(w.observedAt)}, for its ${windowName(w)} limit. ` +
      'Use of the same plan anywhere else counts too.';
    const out = windows.filter(usedUp).sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    if (out) {
      lines.push({
        engine: q.engine,
        text: out.resetsAt
          ? `${name} usage limit · resets ${resetDay(out.resetsAt, now)}`
          : `${name} usage limit reached`,
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
    lines.push({
      engine: q.engine,
      text: `${name} usage ${shown}%${reset}`,
      tone: fullest.usedPercent >= QUOTA_WARN_PERCENT ? 'warning' : 'calm',
      detail: read(fullest),
      percent: shown,
    });
  }
  return lines;
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * A routine's week in a few words: "$0.84 this week" when every run was
 * priced, else its tokens ("38k tokens this week", Codex reports no price).
 * Null when it hasn't run on its own this week.
 */
export function routineWeekLine(t: UsageTotals | undefined): string | null {
  if (!t || t.turns === 0) return null;
  if (t.pricedTurns === t.turns) {
    return `${t.costUsd < 0.01 ? '<$0.01' : `$${t.costUsd.toFixed(2)}`} this week`;
  }
  const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return `${compactTokens(tokens)} tokens this week`;
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
  }));
}

/** What a dollar figure from Claude Code is: its own price, not the user's bill. */
export const COST_BASIS_NOTE =
  'Priced by Claude Code at API list rates. On a Pro or Max plan it is not what you are billed.';
