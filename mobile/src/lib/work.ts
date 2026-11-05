/**
 * Words for what a turn did (the Mac's `agents::work`), as the desktop says
 * them (`src/lib/agentWork.ts`): "Worked 6 min · 23 steps · edited 2 files"
 * and each step's time into the turn. Only what the Mac observed: a part
 * with nothing behind it is left out, never shown as zero. Pure, so tested.
 */

import type { LiveCall, TurnWork, WorkStep } from '@shipstudio/companion-protocol';

/** "40s", "6 min", "1 h 20 min". */
export function formatWorked(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The folded line. A turn whose end wasn't recorded doesn't claim a length. */
export function workSummary(work: TurnWork): string {
  const parts = [plural(work.stepCount, 'step')];
  if (work.fileCount > 0) parts.push(`edited ${plural(work.fileCount, 'file')}`);
  if (work.endedAt != null && work.endedAt >= work.startedAt) {
    parts.unshift(`Worked ${formatWorked(work.endedAt - work.startedAt)}`);
  } else {
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return parts.join(' · ');
}

/** "0:12", "14:05", "1:02:03" into the turn. */
export function stepOffset(step: WorkStep, startedAt: number): string {
  const total = Math.max(0, Math.floor((step.at - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The same time for VoiceOver, in words: "12 seconds in", "14 minutes 5
 * seconds in". "0:12" is otherwise read out digit by digit.
 */
export function stepOffsetSpoken(step: WorkStep, startedAt: number): string {
  const total = Math.max(0, Math.floor((step.at - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [
    h ? plural(h, 'hour') : '',
    m ? plural(m, 'minute') : '',
    // Seconds stop mattering once it's hours in.
    s && !h ? plural(s, 'second') : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(' ')} in` : 'at the start';
}

/**
 * Under the working row: "8 steps so far · edited 1 file". The row above
 * already says it's working, so this doesn't say it again.
 */
export function liveSummary(work: TurnWork): string {
  const parts = [`${plural(work.stepCount, 'step')} so far`];
  if (work.fileCount > 0) parts.push(`edited ${plural(work.fileCount, 'file')}`);
  return parts.join(' · ');
}

/**
 * The steps to list under the working row. The newest is left out only
 * while the row is saying it (its call is still running and the row shows
 * that call's words), so it's never shown twice and never hidden when the
 * row says something else ("Waiting for your OK", or nothing).
 */
export function liveSteps(work: TurnWork, activity: string | null | undefined): WorkStep[] {
  const shownByRow = work.doing != null && activity != null && activity === work.doing;
  return shownByRow ? work.steps.slice(0, -1) : work.steps;
}

/** Steps the Mac saw but no longer keeps (it keeps the newest). */
export function earlierSteps(work: TurnWork): number {
  return Math.max(0, work.stepCount - work.steps.length);
}

/** The SF Symbol for a step. A kind a newer Mac sends reads as a tool. */
export const STEP_SYMBOL = {
  read: 'doc.text',
  edit: 'pencil',
  search: 'magnifyingglass',
  web: 'globe',
  command: 'terminal',
  message: 'bubble.left',
  approval: 'checkmark.shield',
  screenshot: 'camera',
  plan: 'list.bullet',
  delegate: 'person.2',
  project: 'folder.fill',
  tool: 'puzzlepiece',
} as const;

export function stepSymbol(kind: string): (typeof STEP_SYMBOL)[keyof typeof STEP_SYMBOL] {
  return STEP_SYMBOL[kind as keyof typeof STEP_SYMBOL] ?? STEP_SYMBOL.tool;
}

/**
 * The call the working row is saying, when it is saying one: the Mac's line
 * is that call's words (`doing`), or says nothing else. Another line
 * ("Reconnecting to Codex", "Waiting for your OK") is shown as it is, with
 * no timer: it isn't the call.
 */
export function liveCallShown(
  work: TurnWork | undefined,
  activity: string | null | undefined
): LiveCall | undefined {
  const call = work?.current;
  if (!call) return undefined;
  if (activity == null || activity === work?.doing || activity === call.label) return call;
  return undefined;
}
