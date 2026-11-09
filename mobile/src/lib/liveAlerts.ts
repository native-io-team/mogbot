/**
 * The Mac's alerts, posted (`alert` events; `companion/alerts.rs` on the Mac).
 *
 * The Mac decides what is news: mute, quiet hours, a chat on screen
 * anywhere, the user at the desk, one per turn. This phone only posts it:
 *
 * - **An approval gets its card's own notification** (`approvalNotice`):
 *   its words, and Allow / Deny when the whole card fits. The card arrives
 *   over the same socket as the alert, usually just before it; if the alert
 *   comes first, a plain one is posted and the card's replaces it (the same
 *   identifier, `approval:<message id>`).
 * - **Everything else** is posted as said, after `redact` once more.
 * - **Once**: the same alert twice (two sockets from this phone, a retry)
 *   posts once; the same message's alert replaces rather than stacks.
 * - **Not in front of it**: with the app open on that chat, nothing.
 * - **One banner**: the relay's content-free push for the same agent is
 *   taken back once this one is posted (`dismissPushFor`).
 *
 * Taking it back when the card is answered elsewhere is `noticeMessage` in
 * the session: the card's new state arrives as `agents.message`.
 */

import type { Agent, AgentMessage, Alert } from '@shipstudio/companion-protocol';
import { approvalNotice, redact, type ApprovalNotice } from './actionable';
import { dismissPushFor, post, postNotice, type PushKind } from './notify';

export interface LiveAlertDeps {
  /** The agent as the overview has it. */
  agent: (agentId: string) => Pick<Agent, 'id' | 'name' | 'muted' | 'hidden'> | undefined;
  /** The app is in front with this agent's chat open. */
  inFront: (agentId: string) => boolean;
  post: (alert: Alert) => Promise<unknown>;
  postNotice: (notice: ApprovalNotice) => Promise<boolean>;
  dismissPushFor: (agentId: string, kinds: PushKind[]) => Promise<unknown>;
  now: () => number;
}

/** How long the same alert counts as a repeat. */
const REPEAT_MS = 30_000;
/** Pending cards kept to dress a late alert in; the oldest go first. */
const CARDS_KEPT = 50;
/** How long after posting the relay's duplicate is looked for again. */
const PUSH_DEDUPE_MS = 4000;

const pushKindsFor = (alert: Alert): PushKind[] =>
  alert.kind === 'approval' ? ['needs_you'] : ['finished', 'message'];

export class LiveAlerts {
  /** Pending approval cards heard over the socket, by message id. */
  private cards = new Map<string, AgentMessage>();
  /** Approval alerts posted plainly, waiting for their card's words. */
  private waiting = new Set<string>();
  private recent = new Map<string, number>();

  constructor(private deps: LiveAlertDeps) {}

  /** A card arrived or changed over the socket. */
  heard(m: AgentMessage) {
    if (m.kind !== 'approval' || !m.approval) return;
    if (m.approval.status !== 'pending') {
      this.cards.delete(m.id);
      this.waiting.delete(m.id);
      return;
    }
    this.cards.set(m.id, m);
    while (this.cards.size > CARDS_KEPT) {
      const oldest = this.cards.keys().next().value;
      if (oldest === undefined) break;
      this.cards.delete(oldest);
    }
    if (this.waiting.has(m.id)) {
      this.waiting.delete(m.id);
      void this.postCard(m);
    }
  }

  /** The Mac said to post this. Resolves once it is posted (or isn't). */
  async alert(alert: Alert) {
    if (this.deps.inFront(alert.agentId) || this.repeat(alert)) return;
    if (alert.kind === 'approval' && alert.messageId) {
      const card = this.cards.get(alert.messageId);
      if (card) {
        await this.postCard(card);
        return;
      }
      const agent = this.deps.agent(alert.agentId);
      if (agent && (agent.muted || agent.hidden)) return;
      this.waiting.add(alert.messageId);
    }
    await this.deps.post({
      ...alert,
      title: redact(alert.title).text,
      body: redact(alert.body).text,
    });
    this.dropPush(alert.agentId, pushKindsFor(alert));
  }

  forget() {
    this.cards.clear();
    this.waiting.clear();
    this.recent.clear();
  }

  private async postCard(m: AgentMessage) {
    const agent = this.deps.agent(m.agentId);
    const notice = agent && approvalNotice(agent, m);
    if (!notice) return;
    if (await this.deps.postNotice(notice)) this.dropPush(m.agentId, ['needs_you']);
  }

  private dropPush(agentId: string, kinds: PushKind[]) {
    void this.deps.dismissPushFor(agentId, kinds);
    setTimeout(() => void this.deps.dismissPushFor(agentId, kinds), PUSH_DEDUPE_MS);
  }

  private repeat(alert: Alert) {
    const now = this.deps.now();
    for (const [k, at] of this.recent) if (now - at >= REPEAT_MS) this.recent.delete(k);
    const key = `${alert.kind}:${alert.agentId}:${alert.messageId ?? `${alert.title}\n${alert.body}`}`;
    if (this.recent.has(key)) return true;
    this.recent.set(key, now);
    return false;
  }
}

export const defaultDeps = (
  agent: LiveAlertDeps['agent'],
  inFront: LiveAlertDeps['inFront']
): LiveAlertDeps => ({
  agent,
  inFront,
  post,
  postNotice,
  dismissPushFor,
  now: Date.now,
});
