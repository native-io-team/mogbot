/**
 * How the capacity inventory is said (`agents.usagePlan`,
 * `agents_usage_overview`), once, for the desk's Settings and What's in
 * flight and the phone's Settings. Pure.
 *
 * Two kinds of figure, never mixed up:
 * - **Readings**: what an engine reported, with when. Worded as such ("as
 *   reported"), and "No reading" when there is none.
 * - **Estimates**: from this user's past runs (`UsageEstimate`). Always
 *   worded "estimate" and always with how many runs they rest on. None with
 *   too little history; never a default.
 */

import type {
  AgentEngine,
  LocalCompute,
  QuotaWindow,
  SpareWindow,
  UsageAccountLine,
  UsageEstimate,
  UsageInventory,
  UsageMode,
} from './model';
import {
  QUOTA_STALE_MS,
  QUOTA_WARN_PERCENT,
  readDay,
  readPhrase,
  resetDay,
  resetPhrase,
  windowName,
} from './quota';

export const USAGE_MODES: readonly UsageMode[] = ['normal', 'save', 'use_it_all'];

export const USAGE_MODE_LABEL: Record<UsageMode, string> = {
  normal: 'Normal',
  save: 'Save my limits',
  use_it_all: 'Use it all before the refill',
};

/** One line each, what it changes. */
export const USAGE_MODE_DETAIL: Record<UsageMode, string> = {
  normal:
    'Agents never slow down for limits. Before something big, they say what it will likely use.',
  save: 'Routines wait while the account in use is nearly out, until its limit refills. Agents ask before heavy work and send light work to lighter models.',
  use_it_all:
    'Near a refill with usage left over, the Chief starts on your ideas for leftover usage. Allow cards still apply.',
};

const ENGINE_SHORT: Record<AgentEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** The fewest past runs an estimate may rest on (the Mac's `forecast::MIN_RUNS`). */
export const MIN_ESTIMATE_RUNS = 5;

/** "About 41k tokens a turn · estimate from 37 past runs". */
export function estimateLine(e: UsageEstimate | undefined, unit = 'turn'): string | null {
  // The Mac never sends one under the floor; a guard, so a bad value can't show as a figure.
  if (!e || e.estimate !== true || e.runs < MIN_ESTIMATE_RUNS) return null;
  return `About ${compact(e.tokens)} tokens a ${unit} · estimate from ${e.runs} past run${e.runs === 1 ? '' : 's'}`;
}

/** One window of an account, as reported: "5-hour 38% · resets 3:00 PM". */
export function windowLine(w: QuotaWindow, now = Date.now()): string {
  const name = windowName(w);
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  const full = w.limited || (w.usedPercent ?? 0) >= 100;
  const used = full
    ? 'used up'
    : w.usedPercent === undefined
      ? 'no figure'
      : `${Math.max(0, Math.floor(w.usedPercent))}%`;
  const reset = w.resetsAt ? ` · refills ${resetDay(w.resetsAt, now)}` : '';
  const age =
    !full && now - w.observedAt > QUOTA_STALE_MS ? ` · read ${readDay(w.observedAt, now)}` : '';
  return `${label} ${used}${reset}${age}`;
}

export type UsageTone = 'calm' | 'warning' | 'limited';

/** An account's state in a few words, only what is known. */
export function accountUsage(
  a: UsageAccountLine,
  now = Date.now()
): { text: string; tone: UsageTone } {
  if (!a.signedIn) return { text: 'Not signed in', tone: 'calm' };
  if (a.out) {
    return {
      text: a.outUntil
        ? `Out of usage until ${resetPhrase(a.outUntil, now)}`
        : 'Out of usage · refill time not reported',
      tone: 'limited',
    };
  }
  if (a.windows.length === 0) return { text: 'No reading yet', tone: 'calm' };
  const warn = a.windows.some((w) => (w.usedPercent ?? 0) >= QUOTA_WARN_PERCENT);
  return {
    text: a.windows.map((w) => windowLine(w, now)).join(' · '),
    tone: warn ? 'warning' : 'calm',
  };
}

/** "Plus plan" from the engine's own word for it ("plus", "Max"). */
export function planLabel(plan: string): string {
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;
}

/** "Plus plan" when the engine said; "Next turns run here" for the next. */
export function accountTags(a: UsageAccountLine): string[] {
  const tags: string[] = [];
  if (a.plan) tags.push(planLabel(a.plan));
  if (a.next) tags.push('Next turns run here');
  return tags;
}

/** "Ollama · running · llama3.2:3b", "Opencode · installed". */
export function localLine(l: LocalCompute): string {
  if (l.running === undefined) return `${l.name} · installed`;
  if (!l.running) return `${l.name} · installed, not running`;
  if (l.models.length === 0) return `${l.name} · running`;
  const shown = l.models.slice(0, 3).join(', ');
  const more = l.models.length > 3 ? ` +${l.models.length - 3}` : '';
  return `${l.name} · running · ${shown}${more}`;
}

/**
 * The names a Mac gives an account nobody named, which describe a place,
 * not an account ("This Mac" from older Macs, "Signed in on this Mac" when
 * the engine doesn't record who). Never shown as an account's name
 * (`accountLabel`).
 */
const PLACE_NAMES = new Set(['this mac', 'signed in on this mac']);

export const isPlaceName = (name: string) => PLACE_NAMES.has(name.trim().toLowerCase());

export interface SpareLine {
  /** "Claude 5-hour limit resets 3:00 PM · 62% left". */
  text: string;
  /** Where it came from and what happens next. */
  detail: string;
}

function spareText(s: SpareWindow, now: number): string {
  const left = Math.max(0, Math.floor(100 - s.usedPercent));
  return `${ENGINE_SHORT[s.engine]} ${windowName(s)} limit refills ${resetDay(s.resetsAt, now)} · ${left}% left`;
}

/**
 * What's in flight's line, when a window on the account turns run on next
 * is near its reset with capacity left. Null otherwise: spare capacity on an
 * account turns don't reach isn't news to act on.
 */
export function spareLine(
  inv: UsageInventory | null | undefined,
  now = Date.now()
): SpareLine | null {
  const s = inv?.spare.find((w) => w.next && w.resetsAt > now);
  if (!inv || !s) return null;
  const waiting = inv.backlog.filter((i) => i.state === 'waiting').length;
  const when = readPhrase(s.observedAt, now);
  // "This Mac" is where it is signed in, not an account's name.
  const reported = isPlaceName(s.accountName)
    ? `As reported ${when}.`
    : `On ${s.accountName}, as reported ${when}.`;
  const next =
    inv.mode === 'use_it_all'
      ? waiting > 0
        ? ` The Chief will use it on your ideas for leftover usage (${waiting} waiting).`
        : inv.backlog.length === 0
          ? ' Your list of ideas for leftover usage is empty.'
          : ' Nothing is waiting on your list of ideas for leftover usage.'
      : '';
  return { text: spareText(s, now), detail: `${reported}${next}` };
}

/** One row of the phone's read-only Usage section. */
export interface UsageRow {
  key: string;
  label: string;
  value?: string;
  detail?: string;
  warning?: boolean;
}

/**
 * The phone's Usage section: the mode, a reset near with capacity left,
 * each engine's average turn (an estimate, when there's history), the
 * spare-capacity list's size and other compute. Read-only: the mode and the
 * list are changed on the Mac, or by asking the Chief.
 */
export function usageRows(inv: UsageInventory | null | undefined, now = Date.now()): UsageRow[] {
  if (!inv) return [];
  const rows: UsageRow[] = [
    {
      key: 'mode',
      label: USAGE_MODE_LABEL[inv.mode],
      detail: USAGE_MODE_DETAIL[inv.mode],
    },
  ];
  const spare = spareLine(inv, now);
  if (spare) rows.push({ key: 'spare', label: spare.text, detail: spare.detail });
  for (const e of inv.engines) {
    const est = e.installed ? estimateLine(e.perTurn) : null;
    if (est) rows.push({ key: `est:${e.id}`, label: `${e.label}: average turn`, detail: est });
  }
  const waiting = inv.backlog.filter((i) => i.state === 'waiting').length;
  rows.push({
    key: 'backlog',
    label: 'Ideas for leftover usage',
    value: inv.backlog.length === 0 ? 'Empty' : `${waiting} waiting`,
  });
  for (const l of inv.local) rows.push({ key: `local:${l.name}`, label: localLine(l) });
  return rows;
}
