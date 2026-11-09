/**
 * The pure parts of the phone's accounts (lib/accounts.ts holds the hook
 * that reads and swaps them): kept apart so they're tested without a
 * session, and so the chat header can use them.
 */

import type { Agent, AgentEngine, UsageAccount } from '@shipstudio/companion-protocol';

/** `accounts` with one engine's put in the order of `ids`; the other engine's untouched. */
export function reordered(
  accounts: UsageAccount[],
  engine: AgentEngine,
  ids: string[]
): UsageAccount[] {
  const mine = ids
    .map((id) => accounts.find((a) => a.engine === engine && a.id === id))
    .filter((a): a is UsageAccount => !!a);
  if (mine.length !== accounts.filter((a) => a.engine === engine).length) return accounts;
  let i = 0;
  return accounts.map((a) => (a.engine === engine ? mine[i++] : a));
}

/** One engine's account ids, in order. */
export const idsOf = (accounts: UsageAccount[], engine: AgentEngine) =>
  accounts.filter((a) => a.engine === engine).map((a) => a.id);

/** An engine's accounts for an agent's "Runs on": only with two or more to pick between. */
export function runsOnChoices(
  accounts: UsageAccount[] | null,
  engine: AgentEngine
): UsageAccount[] {
  const mine = (accounts ?? []).filter((a) => a.engine === engine);
  return mine.length > 1 ? mine : [];
}

/** Under an account in "Runs on": what pinning to it means, and why it can't run now. */
export function runsOnDetail(a: Pick<UsageAccount, 'signedIn' | 'out'>): string {
  if (!a.signedIn) return 'Not signed in';
  return a.out ? 'Only this one, never another · out of usage now' : 'Only this one, never another';
}

/**
 * Under the name: its role, and the account its last turn ran on (only
 * while its engine has more than one, as the Mac sends `ranOn`).
 */
export function headerSubtitle(agent: Pick<Agent, 'role' | 'ranOn'>): string {
  const on = agent.ranOn ? `on ${agent.ranOn.name}` : '';
  if (!agent.role) return on ? on.charAt(0).toUpperCase() + on.slice(1) : '';
  return on ? `${agent.role} · ${on}` : agent.role;
}

/**
 * The subtitle in two parts, so the header can let the role give way
 * first: the account is the news, and "Design system · on sam@ex…" hid it.
 */
export function headerSubtitleParts(agent: Pick<Agent, 'role' | 'ranOn'>): {
  role: string;
  on: string;
} {
  const whole = headerSubtitle(agent);
  if (!agent.ranOn || !agent.role)
    return { role: agent.ranOn ? '' : whole, on: agent.ranOn ? whole : '' };
  // A no-break space: a leading plain one is dropped where the two parts meet.
  const on = `\u00a0· on ${agent.ranOn.name}`;
  return { role: agent.role, on };
}
