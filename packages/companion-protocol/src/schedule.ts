/**
 * How check-ins and routines are written down, on the desk and the phone
 * alike: the one-line "when: what" composer split, a schedule's words, and
 * the list order. Pure, and moved here from the desktop's src/lib/agents.ts
 * (which re-exports them) so both clients word a schedule the same way.
 */

import type { CheckIn, CheckInRun, Repeat } from './model';

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
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "9:00 AM" in the user's locale, the same way `formatWhen` writes times. */
const clockText = (hour: number, minute: number) =>
  CLOCK.format(new Date(2000, 0, 1, hour, minute));

/** "Every weekday at 9:00 AM", "Every 2 hours" — `schedule::describe`'s words, locale times. */
export function describeRepeat(repeat: Repeat): string {
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
 * - `once`: on a local date (`YYYY-MM-DD`) at a time.
 */
export type RoutineWhen =
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'every'; minutes: number }
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
  if (r) return { kind: 'days', days: [...r.days], hour: r.hour, minute: r.minute };
  const w = wallClock(c.nextAt, timeZone);
  return { kind: 'once', date: localDate(c.nextAt, timeZone), hour: w.hour, minute: w.minute };
}

/**
 * What the picker will make, in the words the list shows it in:
 * "Every weekday at 9:00 AM", "Every 2 hours", "Once · Tomorrow 9:00 AM",
 * with "Mac time" after the time when the Mac's clock isn't this phone's.
 */
export function describeRoutineWhen(w: RoutineWhen, now = Date.now(), timeZone?: string): string {
  if (w.kind === 'every') return describeRepeat(w);
  const note = zoneNote(timeZone, now);
  if (w.kind === 'once') {
    const ts = localTs(w.date, w.hour, w.minute, timeZone);
    return `Once · ${formatWhenIn(ts, now, timeZone)}${note}`;
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
