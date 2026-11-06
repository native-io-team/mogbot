/**
 * The chat header's usage ring and its Usage sheet, as figures and words.
 * Pure, and only what the Mac serves: the agent's context as its engine
 * reported it (`Agent.context`, agents/context.rs), the plan's windows
 * (`agents.quota`) and every account's (`agents.usagePlan`). Nothing is
 * estimated or filled in: no reading, no row.
 *
 * Not here: a "you'll hit the limit before the reset" pace warning. The Mac
 * serves no forecast of when a window runs out (its estimates are per run,
 * `UsageEstimate`), and a pace guessed on the phone would be an invented
 * number. It belongs here once the Mac sends one.
 */

import {
  accountTags,
  accountUsage,
  QUOTA_STALE_MS,
  QUOTA_WARN_PERCENT,
  readDay,
  resetPhrase,
  windowName,
  type AgentEngine,
  type ContextFill,
  type Quota,
  type QuotaWindow,
  type UsageAccountLine,
  type UsageInventory,
} from '@shipstudio/companion-protocol';

export type UsageTone = 'calm' | 'warning' | 'limited';

/** One figure with its bar: "32% used", and the line under it. */
export interface UsageMeter {
  key: string;
  label: string;
  /** 0–100, floored: "90%" never shows on a window that hasn't reached it. */
  percent: number;
  /** "Resets at 3:20 PM", "319.9K of 1M tokens". */
  detail: string;
  tone: UsageTone;
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
const isSession = (w: QuotaWindow) => w.kind === 'five_hour' || w.windowMinutes === 300;

/** "Resets at 3:20 PM" today, "Resets tomorrow 3:20 PM", "Resets Mon 4:00 PM". */
export function resetsLine(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return 'Reset time not reported';
  const phrase = resetPhrase(at, now);
  return /^\d/.test(phrase) ? `Resets at ${phrase}` : `Resets ${phrase}`;
}

/** An old reading says how old: a figure stands until reset, but use elsewhere since isn't in it. */
const aged = (w: QuotaWindow, now: number) =>
  now - w.observedAt > QUOTA_STALE_MS ? ` · read ${readDay(w.observedAt, now)}` : '';

/** A weekly window's name as the Usage sheet says it: "All models", "Opus", "Sonnet". */
export function weeklyLabel(w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>): string {
  if (w.kind === 'seven_day_opus') return 'Opus';
  if (w.kind === 'seven_day_sonnet') return 'Sonnet';
  if (w.kind === 'seven_day' || w.windowMinutes === 7 * 24 * 60) return 'All models';
  const name = windowName(w);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const meterOf = (key: string, label: string, w: QuotaWindow, now: number): UsageMeter | null => {
  // A window with no figure and not used up has nothing to draw.
  if (w.usedPercent === undefined && !w.limited) return null;
  const percent = usedOf(w);
  return {
    key,
    label,
    percent,
    detail: `${resetsLine(w.resetsAt, now)}${aged(w, now)}`,
    tone: toneOf(percent, w.limited),
  };
};

export interface PlanUsage {
  /** The 5-hour window: "5-hour limit". */
  session: UsageMeter | null;
  /** Each weekly window: "All models", then any per-model ones. */
  weekly: UsageMeter[];
}

/** One engine's plan, as it reported it; null when it hasn't. */
export function planUsage(
  quotas: Quota[] | null | undefined,
  engine: AgentEngine,
  now = Date.now()
): PlanUsage | null {
  const q = quotas?.find((x) => x.engine === engine);
  const windows = q?.windows.filter((w) => live(w, now)) ?? [];
  const sessionWindow = windows.find(isSession);
  const session = sessionWindow ? meterOf('session', '5-hour limit', sessionWindow, now) : null;
  const weekly = windows
    .filter((w) => !isSession(w))
    .sort((a, b) => Number(b.kind === 'seven_day') - Number(a.kind === 'seven_day'))
    .map((w) => meterOf(`week:${w.kind}`, weeklyLabel(w), w, now))
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
  /** "Claude · Work". */
  title: string;
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
      .map((w) =>
        meterOf(`${a.id}:${w.kind}`, isSession(w) ? '5-hour limit' : weeklyLabel(w), w, now)
      )
      .filter((m): m is UsageMeter => m !== null);
    const usage = accountUsage(a, now);
    const showState = !a.signedIn || a.out || meters.length === 0;
    return {
      key: `${a.engine}:${a.id}`,
      title: `${ENGINE_NAME[a.engine] ?? a.engine} · ${a.name}`,
      tags: accountTags(a),
      meters: a.out ? [] : meters,
      state: showState ? usage.text : null,
      tone: usage.tone,
    };
  });
}
