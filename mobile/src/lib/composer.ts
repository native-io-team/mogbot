/** The composer's rules, pure so they're tested (components/Composer.tsx draws them). */

import { withQuotes, type Agent } from '@shipstudio/companion-protocol';
import { needsYou } from './agents';
import { liveMentions, type ComposerDraft } from './drafts';
import type { PendingAttachment } from './sync';

/** What the main button does now. */
export type SendMode = 'send' | 'queue' | 'stop' | 'none';

/** The composer's state machine, pure so it is tested. */
export function sendMode(agent: Agent, hasContent: boolean): SendMode {
  // Being driven on the Mac: what you send waits, and there's no turn to stop.
  if (agent.takeover) return hasContent ? 'queue' : 'none';
  const busy = agent.status.state !== 'idle';
  if (hasContent) return busy ? 'queue' : 'send';
  // Waiting on an approval: the card is the control, not Stop.
  if (busy && !needsYou(agent)) return 'stop';
  return 'none';
}

/**
 * What Send sends from a draft: the words with their quotes, the agents
 * still @mentioned, the uploaded files. Null when there's nothing to send,
 * which is also what a second tap finds once the first emptied the draft.
 */
export function takeDraft(draft: ComposerDraft | undefined): {
  body: string;
  mentions: string[];
  files: PendingAttachment[];
} | null {
  if (!draft) return null;
  const text = draft.text.trim();
  const files = (draft.files ?? []).map(({ stagedAt: _at, ...f }) => f);
  if (!text && !draft.quotes.length && !files.length) return null;
  return {
    body: withQuotes(draft.quotes, text),
    mentions: liveMentions(draft.text, draft.mentions).map((m) => m.id),
    files,
  };
}

/** The `@partial` being typed at the end of the text, if any. */
export function mentionQuery(text: string): string | null {
  const m = /(?:^|\s)@([\w.-]{0,24})$/.exec(text);
  return m ? m[1] : null;
}
