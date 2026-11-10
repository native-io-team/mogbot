/**
 * One account signed in twice, and this Mac's own sign-in becoming another
 * account: the words for both, on the desk and the phone. Pure.
 *
 * - **The same account twice** (`UsageAccountLine.sameAs`, from the engines'
 *   own records) adds no extra room. Said plainly on the duplicate, with the
 *   one fix: sign it in with a different account, or remove it.
 * - **Adding an account** opens the engine's sign-in in the browser, which
 *   signs in as whoever is already logged in there. Said before it opens,
 *   and checked as soon as it returns.
 * - **This Mac's sign-in changed** (`UsageInventory.signInChanges`): the
 *   account it used to be isn't connected any more. Only what the Mac
 *   recorded: a name when one was recorded, the weekly reset it reported,
 *   and, when nothing named it, that the reset moved.
 */

import type { AgentEngine, SignInChange } from './model';
import { ACCOUNT_ENGINE_LABEL } from './accountSwitcher';

/** The account's kind, as people call it: "a Claude account", "a ChatGPT account". */
export const ACCOUNT_KIND: Record<AgentEngine, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  opencode: 'OpenCode',
};

/** Where the browser is signed in. */
const SITE: Record<AgentEngine, string> = {
  claude: 'claude.ai',
  codex: 'chatgpt.com',
  opencode: 'opencode.ai',
};

export const SIGN_IN_DIFFERENT = 'Sign in with a different account';
export const REMOVE_ACCOUNT = 'Remove';
export const ADD_IT = 'Add it';
export const NOT_NOW = 'Not now';
export const TRY_AGAIN_DIFFERENT = 'Try again with a different account';

/** On the duplicate itself: "Same Claude account as Work — adds no extra room". */
export function sameAccountLine(engine: AgentEngine, other: string): string {
  return `Same ${ACCOUNT_KIND[engine]} account as ${other} — adds no extra room`;
}

/** Under the meter, naming both: "Personal is the same Claude account as Work — adds no extra room". */
export function sameAccountNote(engine: AgentEngine, name: string, other: string): string {
  return `${name} is the same ${ACCOUNT_KIND[engine]} account as ${other} — adds no extra room`;
}

/**
 * Their weekly meters moved together with the same reset while only one ran
 * turns (`UsageAccountLine.maybeSameAs`): asked, never counted. Totals and
 * failover still treat them as two until the engine's own records say so.
 */
export function maybeSameAccountNote(engine: AgentEngine, name: string, other: string): string {
  return `${name} and ${other} may be the same ${ACCOUNT_KIND[engine]} account: their weekly limits have moved together and refill at the same moment. If they are, sign one in with a different account.`;
}

/** Before the sign-in opens the browser. */
export function browserWarning(engine: AgentEngine): string {
  return `Your browser will sign in as whoever is logged into ${SITE[engine]} — sign out there first, or use a private window or another browser profile, to add a different account.`;
}

/** The how, step by step, under the warning. */
export function browserSteps(engine: AgentEngine): string[] {
  return [
    `Open ${SITE[engine]} in the browser and check whose account it shows.`,
    'If it’s an account already in your list, sign out there, or use a private window or the browser profile where you’re signed in as the other account.',
    engine === 'claude'
      ? 'Then press Continue: the sign-in page opens, and the code it shows goes in the box that follows.'
      : 'Then press Continue: the sign-in page opens, and this finishes on its own.',
  ];
}

/** Right after a sign-in that turned out to be an account already here. */
export function addedSameAccount(engine: AgentEngine, other: string): string {
  return `That’s the same ${ACCOUNT_KIND[engine]} account as ${other}, so it adds no extra room. Sign out of ${SITE[engine]} in your browser, or use a private window, then try again.`;
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** A weekly reset as the schedule it is on: "Mondays 4 PM", "Saturdays 10:30 AM". */
export function weeklySchedule(at: number): string {
  return `${WEEKDAY.format(at)}s ${TIME.format(at).replace(':00', '')}`;
}

/** The notice, from what was recorded. `macName` names this Mac's sign-in when no email or organization was. */
export function signInChangedText(change: SignInChange, macName: string): string {
  const engine = ACCOUNT_ENGINE_LABEL[change.engine];
  const kind = ACCOUNT_KIND[change.engine];
  const now = change.nowEmail ?? change.nowOrgName ?? macName;
  const before = change.beforeEmail ?? change.beforeOrgName;
  const was = change.beforeWeeklyReset ? weeklySchedule(change.beforeWeeklyReset) : null;
  if (change.byReset && was) {
    const is = change.nowWeeklyReset
      ? `, whose week refills ${weeklySchedule(change.nowWeeklyReset)}`
      : '';
    return `This Mac’s ${engine} is now signed in as ${now}${is}. It used to refill ${was}, so that was another ${kind} account, and it isn’t connected anymore — add it to keep stacking.`;
  }
  const about = [before, was ? `refills ${was}` : null].filter(Boolean).join(', ');
  return `This Mac’s ${engine} is now signed in as ${now}. Your previous account${about ? ` (${about})` : ''} isn’t connected anymore — add it to keep stacking.`;
}
