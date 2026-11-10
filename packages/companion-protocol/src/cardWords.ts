/**
 * Words the desk and the phone both say about a card or a line, kept once
 * so the two never drift (docs/agents.md, "Lines, cards and bars": one word
 * per idea). Pure; no rendering.
 */

import type { Approval, CheckInMark, StepInCard, UsageAccount } from './model';
import { formatWhenInline } from './schedule';

// --- Step in (`agents/step_in.rs`) ---------------------------------------

/** The card's two answers at the Mac, and the bar's. */
export const STEP_IN = 'Step in';
export const STEP_IN_NOT_NOW = 'Not now';
export const STEP_IN_HAND_BACK = 'Hand back';

/** The phone's note on a step-in card: Step in happens at the Mac. */
export const STEP_IN_ON_YOUR_MAC = 'Step in on your Mac: its tab opens there.';

/** The phone's note while the user is in the agent's tab at the Mac. */
export const STEP_IN_AT_MAC = 'You’re in its browser on your Mac. Hand back there.';

/** Under the title, muted: "login.microsoftonline.com · Verify your identity". */
export function stepInSource(card: Pick<StepInCard, 'site' | 'pageTitle'>): string {
  return card.pageTitle ? `${card.site} · ${card.pageTitle}` : card.site;
}

/** A step-in card once it's closed, in one line. */
export function stepInOutcome(approval: Pick<Approval, 'status' | 'setAside'>): string {
  if (approval.status === 'allowed') return 'Handed back';
  if (approval.status === 'denied') return STEP_IN_NOT_NOW;
  return approval.setAside ?? 'Expired';
}

// --- Accounts: "Use this one now" and "Runs on" ---------------------------

// --- First run: bringing agents from another assistant --------------------

/**
 * The one-time card under the Chief's greeting (`ImportChoiceCard`, desk and
 * phone). Asked as "already have…?" because a first-timer read "Bring your
 * agents…?" with the bright button as the step they were meant to take, and
 * they have no agents anywhere (docs/internal/persona-beginners-2026-11-09.md).
 */
export const IMPORT_CHOICE_TITLE = 'Already have agents in another assistant?';
export const IMPORT_CHOICE_NOTE =
  'Bring them from Grok, ChatGPT, Claude or anything else. Nothing is created until you say so. New to agents? Start fresh.';
export const IMPORT_CHOICE_DECLINE = 'No thanks, start fresh';
export const IMPORT_CHOICE_BRING = 'Bring my agents';

/** Puts an account first in its engine's order (desk popover, Settings, phone). */
export const USE_THIS_ONE_NOW = 'Use this one now';

/** "Runs on": the default, the team's order. */
export const RUNS_ON_ANY = 'Any account';
export const RUNS_ON_ANY_DETAIL = 'In order, carrying on with the next when one runs out';

/** Under an account in "Runs on": what pinning to it means, and why it can't run now. */
export function runsOnDetail(a: Pick<UsageAccount, 'signedIn' | 'out'>): string {
  if (!a.signedIn) return 'Not signed in';
  return a.out ? 'Only this one, never another · out of usage now' : 'Only this one, never another';
}

// --- Routine lines ----------------------------------------------------------

/**
 * The head of a routine's line in the chat: "Routine" (repeating) or
 * "Scheduled" (one time), then what fired it, "run now", or that it was
 * late ("late, was due today at 9:00 AM": the app was closed, or it waited
 * for quiet hours).
 */
export function checkInHead(mark: CheckInMark | undefined | null, now = Date.now()): string {
  const parts = [mark?.repeats ? 'Routine' : 'Scheduled'];
  if (mark?.found) parts.push(mark.found);
  if (mark?.manual) parts.push('run now');
  if (mark?.late) parts.push(`late, was due ${formatWhenInline(mark.dueAt, now)}`);
  return parts.join(' · ');
}
