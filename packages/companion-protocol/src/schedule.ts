/**
 * How check-ins and routines are written down, on the desk and the phone
 * alike: the one-line "when: what" composer split, a schedule's words, and
 * the list order. Pure, and moved here from the desktop's src/lib/agents.ts
 * (which re-exports them) so both clients word a schedule the same way.
 */

import { formatClock } from './clock';
import type { CheckIn, CheckInRun, MonthDay, Repeat, Watch, WatchSource } from './model';

/**
 * The one honest limit of a routine, said where one is set up (the routine
 * picker, desk and phone, and under the Chief's starters once one that
 * repeats is picked): the same sentence everywhere.
 */
export const ROUTINES_NEED_THE_MAC =
  'Routines run only while the app is open and this Mac is awake. One that was missed runs once when it’s back.';

/** What a scheduled run came to, in a few words. */
export function describeRun(run: CheckInRun, now = Date.now()): string {
  switch (run.outcome) {
    case 'running':
      return 'Running';
    case 'ran':
      return run.attempt > 1 ? `Ran on try ${run.attempt}` : 'Ran';
    case 'retrying':
      return run.retryAt
        ? `Didn’t run · retrying ${formatWhen(run.retryAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`
        : 'Didn’t run · retrying';
    case 'failed':
      return run.attempt > 1 ? `Didn’t run after ${run.attempt} tries` : 'Didn’t run';
    case 'skipped':
      // Its time came while you drove the agent's session (the detail says so).
      return 'Skipped';
    case 'waiting':
      return run.step ? `Waiting for your OK after step ${run.step}` : 'Waiting for your OK';
    case 'declined':
      return run.step ? `Stopped after step ${run.step}` : 'Stopped';
    case 'held':
      // A usage limit to refill first (the detail says which, and when).
      return run.retryAt
        ? `Waiting for the refill · runs ${formatWhen(run.retryAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`
        : 'Waiting for the refill';
    default:
      return 'Unknown';
  }
}

/**
 * A run's failure detail in plain words. The detail is whatever the engine
 * printed ("API Error: 529 overloaded"); the provider's status codes are
 * said as what they mean, and anything unrecognised is shown as it came.
 */
export function describeRunDetail(detail: string): string {
  const d = detail.trim();
  if (/\b529\b|overloaded/i.test(d)) return 'The service was busy';
  if (/\b429\b|rate.?limit/i.test(d)) return 'Too many requests at once';
  if (/api error:?\s*5\d\d\b|internal server error|bad gateway|service unavailable/i.test(d))
    return 'The service had a problem';
  if (/timed? ?out|ETIMEDOUT/i.test(d)) return 'It took too long and was stopped';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(d)) return 'Couldn’t reach the service';
  return d;
}

/**
 * Formatters are built once: `toLocaleTimeString` with options builds a new
 * one per call, which over a few hundred rows was the costliest part of a
 * chat render.
 */
/** The user's clock (`clock.ts`): "9:00 AM" or "09:00", as the Mac says. */
const CLOCK = { format: formatClock };
const SHORT_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "9:00 AM" (or "09:00") as the user reads times, the same way `formatWhen` writes times. */
const clockText = (hour: number, minute: number) =>
  CLOCK.format(new Date(2000, 0, 1, hour, minute));

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "1st", "22nd", "13th": `schedule::ordinal_text`. */
export function ordinalText(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : ones === 1
        ? 'st'
        : ones === 2
          ? 'nd'
          : ones === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}

/** first … fourth, and last (-1): which of a weekday in a month. */
export const NTH_WORDS: Record<number, string> = {
  1: 'first',
  2: 'second',
  3: 'third',
  4: 'fourth',
  [-1]: 'last',
};

/** "the 1st", "the last day", "the second Tuesday", "the last Friday". */
export function describeMonthDay(on: MonthDay): string {
  if ('nth' in on) return `the ${NTH_WORDS[on.nth] ?? 'last'} ${DAY_NAMES[on.weekday % 7]}`;
  return on.day < 0 ? 'the last day' : `the ${ordinalText(on.day)}`;
}

interface Monthly {
  months: number;
  on: MonthDay;
  hour: number;
  minute: number;
}

/** "Every month on the 1st at 9:00 AM", "Every 3 months on the last Friday at 4:00 PM". */
function describeMonthly(m: Monthly): string {
  const every = m.months > 1 ? `${m.months} months` : 'month';
  return `Every ${every} on ${describeMonthDay(m.on)} at ${clockText(m.hour, m.minute)}`;
}

/**
 * The grammar's words for a monthly routine: "every month on the 1st at
 * 09:00", "every 3 months on the last friday at 16:00 starting january".
 * `start` (1–12) is the month its next run is in, so an edit keeps it to
 * the same months; without one the Mac counts from the next run.
 */
function monthlyPhrase(m: Monthly & { start?: number }): string {
  const every = m.months > 1 ? `${m.months} months` : 'month';
  const on = describeMonthDay(m.on).toLowerCase();
  const start =
    m.months > 1 && m.start ? ` starting ${MONTH_NAMES[(m.start - 1) % 12].toLowerCase()}` : '';
  return `every ${every} on ${on} at ${pad2(m.hour)}:${pad2(m.minute)}${start}`;
}

/** "Every weekday at 9:00 AM", "Every 2 hours" — `schedule::describe`'s words, locale times. */
export function describeRepeat(repeat: Repeat): string {
  if (repeat.kind === 'monthly') return describeMonthly(repeat);
  if (repeat.kind === 'every') {
    const { minutes } = repeat;
    if (minutes % 60 !== 0) return `Every ${minutes} minutes`;
    return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  }
  const days = [...repeat.days].sort((a, b) => a - b).join(',');
  const named =
    days === '0,1,2,3,4,5,6'
      ? 'day'
      : days === '1,2,3,4,5'
        ? 'weekday'
        : days === '0,6'
          ? 'weekend day'
          : repeat.days
              .map((d) => DAY_NAMES[d % 7])
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1');
  return `Every ${named} at ${clockText(repeat.hour, repeat.minute)}`;
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Thu, Nov 5 9:00 AM". */
export function formatWhen(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = CLOCK.format(date);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const start = today.getTime();
  if (ts >= start && ts < start + dayMs) return `Today ${time}`;
  if (ts >= start + dayMs && ts < start + 2 * dayMs) return `Tomorrow ${time}`;
  return `${SHORT_DAY.format(date)} ${time}`;
}

/**
 * `formatWhen` for the middle of a sentence: "today at 9:00 AM", "tomorrow
 * at 9:00 AM", "Thu, Nov 6 at 9:00 AM" ("was due today at 9:00 AM", never
 * "was due Today 9:00 AM").
 */
export function formatWhenInline(ts: number, now = Date.now()): string {
  const when = formatWhen(ts, now);
  const time = CLOCK.format(new Date(ts));
  const day = when.slice(0, when.length - time.length).trim();
  const lead = day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : day;
  return `${lead} at ${time}`;
}

/**
 * The schedule composer takes one line, "when: what" — "every weekday 9am:
 * brief me on Acme". The split is the first colon followed by a space, so
 * clock times ("9:30") stay whole. No such colon yet: it's all "when".
 */
export function splitScheduleInput(text: string): { when: string; note: string } {
  const match = /^(.*?):\s+([\s\S]*)$/.exec(text);
  if (!match) return { when: text.trim().replace(/:$/, ''), note: '' };
  return { when: match[1].trim(), note: match[2].trim() };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The `when` words the schedule grammar reads back as this same schedule,
 * for Edit to prefill: "every weekday at 09:00", "every 2 hours",
 * "2026-11-20 09:00" (local). Mirrors `schedule::describe`.
 */
export function scheduleWhenPhrase(c: Pick<CheckIn, 'repeat' | 'nextAt'>): string {
  const r = c.repeat;
  if (!r) {
    const d = new Date(c.nextAt);
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (r.kind === 'every') {
    if (r.minutes % 60 !== 0) return `every ${r.minutes} minutes`;
    return r.minutes === 60 ? 'every hour' : `every ${r.minutes / 60} hours`;
  }
  if (r.kind === 'monthly') {
    const start = c.nextAt > 0 ? new Date(c.nextAt).getMonth() + 1 : undefined;
    return monthlyPhrase({ ...r, start });
  }
  const days = [...r.days].sort((a, b) => a - b);
  const key = days.join(',');
  const named =
    key === '0,1,2,3,4,5,6'
      ? 'day'
      : key === '1,2,3,4,5'
        ? 'weekday'
        : key === '0,6'
          ? 'weekend day'
          : days
              .map((d) => DAY_NAMES[d % 7].toLowerCase())
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1');
  return `every ${named} at ${pad2(r.hour)}:${pad2(r.minute)}`;
}

/** A row's secondary line: when it next runs, and how it repeats. */
export function describeCheckInTime(c: CheckIn, now = Date.now()): string {
  const lower = (w: string) => w.toLowerCase();
  if (c.retry && !c.paused) {
    const retry = `retrying ${formatWhen(c.retry.at, now).replace(/^(Today|Tomorrow)/, lower)}`;
    if (!c.repeat) return `Didn’t run · ${retry}`;
    return `${describeRepeat(c.repeat)} · ${retry}`;
  }
  if (!c.repeat) return formatWhen(c.nextAt, now);
  const repeat = describeRepeat(c.repeat);
  if (c.paused) return `Paused · ${repeat}`;
  const next = formatWhen(c.nextAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return `${repeat} · next ${next}`;
}

/** Soonest first; paused ones last. */
export function sortCheckIns(checkIns: CheckIn[]): CheckIn[] {
  return [...checkIns].sort((a, b) =>
    a.paused !== b.paused ? (a.paused ? 1 : -1) : a.nextAt - b.nextAt
  );
}

/**
 * A schedule as the phone's picker holds it: a cadence and a time, never
 * words. `routineWhenPhrase` writes it in the grammar the Mac reads, so the
 * picker and the desk's one-line composer make the same check-in.
 *
 * - `days`: on those weekdays (0 = Sunday) at a time: every day, weekdays,
 *   or every Monday and Thursday;
 * - `every`: every so many minutes, from now;
 * - `monthly`: on a day of the month at a time, every month or every few;
 *   `start` (1–12) is the month its next run is in, kept by an edit so
 *   "every 3 months" stays on the same months;
 * - `once`: on a local date (`YYYY-MM-DD`) at a time.
 */
export type RoutineWhen =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number }
  | {
      kind: 'monthly';
      months: number;
      on: MonthDay;
      hour: number;
      minute: number;
      start?: number;
    }
  | { kind: 'once'; date: string; hour: number; minute: number };

/**
 * The routine picker works in the Mac's wall clock, not the phone's: the
 * Mac reads "every weekday at 09:00" and "2026-11-20 09:00" in its own zone
 * (`welcome.timeZone`). Every function below takes that zone; without one
 * (an older Mac, or the desk itself) it's this device's own.
 */
export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** One formatter per zone, for the reason the ones above are built once. */
const wallFormats = new Map<string, Intl.DateTimeFormat | null>();
function wallFormat(timeZone: string): Intl.DateTimeFormat | null {
  if (!wallFormats.has(timeZone)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      });
    } catch {
      // A zone this device doesn't know: its own clock is the best left.
      f = null;
    }
    wallFormats.set(timeZone, f);
  }
  return wallFormats.get(timeZone) ?? null;
}

/** The wall clock at `ts` in `timeZone` (this device's own without one). */
export function wallClock(ts: number, timeZone?: string): WallClock {
  const f = timeZone ? wallFormat(timeZone) : null;
  if (!f) {
    const d = new Date(ts);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday: d.getDay(),
    };
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines write midnight as 24 even in h23.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? new Date(ts).getDay(),
  };
}

/** How far `timeZone` is ahead of UTC at `ts`, in ms. */
function offsetAt(ts: number, timeZone?: string): number {
  const w = wallClock(ts, timeZone);
  const minute = Math.floor(ts / 60_000) * 60_000;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - minute;
}

/**
 * Whether `timeZone` reads a different clock from this device at `ts`: the
 * picker then says "Mac time" after a time, so 9:00 AM is never mistaken
 * for the phone's 9:00 AM.
 */
export function zoneDiffers(timeZone: string | undefined, ts = Date.now()): boolean {
  if (!timeZone || !wallFormat(timeZone)) return false;
  return offsetAt(ts, timeZone) !== offsetAt(ts);
}

/** " Mac time" after a time when the Mac's clock isn't this device's. */
const zoneNote = (timeZone: string | undefined, ts: number) =>
  zoneDiffers(timeZone, ts) ? ' Mac time' : '';

/** A local date as `YYYY-MM-DD`, the way the grammar writes one, in `timeZone`. */
export function localDate(ts: number, timeZone?: string): string {
  const w = wallClock(ts, timeZone);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** The instant that reads `hour:minute` on a `YYYY-MM-DD` date in `timeZone`. */
export function localTs(date: string, hour: number, minute: number, timeZone?: string): number {
  // Indexed, not destructured: under the app's Babel a destructure pulls in a
  // runtime helper this package (which has no dependencies) can't resolve.
  const ymd = date.split('-').map(Number);
  if (!timeZone || !wallFormat(timeZone)) {
    return new Date(ymd[0], ymd[1] - 1, ymd[2], hour, minute).getTime();
  }
  // That wall clock as if it were UTC, then corrected by the zone's offset
  // there (twice, so a date across a DST change from now lands right).
  const asUtc = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], hour, minute);
  const first = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(first, timeZone);
}

/** "Today 9:00 AM" as `formatWhen` says it, in `timeZone`'s days and clock. */
/**
 * `formatWhenIn` inside a sentence: "tomorrow at 9:00 AM", "Fri, Nov 13 at
 * 9:00 AM", as `formatWhenInline` writes this Mac's own times.
 */
export function formatWhenInlineIn(ts: number, now = Date.now(), timeZone?: string): string {
  return formatWhenIn(ts, now, timeZone)
    .replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())
    .replace(/ (\d{1,2}[:.]\d{2}(?:\s?[^\s\d]+)?)$/, ' at $1');
}

export function formatWhenIn(ts: number, now = Date.now(), timeZone?: string): string {
  if (!timeZone || !wallFormat(timeZone)) return formatWhen(ts, now);
  const w = wallClock(ts, timeZone);
  const today = localDate(now, timeZone);
  const tomorrow = nextDate(today, 1);
  const date = localDate(ts, timeZone);
  const time = clockText(w.hour, w.minute);
  if (date === today) return `Today ${time}`;
  if (date === tomorrow) return `Tomorrow ${time}`;
  return `${SHORT_DAY.format(new Date(w.year, w.month - 1, w.day, 12))} ${time}`;
}

/** `YYYY-MM-DD` plus `days`, by the calendar alone. */
export function nextDate(date: string, days: number): string {
  const ymd = date.split('-').map(Number);
  const d = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] + days));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The `when` words for the Mac: "every weekday at 09:00", "every 2 hours", "2026-11-20 09:00". */
export function routineWhenPhrase(w: RoutineWhen): string {
  if (w.kind === 'once') return `${w.date} ${pad2(w.hour)}:${pad2(w.minute)}`;
  if (w.kind === 'every') return scheduleWhenPhrase({ repeat: w, nextAt: 0 });
  if (w.kind === 'monthly') return monthlyPhrase(w);
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  return scheduleWhenPhrase({ repeat: { ...w, days }, nextAt: 0 });
}

/** A check-in as the picker shows it, for Edit; a one-off on the Mac's clock. */
export function routineWhenOf(
  c: Pick<CheckIn, 'repeat' | 'nextAt'>,
  timeZone?: string
): RoutineWhen {
  const r = c.repeat;
  if (r?.kind === 'every') return { kind: 'every', minutes: r.minutes };
  if (r?.kind === 'monthly') {
    const start = r.months > 1 ? wallClock(c.nextAt, timeZone).month : undefined;
    const on: MonthDay =
      'nth' in r.on ? { nth: r.on.nth, weekday: r.on.weekday } : { day: r.on.day };
    return { kind: 'monthly', months: r.months, on, hour: r.hour, minute: r.minute, start };
  }
  if (r) return { kind: 'days', days: [...r.days], hour: r.hour, minute: r.minute };
  const w = wallClock(c.nextAt, timeZone);
  return { kind: 'once', date: localDate(c.nextAt, timeZone), hour: w.hour, minute: w.minute };
}

/**
 * What the picker will make, in the words the list shows it in:
 * "Every weekday at 9:00 AM", "Every 2 hours", "Once, tomorrow at 9:00 AM",
 * with "Mac time" after the time when the Mac's clock isn't this phone's.
 */
export function describeRoutineWhen(w: RoutineWhen, now = Date.now(), timeZone?: string): string {
  if (w.kind === 'every') return describeRepeat(w);
  const note = zoneNote(timeZone, now);
  if (w.kind === 'monthly') return `${describeMonthly(w)}${note}`;
  if (w.kind === 'once') {
    const ts = localTs(w.date, w.hour, w.minute, timeZone);
    return `Once, ${formatWhenInlineIn(ts, now, timeZone)}${note}`;
  }
  return `${describeRepeat({ ...w, days: [...new Set(w.days)] })}${note}`;
}

/** The picker's echo, the check-in in one line: "Every weekday at 9:00 AM — Draft my day". */
export function routineEcho(w: RoutineWhen, note: string, now = Date.now(), timeZone?: string) {
  const what = note.trim().replace(/\s+/g, ' ');
  const when = describeRoutineWhen(w, now, timeZone);
  return what ? `${when} — ${what}` : when;
}

/** A once that's already past can't run: the picker says so before the Mac has to. */
export function routineInPast(w: RoutineWhen, now = Date.now(), timeZone?: string): boolean {
  return w.kind === 'once' && localTs(w.date, w.hour, w.minute, timeZone) <= now;
}

/* ------------------------------------------------- "When…" routines */

/** What it waits for, after "When": mirrors `watch::describe`. */
export function describeWatchSource(source: WatchSource): string {
  switch (source.kind) {
    case 'github_mentions':
      return 'someone mentions you on GitHub';
    case 'github_assigned':
      return 'an issue or pull request is assigned to you on GitHub';
    case 'linear_assigned':
      return 'a Linear issue is assigned to you';
    case 'new_file':
      return `a new file appears in ${source.folder}`;
    case 'custom':
      return source.check.trim().replace(/\.$/, '');
    default:
      return 'something this version of the app doesn’t know';
  }
}

/** "When someone mentions you on GitHub". */
export function describeWatchTitle(source: WatchSource): string {
  return `When ${describeWatchSource(source)}`;
}

/** Whether each check is a model call (a connector), not a free CLI call. */
export function watchUsesModel(source: WatchSource): boolean {
  return source.kind === 'linear_assigned' || source.kind === 'custom';
}

/** "every 10 min", "every hour". */
export function describeEvery(minutes: number): string {
  if (minutes === 1) return 'every minute';
  if (minutes < 60 || minutes % 60 !== 0) return `every ${minutes} min`;
  return minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`;
}

/** Model checks a routine makes in a day, at most, unless it says otherwise (`watch::DEFAULT_MAX_CHECKS_PER_DAY`). */
export const DEFAULT_MAX_CHECKS_PER_DAY = 24;

/** A local day, as `watch::DayChecks::day` writes it. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** It has made today's model checks: none more until tomorrow. */
export function watchCappedToday(w: Watch, now = Date.now()): boolean {
  const cap = w.maxChecksPerDay ?? DEFAULT_MAX_CHECKS_PER_DAY;
  return !!w.dayChecks && w.dayChecks.day === dayKey(now) && w.dayChecks.checks >= cap;
}

/** "3 min ago", "just now": how long since a check, for a row. */
function ago(ts: number, now: number): string {
  const min = Math.round((now - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return formatWhen(ts, now);
}

/**
 * A "When…" row's secondary line: how often, then what the last check
 * found, or why it's paused or failing. Only what the Mac recorded.
 */
export function describeWatchStatus(c: CheckIn, now = Date.now()): string {
  const w = c.watch;
  if (!w) return describeCheckInTime(c, now);
  const every = `Checks ${describeEvery(w.everyMinutes)}`;
  if (c.paused) return w.pausedNote ?? `Paused · ${every.toLowerCase()}`;
  if (c.retry) {
    return `Didn’t finish · retrying ${formatWhen(c.retry.at, now).replace(/^(Today|Tomorrow)/, (x) => x.toLowerCase())}`;
  }
  if (w.failures > 0 && w.lastError) return `Last check failed: ${w.lastError}`;
  if (watchCappedToday(w, now)) {
    const cap = w.maxChecksPerDay ?? DEFAULT_MAX_CHECKS_PER_DAY;
    return `Made today’s ${cap} checks · checks again tomorrow`;
  }
  if (w.baselineAt === undefined && w.emptyAnswers)
    return `${every} · found nothing yet; the next check confirms that before anything starts work`;
  if (w.baselineAt === undefined)
    return `${every} · first check soon, to note what’s already there`;
  const parts = [every];
  if (w.lastCheckedAt !== undefined) parts.push(`checked ${ago(w.lastCheckedAt, now)}`);
  if (w.lastFoundAt !== undefined && w.lastFound > 0) {
    parts.push(
      `last found ${w.lastFound} ${formatWhen(w.lastFoundAt, now).replace(/^(Today|Tomorrow)/, (x) => x.toLowerCase())}`
    );
  } else {
    parts.push('nothing new yet');
  }
  return parts.join(' · ');
}
