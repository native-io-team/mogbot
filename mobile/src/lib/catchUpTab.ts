/**
 * The Catch up tab's rules, pure so they're tested without a screen
 * (`__tests__/catchUpTab.test.ts`):
 *
 * - **Groups.** The waiting rows (`feedItems`, lib/needsYou.ts) gathered by
 *   agent, each agent where its most urgent row would be.
 * - **The header.** "3 things need you", in the rows' own count.
 * - **Since you last caught up.** What happened that didn't ask anything:
 *   results shared, routines that ran, turns that didn't finish, replies not
 *   read. Only from records the phone has (the agents' saved chats and
 *   their unread counts), never inferred.
 * - **Where the app opens.** Catch up when something waits on you, else
 *   Agents: at launch, and on coming back after a while away, never while
 *   you're somewhere else in the app (a chat, a sheet).
 */

import { checkInHead, previewText } from '@shipstudio/companion-protocol';
import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import type { FeedItem } from './needsYou';

// ---- Groups ------------------------------------------------------------------------

export interface AgentGroup {
  agentId: string;
  items: FeedItem[];
}

/** Rows by agent, in the order the agents' first rows come; rows keep their order. */
export function groupByAgent(items: FeedItem[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const item of items) {
    const g = groups.get(item.agentId);
    if (g) g.items.push(item);
    else groups.set(item.agentId, { agentId: item.agentId, items: [item] });
  }
  return [...groups.values()];
}

/** "3 things need you", "1 thing needs you", "Nothing needs you". */
export function headline(count: number): string {
  if (count <= 0) return 'Nothing needs you';
  return count === 1 ? '1 thing needs you' : `${count} things need you`;
}

/** "From 2 agents" under the headline, only when there's more than one. */
export function fromLine(groups: number): string | null {
  return groups > 1 ? `From ${groups} agents` : null;
}

// ---- Since you last caught up ------------------------------------------------------

export type SinceKind = 'result' | 'routine' | 'failed' | 'replies';

export interface SinceItem {
  key: string;
  kind: SinceKind;
  agentId: string;
  /** The message it opens at, when there is one. */
  messageId?: string;
  ts: number;
  title: string;
  line?: string;
}

/** No more than this many: the rest is in the chats. */
export const SINCE_LIMIT = 6;
/** With no visit on record, how far back "Recently" looks. */
export const FIRST_LOOK_MS = 24 * 60 * 60 * 1000;

type Chats = Record<string, { messages: AgentMessage[] } | undefined>;

const firstLine = (text: string | null | undefined) => {
  const line = (text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return line || undefined;
};

/**
 * What happened since `since`, newest first, from each agent's saved chat:
 * the newest version of each result, routines that ran, turns that ended in
 * an error. An agent with unread replies and nothing else listed is one
 * "2 new messages" row. Agents already in the waiting list (`waiting`) are
 * left out of the replies rows: their row says it.
 */
export function sinceItems(
  agents: Agent[],
  chats: Chats,
  since: number,
  waiting: ReadonlySet<string> = new Set()
): SinceItem[] {
  const out: SinceItem[] = [];
  for (const agent of agents) {
    if (agent.hidden) continue;
    const messages = chats[agent.id]?.messages ?? [];
    const results = new Set<string>();
    let any = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.ts <= since) break;
      if (m.result) {
        if (results.has(m.result.id)) continue;
        results.add(m.result.id);
        out.push({
          key: `result:${m.id}`,
          kind: 'result',
          agentId: agent.id,
          messageId: m.id,
          ts: m.ts,
          title: `Shared “${m.result.title}”`,
          line: firstLine(m.result.summary),
        });
        any = true;
      } else if (m.kind === 'check_in') {
        out.push({
          key: `routine:${m.id}`,
          kind: 'routine',
          agentId: agent.id,
          messageId: m.id,
          ts: m.ts,
          title: `${checkInHead(m.checkIn)} ran`,
          line: firstLine(m.text),
        });
        any = true;
      } else if (m.kind === 'error' && !m.takeover) {
        out.push({
          key: `failed:${m.id}`,
          kind: 'failed',
          agentId: agent.id,
          messageId: m.id,
          ts: m.ts,
          title: 'Didn’t finish',
          line: firstLine(m.text),
        });
        any = true;
      }
    }
    if (!any && agent.unread > 0 && !waiting.has(agent.id) && agent.lastActivityAt > since) {
      out.push({
        key: `replies:${agent.id}`,
        kind: 'replies',
        agentId: agent.id,
        ts: agent.lastActivityAt,
        title: agent.unread === 1 ? '1 new message' : `${agent.unread} new messages`,
        line: firstLine(previewText(agent.preview)),
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key)).slice(0, SINCE_LIMIT);
}

/** The section's name: what "since" was measured from. */
export const sinceTitle = (lastVisit: number | null) =>
  lastVisit ? 'Since you last caught up' : 'Recently';

// ---- Where the app opens -----------------------------------------------------------

/** Away at least this long, and coming back is like opening the app. */
export const AWAY_MS = 10 * 60 * 1000;
/** At launch, the first answer from the Mac may still settle where it opened, this soon. */
export const SETTLE_MS = 4000;

export const CATCH_UP = '/catch-up';
export const AGENTS = '/agents';
export type Landing = typeof CATCH_UP | typeof AGENTS;

/** The tabs' own screens: the only places the app may move you from. */
const TAB_ROOTS = new Set(['/catch-up', '/agents', '/projects', '/search']);
export const onTabRoot = (pathname: string) => TAB_ROOTS.has(pathname);

/** At launch: Catch up when anything waits, else Agents. */
export const landingOnLaunch = (waiting: number): Landing => (waiting > 0 ? CATCH_UP : AGENTS);

/**
 * At launch, once the Mac has answered: where the app should be now, or
 * null to stay. Only within `SETTLE_MS` of launch and only while you're
 * still where it opened (you haven't moved), so a stale saved copy is put
 * right without ever pulling you away from something you chose.
 */
export function settleLaunch(args: {
  landed: Landing;
  pathname: string;
  sinceLaunchMs: number;
  waiting: number;
}): Landing | null {
  if (args.sinceLaunchMs > SETTLE_MS || args.pathname !== args.landed) return null;
  const want = landingOnLaunch(args.waiting);
  return want === args.landed ? null : want;
}

/**
 * Coming back to the app: after `AWAY_MS` or more away, and only from one
 * of the tabs (never a chat, a request or a sheet), Catch up when anything
 * waits. With nothing waiting it stays put, except an emptied Catch up,
 * which hands you to Agents.
 */
export function landingOnReturn(args: {
  awayMs: number;
  pathname: string;
  waiting: number;
}): Landing | null {
  if (args.awayMs < AWAY_MS || !onTabRoot(args.pathname)) return null;
  if (args.waiting > 0) return args.pathname === CATCH_UP ? null : CATCH_UP;
  return args.pathname === CATCH_UP ? AGENTS : null;
}
