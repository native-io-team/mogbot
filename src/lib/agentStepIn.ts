/**
 * "Step in": an agent in its own browser needs a person for one step it
 * can't pass (SSO, a passkey, a 2FA code, a CAPTCHA). Its card offers Step
 * in, which brings that tab's real Chrome window forward on this Mac; the
 * chat then says "You're in <Agent>'s browser · Hand back". From the phone
 * it's the same hold, shown and driven there; the card and the bar then
 * name the phone, and Hand back here ends it there too. The agent can't
 * use that tab meanwhile, and is woken on Hand back with where the page
 * ended up, never what was typed (desktop `agents/step_in.rs`).
 *
 * @module lib/agentStepIn
 */

import { invoke } from '@tauri-apps/api/core';
import type { StepInCard } from '../../packages/companion-protocol/src/model';
import type { AgentMessage, Approval } from './agents';

export type { StepInCard };

/** Step in: the tab's window comes forward and is held for you. */
export const stepIntoAgentBrowser = (agentId: string, requestId: string) =>
  invoke<void>('agents_step_in', { agentId, requestId });

/** Bring the tab you're in forward again. */
export const showStepInWindow = (agentId: string) =>
  invoke<void>('agents_step_in_show', { agentId });

/** Hand the agent its browser back; it carries on from where the page is. */
export const handBackAgentBrowser = (agentId: string, requestId: string) =>
  invoke<void>('agents_step_in_hand_back', { agentId, requestId });

/** The step-in card you're in right now, in this chat, if any. */
export function activeStepIn(messages: readonly AgentMessage[]): Approval | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const a = messages[i].approval;
    if (a?.stepIn && a.status === 'pending' && a.stepIn.inSince) return a;
  }
  return null;
}

/** What the bar adds: the site, and when it hands back by itself. */
export function stepInBarDetail(card: StepInCard, now = Date.now()): string {
  const left = card.until ? Math.max(0, Math.ceil((card.until - now) / 60_000)) : null;
  const ends =
    left === null
      ? ''
      : left <= 1
        ? ' · hands back by itself in a minute'
        : ` · hands back by itself in ${left} min`;
  return `${card.site}${ends}`;
}

export {
  STEP_IN_ON_YOUR_MAC,
  stepInBarTitle,
  stepInOutcome,
  stepInSource,
} from '../../packages/companion-protocol/src/cardWords';

/** The card's note while someone is in the tab: here, or from a phone. */
export function stepInNowNote(onPhone?: string, barShown = false): string {
  if (barShown)
    return onPhone
      ? `${onPhone} is in its browser now. Hand back there, or from the bar below.`
      : 'You’re in its browser now. Hand back from the bar below when you’re done.';
  return onPhone
    ? `${onPhone} is in its browser now. Hand back there, or here.`
    : 'You’re in its browser now. Hand back when you’re done.';
}

/** What the card says about where it opens, and what the agent sees. */
export const STEP_IN_NOTE =
  'Its tab opens in a window on this Mac. Do it there, then Hand back here. It never sees what you type, only where the page ends up.';
