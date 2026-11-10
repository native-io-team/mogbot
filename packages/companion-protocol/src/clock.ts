/**
 * Times of day as the user reads them: "9:00 AM" or "09:00".
 *
 * The Mac says which (`AgentsOverview.hour24`, from macOS's own 24-hour
 * setting), and the Mac writes routine times into sentences itself
 * (`schedule::describe`, the brief), so the desk and the phone follow it
 * rather than their own locale: a routine reads the same in the list, the
 * editor, a recipe and the Chief's reply. Until the Mac has said, or on an
 * older Mac that doesn't, the locale decides.
 *
 * Formatters are built once per shape: `toLocaleTimeString` with options
 * builds a new one per call, which over a few hundred rows was the costliest
 * part of a chat render.
 */

let hour24: boolean | null = null;
const formats = new Map<string, Intl.DateTimeFormat>();

/** What the Mac said (`null`: not said, the locale decides). */
export function setClockHour24(value: boolean | null | undefined): void {
  const next = typeof value === 'boolean' ? value : null;
  if (next === hour24) return;
  hour24 = next;
  formats.clear();
}

export function clockHour24(): boolean | null {
  return hour24;
}

/** An `Intl.DateTimeFormat` that shows hours the user's way. */
export function clockFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = formats.get(key);
  if (!f) {
    const withCycle: Intl.DateTimeFormatOptions =
      hour24 === null || !options.hour
        ? options
        : { ...options, hourCycle: hour24 ? 'h23' : 'h12' };
    f = new Intl.DateTimeFormat(undefined, withCycle);
    formats.set(key, f);
  }
  return f;
}

const HM: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** "9:00 AM" / "09:00" for an instant. */
export function formatClock(at: number | Date): string {
  return clockFormat(HM).format(at);
}

/** "9:00 AM" / "09:00" for a wall-clock hour and minute. */
export function clockAt(hour: number, minute: number): string {
  return formatClock(new Date(2000, 0, 1, hour, minute));
}
