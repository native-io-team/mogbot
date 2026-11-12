/**
 * A failed turn, and a note's one fix, in the words the desk and the phone
 * both say (docs/design/failure-states.md). The sentence in the chat is
 * the Mac's (`agents/failure.rs`); this is everything said *about* it: the
 * row's line and pill, and the one button that fixes it. Kept once so the
 * two never drift. Pure; no rendering.
 */

import type { Failure } from './model';
import { resetPhrase } from './quota';
import { yourComputer, type ComputerKind } from './computer';

export type FailureKind = Failure['kind'];

/** The first clause of an agent's preview: "Couldn't start Claude Code". */
export function failureClause(preview: string | null | undefined): string {
  return (preview ?? '').split(/(?<=[.!?:])\s/)[0].replace(/[.:]$/, '');
}

/** A pill's kind: never the accent, always a status role. */
export type FailureTone = 'out' | 'failed';

/**
 * A failed turn as a pill and the words after it: the state in the pill
 * ("Didn't finish", "Out of usage"), the reason as plain text. `engine`:
 * what the agent runs on ("Codex"), so a Codex agent is never said to be
 * signed out of Claude Code.
 */
export function failurePill(
  failure: Failure,
  preview: string | null | undefined,
  engine: string,
  now = Date.now()
): { tone: FailureTone; label: string; rest: string } {
  switch (failure.kind) {
    case 'usage_limit':
      return {
        tone: 'out',
        label: 'Out of usage',
        rest: failure.resetsAt ? `until ${resetPhrase(failure.resetsAt, now)}` : '',
      };
    case 'signed_out':
      return { tone: 'failed', label: 'Signed out', rest: engine };
    case 'interrupted':
      return { tone: 'failed', label: 'Interrupted', rest: 'Continue to pick it up' };
    case 'engine_missing':
      return { tone: 'failed', label: 'Not installed', rest: engine };
    default:
      return { tone: 'failed', label: 'Didn’t finish', rest: failureClause(preview) };
  }
}

/**
 * The same in one line, for a row with no room for a pill: "Out of usage
 * until 3:00 PM", "Codex is signed out", "Couldn't reach Anthropic · didn't
 * finish" (the reason first: it's what matters, and it's what fits).
 */
export function failureLine(
  failure: Failure,
  preview: string | null | undefined,
  engine: string,
  now = Date.now()
): string {
  switch (failure.kind) {
    case 'usage_limit':
      return failure.resetsAt
        ? `Out of usage until ${resetPhrase(failure.resetsAt, now)}`
        : 'Out of usage';
    case 'signed_out':
      return `${engine} is signed out`;
    case 'interrupted':
      return 'Interrupted · Continue to pick it up';
    case 'engine_missing':
      return `${engine} isn’t installed`;
    default: {
      const clause = failureClause(preview);
      return clause ? `${clause} · didn’t finish` : 'Didn’t finish';
    }
  }
}

/** What a failure's one button does. */
export type FailureFix = 'retry' | 'continue' | 'sign-in' | 'install';

/**
 * The one fix a failed turn offers, by kind: sign in, install, carry on
 * (never the request again, which could do the work twice), or retry. A
 * usage limit retries too, at its reset (the line offers the time).
 */
export function failureFix(kind: FailureKind | undefined): FailureFix {
  switch (kind) {
    case 'signed_out':
      return 'sign-in';
    case 'engine_missing':
      return 'install';
    case 'interrupted':
      return 'continue';
    default:
      return 'retry';
  }
}

/** What Continue sends: carry on in the same conversation. */
export const CONTINUE_TEXT = 'Continue';

/** The button's words for a fix. `engine`: "Claude Code". */
export function failureFixLabel(fix: FailureFix, engine: string): string {
  switch (fix) {
    case 'sign-in':
      return `Sign in to ${engine}`;
    case 'install':
      return `Install ${engine}`;
    case 'continue':
      return CONTINUE_TEXT;
    case 'retry':
      return 'Retry';
  }
}

/**
 * What the phone says under a failure whose fix is only at the Mac (it
 * can't install or sign an engine in from here). `null` where the phone
 * has the button itself.
 */
export function failureFixAtMac(
  fix: FailureFix,
  engine: string,
  computer?: ComputerKind | null
): string | null {
  switch (fix) {
    case 'sign-in':
      return `Sign in to ${engine} on ${yourComputer(computer)}, then send it again.`;
    case 'install':
      return `Install ${engine} on ${yourComputer(computer)}, then send it again.`;
    default:
      return null;
  }
}

// --- A note's one fix (`store::NoteFix`) -----------------------------------

/**
 * `user_chrome`: set up Your Chrome; `user_chrome_check`: it's on but not
 * connected, so the button says to check it (the note says opening Chrome
 * reconnects it); `disk`: Settings → Agents → Disk space.
 */
export type NoteFix = 'user_chrome' | 'user_chrome_check' | 'disk';

/** The button's words for a note's fix. */
export function noteFixLabel(fix: NoteFix): string {
  switch (fix) {
    case 'user_chrome':
      return 'Set up Your Chrome';
    case 'user_chrome_check':
      return 'Check Your Chrome';
    case 'disk':
      return 'Free up space';
  }
}
