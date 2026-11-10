/**
 * How a usage account's state is said, once, for the desk's Settings and
 * the phone's (`agents.accounts`, `agents::wallet`). Only what is known: a
 * limit and its reset are said only when a turn hit one and the engine
 * reported when it refills.
 */

import type { UsageAccount } from './model';
import { readDay, resetPhrase } from './quota';

/**
 * - out now: "Out of usage until Sat 2:00 PM", or with no reported reset
 *   "Out of usage · refill time not reported";
 * - signed out: "Not signed in";
 * - otherwise "Signed in" (as its email when there is one), plus
 *   "· last limit Tue" when it hit one before.
 */
export function accountState(a: UsageAccount, now = Date.now()): string {
  if (!a.signedIn) return 'Not signed in';
  if (a.out) {
    return a.limit?.resetsAt && a.limit.resetsAt > now
      ? `Out of usage until ${resetPhrase(a.limit.resetsAt, now)}`
      : 'Out of usage · refill time not reported';
  }
  const who = a.email ? `Signed in as ${a.email}` : 'Signed in';
  return a.limit ? `${who} · last limit ${readDay(a.limit.at, now)}` : who;
}
