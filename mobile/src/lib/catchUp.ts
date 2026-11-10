/**
 * Catch up: everything waiting on you, one card at a time, the way Slack's
 * catch-up goes through channels. From the Catch up tab's "One at a time".
 *
 * An item is one of:
 * - **ask**: a request still waiting that this phone can answer (an
 *   approval, a login, a secret, a task's question), one card each;
 * - **reply**: an agent with something new to read (unread replies), or one
 *   that needs you with nothing answerable here (a failed turn, a card only
 *   its chat or the Mac can show): read it, then Chat or Next;
 * - **setup**: "Setting up your team" while it's open, in the Chief's chat.
 *
 * The queue is a list and a place in it. What you've passed stays (so "3 of
 * 8" doesn't jump), the card in front of you stays until you move on (the
 * screen says what became of it), anything still ahead that was answered
 * or read elsewhere drops out, and what arrives while you're catching up
 * joins the end.
 *
 * Pure, so the rules are tested without a screen (`__tests__/catchUp.test.ts`).
 */

import {
  GATE_ALLOW,
  GATE_DENY,
  SKILL_NOT_NOW,
  SKILL_SAVE,
  agentNeedsYou,
  setupHold,
} from '@shipstudio/companion-protocol';
import type { Agent, AgentMessage, TeamSetupView } from '@shipstudio/companion-protocol';
import { answerableHere, failedTurn } from './agents';
import { shows } from './teamSetup';

export type CatchKind = 'ask' | 'reply' | 'setup';

export interface CatchItem {
  key: string;
  kind: CatchKind;
  agentId: string;
  /** An ask: the card's message. */
  messageId?: string;
  /** A reply: how many messages were new when it joined the queue. */
  unread?: number;
  /** When it started waiting, for the order. */
  ts: number;
}

export interface CatchQueue {
  items: CatchItem[];
  /** The card in front of you; `items.length` once you're through. */
  at: number;
}

type Chats = Record<string, { messages: AgentMessage[] } | undefined>;

const SETUP_KEY = 'setup';

/** A card waiting on an answer, that this phone can give. */
const isAsk = (m: AgentMessage, reviewHere: boolean) =>
  m.kind === 'approval' &&
  m.approval?.status === 'pending' &&
  answerableHere(m.approval, reviewHere);

/**
 * Everything waiting, in the order to go through it: setting up your team
 * first (it holds the rest of the team's asks), then every request, oldest
 * first (the longest someone has been stuck), then what's new to read,
 * oldest first.
 */
export function buildItems(
  agents: Agent[],
  chats: Chats,
  setup: TeamSetupView | null | undefined,
  reviewHere = false
): CatchItem[] {
  const hold = setupHold(setup);
  const visible = agents.filter((a) => !a.hidden && !hold.quiet.has(a.id));
  const chief = visible.find((a) => a.isMain);
  const items: CatchItem[] = [];
  if (chief && shows(setup) && !setup.complete) {
    items.push({ key: SETUP_KEY, kind: 'setup', agentId: chief.id, ts: 0 });
  }
  const asks: CatchItem[] = [];
  const replies: CatchItem[] = [];
  for (const agent of visible) {
    const messages = chats[agent.id]?.messages ?? [];
    const own = messages.filter((m) => isAsk(m, reviewHere));
    for (const m of own) {
      asks.push({ key: `ask:${m.id}`, kind: 'ask', agentId: agent.id, messageId: m.id, ts: m.ts });
    }
    if (own.length) continue;
    const loud = agentNeedsYou(agent, hold) || failedTurn(agent) !== null;
    if (loud || agent.unread > 0) {
      replies.push({
        key: `reply:${agent.id}:${agent.lastActivityAt}`,
        kind: 'reply',
        agentId: agent.id,
        unread: agent.unread,
        ts: agent.lastActivityAt,
      });
    }
  }
  const byTs = (a: CatchItem, b: CatchItem) => a.ts - b.ts || a.key.localeCompare(b.key);
  return [...items, ...asks.sort(byTs), ...replies.sort(byTs)];
}

export const startQueue = (items: CatchItem[]): CatchQueue => ({ items, at: 0 });

/**
 * The queue against what's waiting now. Passed and current items stay;
 * items ahead that aren't waiting any more drop out (answered on the desk,
 * read there); new ones join the end. One reply card per agent ahead of you:
 * an agent that says more while queued keeps its place.
 */
export function syncQueue(q: CatchQueue, fresh: CatchItem[]): CatchQueue {
  const freshKeys = new Set(fresh.map((f) => f.key));
  const kept = q.items.filter((it, i) => i <= q.at || freshKeys.has(it.key));
  const known = new Set(kept.map((k) => k.key));
  const replyAhead = new Set(
    kept.filter((k, i) => i >= q.at && k.kind === 'reply').map((k) => k.agentId)
  );
  const added = fresh.filter((f) => {
    if (known.has(f.key)) return false;
    if (f.kind === 'reply' && replyAhead.has(f.agentId)) return false;
    if (f.kind === 'reply') replyAhead.add(f.agentId);
    return true;
  });
  if (!added.length && kept.length === q.items.length) return q;
  return { items: [...kept, ...added], at: q.at };
}

/** On to the next card (Next, or answered). */
export const advance = (q: CatchQueue): CatchQueue => ({
  ...q,
  at: Math.min(q.at + 1, q.items.length),
});

export const current = (q: CatchQueue): CatchItem | null => q.items[q.at] ?? null;

export const isDone = (q: CatchQueue) => q.at >= q.items.length;

/** "3 of 8". */
export function progressOf(q: CatchQueue): { n: number; of: number } {
  return { n: Math.min(q.at + 1, q.items.length), of: q.items.length };
}

export type AskState = 'pending' | 'answered' | 'expired' | 'gone';

/**
 * What became of an ask's card: still waiting, answered (here or on the
 * Mac), not answered in time, or no longer in the chat at all.
 */
export function askState(item: CatchItem, messages: AgentMessage[] | undefined): AskState {
  const m = messages?.find((x) => x.id === item.messageId);
  if (!m?.approval) return 'gone';
  if (m.approval.status === 'pending') return 'pending';
  return m.approval.status === 'expired' ? 'expired' : 'answered';
}

/** What it said leading up to a card, or what's new: words and results, not your own. */
const SAID = new Set<AgentMessage['kind']>(['agent', 'error', 'check_in', 'changes']);
/** No more than this many messages on a card: the rest is one tap away in Chat. */
export const CONTEXT_LIMIT = 3;

/**
 * The messages a card shows above its ask, or as its reply: the agent's
 * own, since the last thing you said, newest last. A reply shows as many as
 * were new (at least one, at most `CONTEXT_LIMIT`); an ask, what led to it.
 */
export function cardMessages(
  item: CatchItem,
  messages: AgentMessage[] | undefined
): AgentMessage[] {
  if (!messages?.length) return [];
  const end =
    item.kind === 'ask' ? messages.findIndex((m) => m.id === item.messageId) : messages.length;
  if (end < 0) return [];
  const want =
    item.kind === 'reply' ? Math.max(1, Math.min(item.unread ?? 1, CONTEXT_LIMIT)) : CONTEXT_LIMIT;
  const out: AgentMessage[] = [];
  for (let i = end - 1; i >= 0 && out.length < want; i--) {
    const m = messages[i];
    if (m.kind === 'user') break;
    // A card already answered isn't what you're reading for.
    if (SAID.has(m.kind) && (m.text.trim() || m.result || m.attachments?.length)) out.push(m);
  }
  return out.reverse();
}

/** How a request card is answered from Catch up. */
export type AskAction =
  | { kind: 'answer'; allow: string; deny: string }
  | { kind: 'open'; label: string };

/**
 * A plain approval is answered right here (Allow / Deny: the app's one word for it, as on every card). A login, a
 * secret, a task's question or an import has its own steps, so its one
 * action opens the card in its chat: "Sign in", "Enter key", "Answer".
 */
export function askAction(m: AgentMessage | undefined): AskAction {
  const a = m?.approval;
  if (!a) return { kind: 'open', label: 'Open' };
  if (a.login) return { kind: 'open', label: 'Sign in' };
  if (a.secret) return { kind: 'open', label: 'Enter key' };
  if (a.prompt) return { kind: 'open', label: 'Answer' };
  if (a.connector?.kind === 'review' || a.connector?.kind === 'playback') {
    return { kind: 'open', label: 'Review' };
  }
  if (a.front) return { kind: 'answer', allow: 'Check again', deny: 'Not now' };
  // Its card's own words: Stop here · Go ahead, Ignore · Save to memory.
  if (a.gate) return { kind: 'answer', allow: GATE_ALLOW, deny: GATE_DENY };
  if (a.handoff) return { kind: 'answer', allow: 'Save to memory', deny: 'Ignore' };
  // "Save … as a skill?": the card's own Save / Not now, as in its chat and on the desk.
  if (a.skill) return { kind: 'answer', allow: SKILL_SAVE, deny: SKILL_NOT_NOW };
  // Step in happens at the Mac: open the card, which says so.
  if (a.stepIn) return { kind: 'open', label: 'Open' };
  // Three answers (Wait, Just this time, Always): the card in its chat has them.
  if (a.crossover) return { kind: 'open', label: 'Answer' };
  return { kind: 'answer', allow: 'Allow', deny: 'Deny' };
}
