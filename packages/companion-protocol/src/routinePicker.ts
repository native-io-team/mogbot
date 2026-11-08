/**
 * The routine picker's state, and the schedule it means: the phone's
 * schedule sheet and the desk's schedule popover both build on it, so the
 * two pickers make the same check-in. Pure, so the picker is tested without
 * a screen: the chips choose a cadence, the time picker a time, and `whenOf`
 * turns them into the `RoutineWhen` the Mac is sent (as the grammar's own
 * words, `routineWhenPhrase`).
 *
 * Dates and days are the Mac's (`timeZone`, from `welcome.timeZone`): it
 * reads the picker's words on its own clock, so "Today" is its today.
 */

import type { MonthDay } from './model';
import {
  localDate,
  nextDate,
  NTH_WORDS,
  ordinalText,
  wallClock,
  type RoutineWhen,
} from './schedule';

export type Cadence = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hours' | 'once';

export interface PickerState {
  cadence: Cadence;
  /** Weekly: the days it runs on, 0 = Sunday. */
  days: number[];
  /** Every few hours: how often, in minutes. */
  minutes: number;
  /** Once: the local date, `YYYY-MM-DD`. */
  date: string;
  /** Monthly: every this many months, and which day of the month. */
  months: number;
  monthDay: MonthDay;
  /**
   * Monthly, from an edit: the month (1–12) its next run is in, so a
   * routine every 3 months stays on the same months when its day or time
   * changes. A new one counts from its first run.
   */
  monthStart?: number;
  hour: number;
  minute: number;
}

export const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'once', label: 'Once' },
];

/** Monday first, as a week reads; values are the grammar's (0 = Sunday). */
export const WEEK: { day: number; short: string; name: string }[] = [
  { day: 1, short: 'Mon', name: 'Monday' },
  { day: 2, short: 'Tue', name: 'Tuesday' },
  { day: 3, short: 'Wed', name: 'Wednesday' },
  { day: 4, short: 'Thu', name: 'Thursday' },
  { day: 5, short: 'Fri', name: 'Friday' },
  { day: 6, short: 'Sat', name: 'Saturday' },
  { day: 0, short: 'Sun', name: 'Sunday' },
];

/** The intervals offered; an edited routine on another keeps its own as a chip too. */
export const INTERVALS = [60, 120, 240];

export const intervalLabel = (minutes: number) =>
  minutes % 60 !== 0
    ? `Every ${minutes} min`
    : minutes === 60
      ? 'Every hour'
      : `Every ${minutes / 60} hours`;

/** How many months apart a monthly routine can be offered as; an edited one keeps its own too. */
export const MONTH_INTERVALS = [1, 3];

export const monthsLabel = (months: number) =>
  months === 1 ? 'Every month' : `Every ${months} months`;

/**
 * Monthly reads as a sentence, "On the [15th] [day]" or "On the [last]
 * [Friday]": which one, then of what. `'day'` is a date in the month.
 */
export type MonthKind = 'day' | number;

/** What "of what" offers: a date, or one of the weekdays (Monday first). */
export const MONTH_KINDS: { value: MonthKind; label: string }[] = [
  { value: 'day', label: 'day' },
  ...[1, 2, 3, 4, 5, 6, 0].map((day) => ({
    value: day,
    label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
  })),
];

export const monthKindOf = (on: MonthDay): MonthKind => ('nth' in on ? on.weekday : 'day');

/** Which one: 1–31 or -1 for a date, 1–4 or -1 for a weekday. */
export const monthWhichOf = (on: MonthDay): number => ('nth' in on ? on.nth : on.day);

/** "Which one" for this kind: the 1st to the 31st and the last day, or the first to the last weekday. */
export function monthWhichChoices(kind: MonthKind): { value: number; label: string }[] {
  if (kind === 'day') {
    return [
      ...Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: ordinalText(i + 1) })),
      { value: -1, label: 'last' },
    ];
  }
  return [1, 2, 3, 4, -1].map((n) => ({ value: n, label: NTH_WORDS[n] }));
}

/** Another "which one", keeping the kind. */
export function setMonthWhich(on: MonthDay, which: number): MonthDay {
  return 'nth' in on ? { nth: which, weekday: on.weekday } : { day: which };
}

/**
 * Another kind, keeping "which" where it still means something: the 2nd →
 * the second Tuesday, the last day → the last Friday; the 20th, which no
 * weekday has, → the first.
 */
export function setMonthKind(on: MonthDay, kind: MonthKind): MonthDay {
  const which = monthWhichOf(on);
  if (kind === 'day') return { day: which };
  return { nth: which === -1 || (which >= 1 && which <= 4) ? which : 1, weekday: kind };
}

const ALL = [0, 1, 2, 3, 4, 5, 6];
const WORK = [1, 2, 3, 4, 5];
const same = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);

/** A new routine: weekdays at 9:00, the most asked-for. */
export function newPicker(now = Date.now(), timeZone?: string): PickerState {
  return {
    cadence: 'weekdays',
    days: [wallClock(now, timeZone).weekday],
    minutes: 60,
    date: localDate(now, timeZone),
    months: 1,
    monthDay: { day: 1 },
    hour: 9,
    minute: 0,
  };
}

/** An existing check-in, as the picker shows it for Edit. */
export function pickerOf(w: RoutineWhen, now = Date.now(), timeZone?: string): PickerState {
  const base = newPicker(now, timeZone);
  if (w.kind === 'every') return { ...base, cadence: 'hours', minutes: w.minutes };
  if (w.kind === 'once') {
    return { ...base, cadence: 'once', date: w.date, hour: w.hour, minute: w.minute };
  }
  if (w.kind === 'monthly') {
    return {
      ...base,
      cadence: 'monthly',
      months: w.months,
      monthDay: w.on,
      monthStart: w.start,
      hour: w.hour,
      minute: w.minute,
    };
  }
  const cadence: Cadence = same(w.days, ALL) ? 'daily' : same(w.days, WORK) ? 'weekdays' : 'weekly';
  return { ...base, cadence, days: [...w.days], hour: w.hour, minute: w.minute };
}

/** What the picker means. Null while it means nothing yet (weekly with no day). */
export function whenOf(s: PickerState): RoutineWhen | null {
  const at = { hour: s.hour, minute: s.minute };
  switch (s.cadence) {
    case 'daily':
      return { kind: 'days', days: ALL, ...at };
    case 'weekdays':
      return { kind: 'days', days: WORK, ...at };
    case 'weekly':
      return s.days.length
        ? { kind: 'days', days: [...new Set(s.days)].sort((a, b) => a - b), ...at }
        : null;
    case 'monthly':
      return {
        kind: 'monthly',
        months: s.months,
        on: s.monthDay,
        ...at,
        start: s.months > 1 ? s.monthStart : undefined,
      };
    case 'hours':
      return { kind: 'every', minutes: s.minutes };
    case 'once':
      return { kind: 'once', date: s.date, ...at };
  }
}

/** Weekly: a day on or off, never leaving none on by tapping the last off. */
export function toggleDay(days: number[], day: number): number[] {
  if (!days.includes(day)) return [...days, day];
  return days.length > 1 ? days.filter((d) => d !== day) : days;
}

/**
 * Once: today, tomorrow and the five days after, as chips ("Today",
 * "Tomorrow", "Fri 7"), plus the edited check-in's own date when it's further out.
 * The Mac's days, in `timeZone`.
 */
export function onceDays(
  now = Date.now(),
  keep?: string,
  timeZone?: string
): { date: string; label: string }[] {
  const today = localDate(now, timeZone);
  const out = Array.from({ length: 7 }, (_, i) => {
    const date = nextDate(today, i);
    // Indexed, not destructured: under the app's Babel a destructure pulls in
    // a runtime helper this package (which has no dependencies) can't resolve.
    const ymd = date.split('-').map(Number);
    const day = ymd[2];
    const weekday = new Date(Date.UTC(ymd[0], ymd[1] - 1, day)).getUTCDay();
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : `${WEEK.find((w) => w.day === weekday)?.short} ${day}`;
    return { date, label };
  });
  if (keep && !out.some((o) => o.date === keep)) {
    const ymd = keep.split('-').map(Number);
    const d = new Date(ymd[0], ymd[1] - 1, ymd[2], 12);
    const month = d.toLocaleString(undefined, { month: 'short' });
    out.push({ date: keep, label: `${month} ${ymd[2]}` });
  }
  return out;
}
