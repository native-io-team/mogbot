/**
 * Quiet hours (`agents::quiet` on the Mac): one window a day for the whole
 * team, in local minutes after midnight. Inside it nothing scheduled runs
 * (except a routine the user timed inside it) and only approvals notify.
 * Read with `agents.quietHours`, set with `agents.setQuietHours`, and from
 * chat with the Chief's `set_quiet_hours`. Desk and phone word it the same.
 */

/** `start > end` wraps past midnight (22:00–07:00). */
export interface QuietWindow {
  start: number;
  end: number;
}

export interface QuietHours {
  window: QuietWindow | null;
}

export const QUIET_TITLE = 'Quiet hours';

/** The row's one line, on or off. */
export const QUIET_DETAIL = 'Nothing scheduled runs; only requests for your OK notify.';

const pad = (n: number) => String(n).padStart(2, '0');

/** 1320 → "22:00". */
export function clockLabel(minute: number): string {
  return `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
}

/** "22:00–07:00", or "Off". */
export function quietLabel(window: QuietWindow | null | undefined): string {
  return window ? `${clockLabel(window.start)}–${clockLabel(window.end)}` : 'Off';
}

/** "22:00" → 1320; null when it isn't a time. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The phone's picks: the common nights, then off. */
export const QUIET_PRESETS: QuietWindow[] = [
  { start: 21 * 60, end: 7 * 60 },
  { start: 22 * 60, end: 7 * 60 },
  { start: 23 * 60, end: 7 * 60 },
  { start: 22 * 60, end: 8 * 60 },
];

/** A window as the Mac takes it: whole minutes in a day, start ≠ end. */
export function validQuietWindow(w: QuietWindow): boolean {
  const inDay = (n: number) => Number.isInteger(n) && n >= 0 && n < 24 * 60;
  return inDay(w.start) && inDay(w.end) && w.start !== w.end;
}
