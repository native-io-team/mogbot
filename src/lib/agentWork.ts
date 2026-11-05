/**
 * Words for a turn's timeline (`agents::work` in Rust): the folded line
 * under a reply ("Worked 6 min · 23 steps · edited 2 files") and the times
 * beside each step. Only what the backend observed: a part with nothing
 * behind it (no files edited, no steps) is left out, never shown as zero.
 *
 * @module lib/agentWork
 */

import type { TurnWork, WorkStep } from './agents';

/** "40s", "6 min", "1 h 20 min". Under a second rounds up: it did take time. */
export function formatWorked(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The parts of the folded line after the time, in order. */
function countParts(work: TurnWork): string[] {
  const parts = [plural(work.stepCount, 'step')];
  if (work.fileCount > 0) parts.push(`edited ${plural(work.fileCount, 'file')}`);
  return parts;
}

/**
 * The folded line under a finished turn's last message. A turn whose end
 * wasn't recorded says nothing about its length rather than guessing one.
 */
export function workSummary(work: TurnWork): string {
  const parts = countParts(work);
  if (work.endedAt != null && work.endedAt >= work.startedAt) {
    parts.unshift(`Worked ${formatWorked(work.endedAt - work.startedAt)}`);
  } else {
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return parts.join(' · ');
}

/** Beside the working line while it runs: "5 steps · edited 1 file". */
export function liveSummary(work: TurnWork): string {
  return countParts(work).join(' · ');
}

/** How far into the turn a step came: "0:12", "14:05", "1:02:03". */
export function stepOffset(step: WorkStep, startedAt: number): string {
  const total = Math.max(0, Math.floor((step.at - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The steps to list above the working line. The newest is left out only
 * when the working line is saying it — its call is still running and the
 * line shows that call's words — so it's never shown twice, and never
 * hidden when the line is blank or says something else (after an approval,
 * "Waiting for your OK", "Reconnecting").
 */
export function liveSteps(work: TurnWork, activity: string | null | undefined): WorkStep[] {
  const shownByLine = work.doing != null && activity != null && activity === work.doing;
  return shownByLine ? work.steps.slice(0, -1) : work.steps;
}

/** Steps seen but no longer kept (the backend keeps the newest). */
export function earlierSteps(work: TurnWork): number {
  return Math.max(0, work.stepCount - work.steps.length);
}

/**
 * Timelines the reader opened while the turn was live, by agent and the
 * turn's start: the finished one under the reply opens the same way.
 */
const openedLive = new Map<string, number>();

export function rememberLiveOpen(agentId: string, startedAt: number, open: boolean) {
  if (open) openedLive.set(agentId, startedAt);
  else if (openedLive.get(agentId) === startedAt) openedLive.delete(agentId);
}

export function wasOpenLive(agentId: string, startedAt: number): boolean {
  return openedLive.get(agentId) === startedAt;
}
