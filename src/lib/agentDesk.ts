/**
 * Desk-only views for people who want to see under the hood
 * (`commands/agents_desk.rs`): which account and model ran a turn, a step's
 * exact command, what a turn was told, every routine at once, and the logs.
 * The phone has none of these: what they return is kept on this Mac only.
 *
 * @module lib/agentDesk
 */

import { invoke } from '@tauri-apps/api/core';
import {
  describeRepeat,
  describeRun,
  describeWatchTitle,
  formatWhen,
  type Agent,
  type CheckIn,
  type CheckInRun,
  type TurnWork,
} from './agents';

/** "Claude Code · work@acme.com · claude-opus-4-6": only the parts the Mac recorded. */
export function ranOnLine(work: Pick<TurnWork, 'engine' | 'account' | 'model'>): string | null {
  const parts = [work.engine, work.account, work.model].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A step's index among all the turn's steps, from its place in the kept ones. */
export function stepIndex(work: Pick<TurnWork, 'stepCount' | 'steps'>, kept: number): number {
  return Math.max(0, work.stepCount - work.steps.length) + kept;
}

/** The exact command behind one step, redacted on the Mac; null when not kept. */
export const getStepExact = (agentId: string, messageId: string, step: number) =>
  invoke<string | null>('agents_step_exact', { agentId, messageId, step });

/** One `## ` section of a briefing (`agents::briefing::Section`). */
export interface BriefingSection {
  title: string;
  body: string;
}

/** What a turn was told (`agents::briefing::Briefing`). */
export interface Briefing {
  at: number;
  sections: BriefingSection[];
  /** Its own instructions and memory, when they aren't a section already. */
  instructions?: string;
}

/** What the turn that ended on `messageId` was told; without one, the newest. */
export const getTurnBriefing = (agentId: string, messageId?: string | null) =>
  invoke<Briefing | null>('agents_turn_briefing', { agentId, messageId: messageId ?? null });

/** Pause every running routine on every agent; how many it paused. */
export const pauseAllRoutines = () => invoke<number>('agents_routines_pause_all');

/** Resume only what "Pause all routines" paused; how many it resumed. */
export const resumeAllRoutines = () => invoke<number>('agents_routines_resume_all');

/** Open the app's log folder; returns its path. */
export const openLogs = () => invoke<string>('agents_open_logs');

/** The Routines overview's place in Agents, as What's in flight has `TEAM_ID`. */
export const ROUTINES_ID = '__routines';

/** "Paused 4 routines" / "Nothing was running". */
export function pausedLine(n: number): string {
  if (n === 0) return 'No routine was running';
  return `Paused ${n === 1 ? '1 routine' : `${n} routines`}`;
}

export function resumedLine(n: number): string {
  if (n === 0) return 'Nothing that “Pause all” paused is left to resume';
  return `Resumed ${n === 1 ? '1 routine' : `${n} routines`}`;
}

/** One row of the Routines overview. */
export interface RoutineRow {
  agent: Agent;
  routine: CheckIn;
}

/** Every routine on every agent: the ones that run first, soonest first. Pure. */
export function routineRows(agents: Agent[]): RoutineRow[] {
  const rows = agents.flatMap((agent) =>
    (agent.checkIns ?? []).map((routine) => ({ agent, routine }))
  );
  return rows.sort(
    (a, b) =>
      Number(a.routine.paused) - Number(b.routine.paused) ||
      a.routine.nextAt - b.routine.nextAt ||
      a.agent.name.localeCompare(b.agent.name)
  );
}

/** Its last run, as recorded; null before the first. */
export function lastRun(routine: CheckIn): CheckInRun | null {
  const runs = routine.runs ?? [];
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/** Its last run in words ("Ran", "Didn’t run"); null before the first. */
export function lastResultWords(routine: CheckIn, now = Date.now()): string | null {
  const run = lastRun(routine);
  return run ? describeRun(run, now) : null;
}

/** How it runs, in words: "Every weekday at 9:00 AM", a "When…" routine's trigger, "Once". */
export function routineWhenWords(routine: CheckIn): string {
  if (routine.watch) return describeWatchTitle(routine.watch.source);
  if (routine.repeat) return describeRepeat(routine.repeat);
  return 'Once';
}

/** When it next runs: null while paused (it runs at no time). */
export function nextRunWords(routine: CheckIn, now = Date.now()): string | null {
  if (routine.paused) return null;
  return formatWhen(routine.nextAt, now);
}

/** How many routines run, and how many a bulk resume would wake. */
export function routineCounts(agents: Agent[]): { on: number; paused: number } {
  const all = agents.flatMap((a) => a.checkIns ?? []);
  return { on: all.filter((c) => !c.paused).length, paused: all.filter((c) => c.paused).length };
}
