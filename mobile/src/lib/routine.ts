/**
 * The routine picker's state, and the schedule it means. Pure, so the picker
 * is tested without a screen: the chips choose a cadence, the time picker a
 * time, and `whenOf` turns them into the `RoutineWhen` the Mac is sent (as
 * the grammar's own words, `routineWhenPhrase`).
 *
 * Dates and days are the Mac's (`timeZone`, from `welcome.timeZone`): it
 * reads the picker's words on its own clock, so "Today" is its today.
 */

import { localDate, nextDate, wallClock, type RoutineWhen } from '@shipstudio/companion-protocol';

export type Cadence = 'daily' | 'weekdays' | 'weekly' | 'hours' | 'once';

export interface PickerState {
  cadence: Cadence;
  /** Weekly: the days it runs on, 0 = Sunday. */
  days: number[];
  /** Every few hours: how often, in minutes. */
  minutes: number;
  /** Once: the local date, `YYYY-MM-DD`. */
  date: string;
  hour: number;
  minute: number;
}

export const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
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
    const [y, m, day] = date.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    const label =
      i === 0
        ? 'Today'
        : i === 1
          ? 'Tomorrow'
          : `${WEEK.find((w) => w.day === weekday)?.short} ${day}`;
    return { date, label };
  });
  if (keep && !out.some((o) => o.date === keep)) {
    const [y, m, day] = keep.split('-').map(Number);
    const d = new Date(y, m - 1, day, 12);
    const month = d.toLocaleString(undefined, { month: 'short' });
    out.push({ date: keep, label: `${month} ${day}` });
  }
  return out;
}
