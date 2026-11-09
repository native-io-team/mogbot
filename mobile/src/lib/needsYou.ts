/**
 * The "Needs you" feed: every card waiting on you, across every agent, in
 * one list. The phone's one place for it (its own tab, with the count);
 * Home's bar and a tapped alert lead here.
 *
 * An item is one of:
 * - **ask**: a card still waiting that this phone can answer: an approval,
 *   a plan, "OK to go on?", a key, a login, a session's question. A plain
 *   one is answered on its row (Deny · Allow); the rest open.
 * - **keep**: a task copy with changes, waiting on Keep or Discard.
 * - **stuck**: an agent that needs you with no card this phone has (a failed
 *   turn only you can fix, or a card its chat hasn't loaded yet).
 * - **mac**: a card only the Mac can answer (an import to review).
 * - **setup**: "Setting up your team" while it's open.
 *
 * Order: what blocks an agent first, then the rest; newest first within
 * each, so what just arrived is on top. Answered cards leave by themselves:
 * the list is rebuilt from the store on every change.
 *
 * Pure, so the rules are tested without a screen (`__tests__/needsYou.test.ts`).
 */

import { agentNeedsYou, setupHold } from '@shipstudio/companion-protocol';
import type { Agent, AgentMessage, TeamSetupView } from '@shipstudio/companion-protocol';
import { answerableHere, failedTurn } from './agents';
import { askAction, type AskAction } from './catchUp';
import { shows } from './teamSetup';

export type FeedKind = 'ask' | 'keep' | 'stuck' | 'mac' | 'setup';

export interface FeedItem {
  key: string;
  kind: FeedKind;
  agentId: string;
  /** The card (an ask, a review on the Mac) or the change card (a keep). */
  messageId?: string;
  /** When it started waiting. */
  ts: number;
}

type Chats = Record<string, { messages: AgentMessage[] } | undefined>;

/** Lower is more urgent: an agent blocked on you before anything that can wait. */
const TIER: Record<FeedKind, number> = { ask: 0, stuck: 1, keep: 2, setup: 3, mac: 4 };

const pendingCard = (m: AgentMessage) =>
  m.kind === 'approval' && m.approval?.status === 'pending' ? m.approval : null;

/** The change card a task copy's Keep / Discard lives on, while that copy is open. */
export function keepCard(agent: Agent, messages: AgentMessage[] | undefined) {
  const copy = agent.copy;
  if (!copy || !messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].changes;
    if (c?.copy?.id === copy.id) return c.fileCount > 0 ? messages[i] : undefined;
  }
  return undefined;
}

export function feedItems(
  agents: Agent[],
  chats: Chats,
  setup: TeamSetupView | null | undefined,
  reviewHere = false
): FeedItem[] {
  const hold = setupHold(setup);
  const visible = agents.filter((a) => !a.hidden && !hold.quiet.has(a.id));
  const items: FeedItem[] = [];
  const chief = visible.find((a) => a.isMain);
  if (chief && shows(setup) && !setup.complete) {
    items.push({ key: 'setup', kind: 'setup', agentId: chief.id, ts: 0 });
  }
  for (const agent of visible) {
    const messages = chats[agent.id]?.messages;
    let asks = 0;
    for (const m of messages ?? []) {
      const card = pendingCard(m);
      if (!card) continue;
      const here = answerableHere(card, reviewHere);
      items.push({
        key: `${here ? 'ask' : 'mac'}:${m.id}`,
        kind: here ? 'ask' : 'mac',
        agentId: agent.id,
        messageId: m.id,
        ts: m.ts,
      });
      asks++;
    }
    // Keep / Discard waits once the turn is over; mid-turn the copy is still changing.
    const keep = agent.status.state === 'idle' ? keepCard(agent, messages) : undefined;
    if (keep) {
      items.push({
        key: `keep:${keep.id}`,
        kind: 'keep',
        agentId: agent.id,
        messageId: keep.id,
        ts: keep.ts,
      });
    }
    if (asks) continue;
    const failed = failedTurn(agent);
    const stuck =
      (failed !== null && failed.kind !== 'usage_limit') ||
      // Counted as waiting, but this phone hasn't loaded the card (yet).
      ((agent.pendingApprovals ?? 0) > 0 && agentNeedsYou(agent, hold)) ||
      agent.status.state === 'waiting';
    if (stuck) {
      items.push({
        key: `stuck:${agent.id}`,
        kind: 'stuck',
        agentId: agent.id,
        ts: agent.lastActivityAt,
      });
    }
  }
  return items.sort(
    (a, b) => TIER[a.kind] - TIER[b.kind] || b.ts - a.ts || a.key.localeCompare(b.key)
  );
}

/** How a row is answered: right there (Deny · Allow), or by opening it. */
export type RowAction = AskAction | { kind: 'open'; label: string };

export function rowAction(item: FeedItem, card: AgentMessage | undefined): RowAction {
  switch (item.kind) {
    case 'ask':
      return askAction(card);
    case 'keep':
      return { kind: 'open', label: 'Review changes' };
    case 'setup':
      return { kind: 'open', label: 'Continue' };
    case 'mac':
      return { kind: 'open', label: 'Open' };
    case 'stuck':
      return { kind: 'open', label: 'Open chat' };
  }
}

/**
 * Whether a card's whole content fits on its row (and on a notification):
 * a short detail, no list longer than a few items. A longer one opens in
 * full first, so nobody allows what they couldn't read.
 */
export const FITS_CHARS = 160;
export const FITS_LINES = 3;
export const FITS_STEPS = 3;

export function fitsWhole(message: AgentMessage | undefined): boolean {
  const a = message?.approval;
  if (!a) return false;
  if (a.plan) {
    const words = a.plan.actions.reduce((n, x) => n + x.summary.length + (x.text?.length ?? 0), 0);
    return a.plan.actions.length <= FITS_STEPS && words <= FITS_CHARS;
  }
  const text = (a.summary?.trim() || a.detail || '').trim();
  return text.length <= FITS_CHARS && text.split('\n').length <= FITS_LINES;
}
