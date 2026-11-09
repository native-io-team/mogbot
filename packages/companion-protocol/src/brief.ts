/**
 * The morning brief (`agents::brief` on the Mac): once a day at the user's
 * time the Chief posts one short message, composed from the app's own
 * records without a model turn: what waits on the user, what didn't work,
 * what runs today, what the team did, and the accounts' room. Read with
 * `agents.morningBrief`, set with `agents.setMorningBrief`, and from chat
 * with the Chief's `set_morning_brief`. Desk and phone word it the same.
 */

/** A read-only question asked through one connector before the brief. */
export interface BriefCheck {
  what: string;
  app: string;
}

export interface MorningBrief {
  on: boolean;
  /** Minutes after local midnight. */
  at: number;
  /** Posted even on days with nothing to say. */
  always: boolean;
  checks?: BriefCheck[];
  /** When one was last posted, epoch ms. */
  lastPostedAt?: number;
}

export const BRIEF_TITLE = 'Morning brief';

/** The row's one line. */
export const BRIEF_DETAIL =
  'Your Chief of Staff posts what needs you, what runs today and what didn’t work. Nothing on a quiet day.';

/** The setting for posting even on a quiet day. */
export const BRIEF_ALWAYS = 'Post on quiet days too';

/** Every brief's first words: how a chat knows one (`agents::brief::HEAD`). */
export const BRIEF_HEAD = 'Morning brief, ';

/** The phone's picks. */
export const BRIEF_TIMES: number[] = [6 * 60 + 30, 7 * 60, 7 * 60 + 30, 8 * 60, 8 * 60 + 30, 9 * 60];

const pad = (n: number) => String(n).padStart(2, '0');

/** "08:00", or "Off". */
export function briefLabel(brief: Pick<MorningBrief, 'on' | 'at'> | null | undefined): string {
  if (!brief || !brief.on) return 'Off';
  return `${pad(Math.floor(brief.at / 60) % 24)}:${pad(brief.at % 60)}`;
}

/** Whether a message is a morning brief: an agent line that starts as one does. */
export function isBriefText(text: string): boolean {
  return text.trimStart().startsWith(BRIEF_HEAD);
}
