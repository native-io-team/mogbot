/**
 * Other agents' requests, as one chat offers them: who is asking, how many
 * cards each has open, and the words the requests bar and its panel say
 * (`components/agents/AgentRequests.tsx`). Pure, so the grouping and the
 * counts are tested.
 *
 * Counted only from what is known: the cards in each agent's loaded lines,
 * and the registry's `pendingApprovals` for cards older than the lines
 * loaded. Nothing is estimated.
 *
 * @module lib/agentRequests
 */

import { secretTitle } from './agentSecrets';
import type { Agent, AgentMessage } from './agents';

export interface RequestGroup {
  agent: Agent;
  /** Its cards this chat doesn't already show: pending, or kept to show what they resolved to. */
  cards: AgentMessage[];
  /** Pending, of those cards. */
  pending: number;
  /**
   * Pending cards the registry counts that aren't in its loaded lines (they
   * are further back in its chat). Answered there, never guessed at here.
   */
  older: number;
  /** Pending login cards (and secure input cards from before them). */
  logins: number;
}

export interface RequestsSummary {
  groups: RequestGroup[];
  /** Agents with at least one request still open. */
  agents: number;
  /** Requests still open, across them. */
  requests: number;
  /** Of those, logins (secure input cards). */
  logins: number;
}

const isPending = (m: AgentMessage) => m.approval?.status === 'pending';
/** A login: a login card (`request_login`), or a secure input card from before them. */
const isLogin = (m: AgentMessage) => Boolean(m.approval?.login || m.approval?.secret);

/**
 * Group the asking agents' cards. `keep` holds card ids to keep showing once
 * answered (answered here, while the panel is open). Agents whose lines
 * haven't loaded are left out until they have, as are agents with nothing
 * left to show: their request is already a card in this chat, or it isn't
 * written yet. Name order, so the list doesn't move as you answer it.
 */
export function groupRequests(
  askers: Agent[],
  messages: Record<string, AgentMessage[] | undefined>,
  shownRequestIds: ReadonlySet<string>,
  keep: ReadonlySet<string> = new Set()
): RequestsSummary {
  const groups: RequestGroup[] = [];
  for (const agent of askers) {
    const lines = messages[agent.id];
    if (!lines) continue;
    const approvals = lines.filter((m) => m.kind === 'approval' && m.approval);
    const cards = approvals.filter(
      (m) => !shownRequestIds.has(m.approval!.requestId) && (isPending(m) || keep.has(m.id))
    );
    const pendingInLines = approvals.filter(isPending).length;
    const older = Math.max(0, (agent.pendingApprovals ?? 0) - pendingInLines);
    const pending = cards.filter(isPending).length;
    if (cards.length === 0 && older === 0) continue;
    groups.push({
      agent,
      cards,
      pending,
      older,
      logins: cards.filter((m) => isPending(m) && isLogin(m)).length,
    });
  }
  groups.sort((a, b) => a.agent.name.localeCompare(b.agent.name));
  const open = groups.filter((g) => g.pending + g.older > 0);
  return {
    groups,
    agents: open.length,
    requests: open.reduce((n, g) => n + g.pending + g.older, 0),
    logins: open.reduce((n, g) => n + g.logins, 0),
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Lead Gen needs your OK", "Finance and Lead Gen need your OK", "16 agents need your OK". */
export function requestsTitle(summary: RequestsSummary): string {
  const names = summary.groups.filter((g) => g.pending + g.older > 0).map((g) => g.agent.name);
  if (names.length === 0) return 'Nothing else needs your OK';
  if (names.length === 1) return `${names[0]} needs your OK`;
  if (names.length === 2) return `${names[0]} and ${names[1]} need your OK`;
  return `${names.length} agents need your OK`;
}

/**
 * What they are: "41 logins to add", "3 requests", "2 requests, 1 of them a
 * login". A login is a secure input card; logins are counted only from
 * cards that have loaded, so an older card counts as a request.
 */
export function requestsDetail(summary: RequestsSummary): string {
  const { requests, logins } = summary;
  if (requests === 0) return 'What you answered stays here until you close it.';
  if (logins === requests) return `${count(logins, 'login')} to add`;
  if (logins === 0) return count(requests, 'request');
  return `${count(requests, 'request')}, ${logins} of them ${logins === 1 ? 'a login' : 'logins'}`;
}

/** The panel's subtitle: "16 agents · 41 logins", "2 agents · 3 requests". */
export function requestsCounts(summary: RequestsSummary): string {
  const what =
    summary.logins === summary.requests
      ? count(summary.logins, 'login')
      : count(summary.requests, 'request');
  return `${count(summary.agents, 'agent')} · ${what}`;
}

/** Up to `max` names, then "…": the line under an agent's name. */
const list = (names: string[], max = 2) =>
  names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', ');

/**
 * One agent's line in the panel: "4 logins: Slack bot token, Slack user
 * token…", the one request's own title, or "3 requests, 1 of them a login".
 * "Answered" once nothing is left.
 */
export function groupLine(group: RequestGroup): string {
  const open = group.pending + group.older;
  if (open === 0) return 'Answered';
  const pendingCards = group.cards.filter(isPending);
  if (group.older === 0 && group.logins === open) {
    const names = pendingCards.map((m) =>
      m.approval!.login ? m.approval!.login.title : secretTitle(m.approval!.secret!.name)
    );
    return `${count(open, 'login')}: ${list(names)}`;
  }
  if (open === 1 && pendingCards.length === 1) {
    const a = pendingCards[0].approval!;
    return a.prompt?.question ?? a.title;
  }
  if (group.logins === 0) return count(open, 'request');
  return `${count(open, 'request')}, ${group.logins} of them ${group.logins === 1 ? 'a login' : 'logins'}`;
}
