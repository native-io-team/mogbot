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
    default:
      return 'Unknown';
  }
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

/** A local date as `YYYY-MM-DD`, the way the grammar writes one. */
export function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The local time `hour:minute` on a `YYYY-MM-DD` date. */
export function localTs(date: string, hour: number, minute: number): number {
  // Indexed, not destructured: under the app's Babel a destructure pulls in a
  // runtime helper this package (which has no dependencies) can't resolve.
  const ymd = date.split('-').map(Number);
  return new Date(ymd[0], ymd[1] - 1, ymd[2], hour, minute).getTime();
}

/** The `when` words for the Mac: "every weekday at 09:00", "every 2 hours", "2026-11-20 09:00". */
export function routineWhenPhrase(w: RoutineWhen): string {
  if (w.kind === 'once') return `${w.date} ${pad2(w.hour)}:${pad2(w.minute)}`;
  if (w.kind === 'every') return scheduleWhenPhrase({ repeat: w, nextAt: 0 });
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  return scheduleWhenPhrase({ repeat: { ...w, days }, nextAt: 0 });
}

/** A check-in as the picker shows it, for Edit. */
export function routineWhenOf(c: Pick<CheckIn, 'repeat' | 'nextAt'>): RoutineWhen {
  const r = c.repeat;
  if (r?.kind === 'every') return { kind: 'every', minutes: r.minutes };
  if (r) return { kind: 'days', days: [...r.days], hour: r.hour, minute: r.minute };
  const d = new Date(c.nextAt);
  return { kind: 'once', date: localDate(c.nextAt), hour: d.getHours(), minute: d.getMinutes() };
}

/**
 * What the picker will make, in the words the list shows it in:
 * "Every weekday at 9:00 AM", "Every 2 hours", "Once · Tomorrow 9:00 AM".
 */
export function describeRoutineWhen(w: RoutineWhen, now = Date.now()): string {
  if (w.kind === 'once') return `Once · ${formatWhen(localTs(w.date, w.hour, w.minute), now)}`;
  if (w.kind === 'every') return describeRepeat(w);
  return describeRepeat({ ...w, days: [...new Set(w.days)] });
}

/** The picker's echo, the check-in in one line: "Every weekday at 9:00 AM — Draft my day". */
export function routineEcho(w: RoutineWhen, note: string, now = Date.now()): string {
  const what = note.trim().replace(/\s+/g, ' ');
  const when = describeRoutineWhen(w, now);
  return what ? `${when} — ${what}` : when;
}

/** A once that's already past can't run: the picker says so before the Mac has to. */
export function routineInPast(w: RoutineWhen, now = Date.now()): boolean {
  return w.kind === 'once' && localTs(w.date, w.hour, w.minute) <= now;
}
