/**
 * Routines in steps and "Describe the agent you want", worded the same way
 * on the desk and the phone (`agents/routine_steps.rs`, `agents/draft.rs`).
 * Pure.
 */

import { clockAt } from './clock';
import type { AgentDraft, CheckIn, NewRoutine, RoutineStep } from './model';

/** The answers on an "OK to go on?" card. Neutral, never the accent. */
export const GATE_ALLOW = 'Go ahead';
export const GATE_DENY = 'Stop here';

/** Steps after the first a routine may have (`routine_steps::MAX_THEN`). */
export const MAX_THEN = 4;

/** One step of a routine, numbered from 1: the note is step 1. */
export interface NumberedStep {
  n: number;
  text: string;
  /** Waits for the user's OK before it runs. */
  askFirst: boolean;
}

/** Every step of a routine, the note first. One step for a plain routine. */
export function routineSteps(c: Pick<CheckIn, 'note' | 'then'>): NumberedStep[] {
  return [
    { n: 1, text: c.note, askFirst: false },
    ...(c.then ?? []).map((s, i) => ({ n: i + 2, text: s.text, askFirst: Boolean(s.askFirst) })),
  ];
}

/**
 * The compact line under a routine in steps: "3 steps · your OK before
 * step 3". `null` for a routine of one step.
 */
export function stepsLine(c: Pick<CheckIn, 'note' | 'then'>): string | null {
  const steps = routineSteps(c);
  if (steps.length < 2) return null;
  const asks = steps.filter((s) => s.askFirst).map((s) => s.n);
  const ok =
    asks.length === 0
      ? ''
      : asks.length === 1
        ? ` · your OK before step ${asks[0]}`
        : ` · your OK before steps ${asks.slice(0, -1).join(', ')} and ${asks[asks.length - 1]}`;
  return `${steps.length} steps${ok}`;
}

/** Steps as typed in an editor: trimmed, empty ones dropped. */
export function cleanSteps(steps: RoutineStep[]): RoutineStep[] {
  return steps
    .map((s) => ({ text: s.text.trim(), ...(s.askFirst ? { askFirst: true } : {}) }))
    .filter((s) => s.text.length > 0);
}

/** The routines of a draft the user kept ticked, as `agents.create` takes them. */
export function keptRoutines(draft: AgentDraft, kept: boolean[]): NewRoutine[] {
  return draft.routines
    .filter((r, i) => kept[i] !== false && !r.problem)
    .map((r) => ({
      when: r.when,
      note: r.note,
      ...(r.then && r.then.length ? { then: r.then } : {}),
    }));
}

/**
 * The line under a drafted agent's apps: what it will ask for, never a
 * claim that anything is connected. `null` with none.
 */
export function draftAppsLine(apps: string[]): string | null {
  if (apps.length === 0) return null;
  const names =
    apps.length === 1 ? apps[0] : `${apps.slice(0, -1).join(', ')} and ${apps[apps.length - 1]}`;
  return `Uses ${names}. It asks you to connect ${apps.length === 1 ? 'it' : 'them'} the first time it needs ${apps.length === 1 ? 'it' : 'them'}.`;
}

/**
 * Placeholder for the one prompt: short, and plainly an example. A full,
 * realistic brief at the size of real text made the empty box read as filled.
 */
export const DESCRIBE_PLACEHOLDER = 'For example: “Brief me on my inbox every weekday at 8.”';

const DAY_WORDS =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/g;

/**
 * A drafted routine's time as the Mac's grammar read it ("every friday at
 * 16:00"), as a label: "Every Friday at 4:00 PM" (in the Mac's 12- or
 * 24-hour clock, `clock.ts`). The case and the time's form change, and a
 * one-time run's UTC offset ("once, Thu 5 Nov 2026, 9:00 AM (UTC-05:00)",
 * exact for an agent) is dropped: it is the Mac's own zone, which every
 * other time on this screen is in too.
 */
export function whenLabel(readsAs: string): string {
  const plain = readsAs.replace(/\s*\(UTC[+-]\d{2}:\d{2}\)$/, '');
  const named = plain
    .replace(DAY_WORDS, (w) => w[0].toUpperCase() + w.slice(1))
    // The grammar's 24-hour "at 08:00", told as every other time is ("at 8:00 AM",
    // or "at 08:00" on a Mac set to 24-hour): the picker's own words for the same routine.
    .replace(/\bat (\d{1,2}):(\d{2})\b(?!\s*[AaPp]\.?[Mm])/g, (m, h: string, min: string) => {
      const hour = Number(h);
      const minute = Number(min);
      return hour < 24 && minute < 60 ? `at ${clockAt(hour, minute)}` : m;
    });
  return named.charAt(0).toUpperCase() + named.slice(1);
}
