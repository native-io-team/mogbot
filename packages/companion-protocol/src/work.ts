/**
 * Words for the live step, shared by the desk and the phone so they never
 * disagree: its timer ("5:32"), the quiet hint a known slow tool gets after
 * a minute, when "Stop this step" is offered, the gentle "No progress for
 * 5 min", the on-demand "Last activity 4s ago · busy", and what a
 * finished step adds after its label ("6m 12s · 42 passed, 3 failed").
 *
 * Only what the Mac reported (`agents::work`): a part with nothing behind
 * it is left out, never guessed.
 */

import type { AgentStatus, LiveCall, TurnWork, WorkSlow, WorkStep } from './model';

/** A known slow tool's hint shows after this long. */
export const SLOW_HINT_AFTER_MS = 60_000;
/** "Stop this step" is offered after this long. */
export const STOP_STEP_AFTER_MS = 10 * 60_000;
/** A finished step shows how long it took only when it took this long. */
export const SHOW_DURATION_FROM_MS = 10_000;

/** The live timer: "0:07", "5:32", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** How long a finished step took: "42s", "6m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** A list row's elapsed time: "12s", "5m", "1h 5m". Coarse, so it doesn't tick every second. */
export function formatRowElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const SLOW_HINT: Record<WorkSlow, string> = {
  tests: 'Test runs usually take a few minutes',
  build: 'Builds usually take a few minutes',
  install: 'Installs usually take a minute or two',
  deploy: 'Deploys usually take a few minutes',
  other: 'This usually takes a few minutes',
};

/** After a minute on a known slow tool: a quiet "This usually takes a few minutes". */
export function slowHint(call: LiveCall | undefined, now: number): string | null {
  if (!call?.slow || now - call.startedAt < SLOW_HINT_AFTER_MS) return null;
  return SLOW_HINT[call.slow] ?? SLOW_HINT.other;
}

/** "Stop this step" after ten minutes, when the Mac can find its process. */
export function offersStopStep(call: LiveCall | undefined, now: number): boolean {
  return Boolean(call?.canStop) && now - (call?.startedAt ?? now) >= STOP_STEP_AFTER_MS;
}

/** Where "Show output" has nothing yet, why. */
export function outputNote(call: LiveCall): string | null {
  if (!call.streams) return 'Output appears when it finishes';
  if (!call.output?.length) return 'Nothing printed yet';
  return null;
}

/** The working line once there's been no progress for too long: "No progress for 5 min". */
export function quietLine(work: TurnWork | undefined, now: number): string | null {
  if (work?.quietSince == null) return null;
  const min = Math.max(1, Math.floor((now - work.quietSince) / 60_000));
  return `No progress for ${min} min`;
}

/** On demand: "Last activity 4s ago · busy". */
export function lifeLine(work: TurnWork | undefined, now: number): string | null {
  if (work?.lastSignAt == null) return null;
  const ago = Math.max(0, now - work.lastSignAt);
  const when = ago < 2_000 ? 'just now' : `${formatRowElapsed(ago)} ago`;
  const parts = [`Last activity ${when}`];
  const busy = work.current?.busy;
  if (busy === true) parts.push('busy');
  if (busy === false) parts.push('idle');
  return parts.join(' · ');
}

/** What a finished step adds after its label: how long it took, and what a test run came to. */
export function stepDetails(step: WorkStep): string[] {
  const parts: string[] = [];
  if (step.endedAt != null && step.endedAt - step.at >= SHOW_DURATION_FROM_MS) {
    parts.push(formatDuration(step.endedAt - step.at));
  }
  if (step.summary) parts.push(step.summary);
  return parts;
}

/** A finished step's whole line: "Ran the Cypress tests · 6m 12s · 42 passed, 3 failed". */
export function stepLine(step: WorkStep): string {
  return [step.label, ...stepDetails(step)].join(' · ');
}

/**
 * A working row in a list: the live step in plain words and how long it has
 * been at it ("Running the Cypress tests · 5m"), or the turn's time when no
 * call is running. `activity` is the status's words.
 */
export function workingRowLine(
  activity: string | null | undefined,
  work: TurnWork | undefined,
  since: number | null | undefined,
  now: number
): { text: string; elapsed: string | null } {
  const quiet = quietLine(work, now);
  if (quiet) return { text: quiet, elapsed: null };
  const call = work?.current;
  const text = call?.label ?? activity?.trim() ?? '';
  const from = call?.startedAt ?? since ?? null;
  return {
    text: text || 'Thinking',
    elapsed: from != null && now - from >= 1_000 ? formatRowElapsed(now - from) : null,
  };
}

/** The same folder, trailing slashes aside. Never a guess beyond that. */
export function sameFolder(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** What `agentsAtWork` needs of an agent, on the desk or the phone. */
export interface AtWorkAgent {
  id: string;
  hidden?: boolean;
  pendingApprovals?: number;
  status: AgentStatus;
}

/** Waiting on the user: an approval card, or a turn stopped on one. */
function asking(agent: AtWorkAgent): boolean {
  return agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;
}

/**
 * The agents at work in a project right now: a turn in progress whose
 * project (as the Mac reported it, `TurnWork.project`) is that folder. Those
 * waiting on the user first, then by when they started. Idle agents, even
 * bound ones, aren't "at work": nothing is inferred from a binding alone.
 */
export function agentsAtWork<A extends AtWorkAgent>(
  agents: readonly A[],
  projectPath: string
): A[] {
  return agents
    .filter((a) => {
      const project = a.status.work?.project;
      return (
        !a.hidden && a.status.state !== 'idle' && !!project && sameFolder(project, projectPath)
      );
    })
    .sort(
      (a, b) =>
        Number(asking(b)) - Number(asking(a)) || (a.status.since ?? 0) - (b.status.since ?? 0)
    );
}

/**
 * What an agent at work in a project is doing, as the project's row says it:
 * "needs you", or the step it's on ("Running the build").
 */
export function atWorkText(
  agent: AtWorkAgent,
  activity: string | null | undefined,
  now: number
): string {
  if (asking(agent)) return 'needs you';
  return workingRowLine(activity, agent.status.work, agent.status.since, now).text;
}
