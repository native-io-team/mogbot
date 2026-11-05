/**
 * How a usage account's state is said, once, for the desk's Settings and
 * the phone's (`agents.accounts`, `agents::wallet`). Only what is known: a
 * limit and its reset are said only when a turn hit one and the engine
 * reported when it resets.
 */

import type { UsageAccount } from './model';
import { readDay, resetPhrase } from './quota';

/**
 * - out now: "Out of usage until Sat 2:00 PM", or with no reported reset
 *   "Out of usage · reset time not reported";
 * - signed out: "Not signed in";
 * - otherwise "Signed in" (as its email when there is one), plus
 *   "· last limit Tue" when it hit one before.
 */
export function accountState(a: UsageAccount, now = Date.now()): string {
  if (!a.signedIn) return 'Not signed in';
  if (a.out) {
    return a.limit?.resetsAt && a.limit.resetsAt > now
      ? `Out of usage until ${resetPhrase(a.limit.resetsAt, now)}`
      : 'Out of usage · reset time not reported';
  }
  const who = a.email ? `Signed in as ${a.email}` : 'Signed in';
  return a.limit ? `${who} · last limit ${readDay(a.limit.at, now)}` : who;
}

/** One account as the phone's Settings lists it. */
export interface AccountLine {
  key: string;
  label: string;
  detail: string;
  out: boolean;
}

const ENGINE_NAME: Record<UsageAccount['engine'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * One line per account, in order, for each engine that has more than one:
 * with a single account there is nothing to switch to, so nothing to say.
 */
export function accountLines(accounts: UsageAccount[], now = Date.now()): AccountLine[] {
  const engines = [...new Set(accounts.map((a) => a.engine))];
  return engines.flatMap((engine) => {
    const mine = accounts.filter((a) => a.engine === engine);
    if (mine.length < 2) return [];
    return mine.map((a, i) => ({
      key: `${engine}:${a.id}`,
      label: `${ENGINE_NAME[engine]} ${i + 1}. ${a.name}`,
      detail: accountState(a, now),
      out: a.out,
    }));
  });
}
