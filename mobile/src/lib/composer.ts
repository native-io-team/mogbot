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
 * Whether the field is a card (files, words across its width, a row of buttons
 * under them) rather than the one-line capsule. Empty is always the capsule,
 * at any width: the measuring line has no words to measure, and `room` (the
 * field less the + and the buttons) is not settled while they lay out, so a
 * measure against it could flip a fresh, empty field into a card for a frame.
 * A line that no longer fits, or an explicit new line, makes the card; a
 * `room` not above zero means nothing has been laid out to compare against.
 */
export function fieldIsCard(f: {
  listening: boolean;
  hasTop: boolean;
  value: string;
  /** The field's width, 0 until laid out. */
  width: number;
  /** The words on one unwrapped line, as measured. */
  oneLine: number;
  /** The capsule's room for the words. */
  room: number;
}): boolean {
  if (f.listening || f.hasTop) return true;
  if (f.value.length === 0) return false;
  if (f.value.includes('\n')) return true;
  return f.width > 0 && f.room > 0 && f.oneLine > f.room;
}

/** The buttons at the field's right, in order (the + and the engine chip are at its left). */
export type ComposerControl = 'mic' | 'stop' | 'send';

/**
 * The mic is always there: dictating while a turn runs queues what you say,
 * as typing does. Stop joins it while a turn runs that can be stopped here
 * (not one waiting on your OK, where the card is the control, nor one driven
 * on the Mac). Send is always there too, dimmed until there's something to
 * send; while a turn runs it queues.
 */
export function composerControls(agent: Agent): ComposerControl[] {
  const busy = agent.status.state !== 'idle';
  const stoppable = busy && !agent.takeover && !needsYou(agent);
  return stoppable ? ['mic', 'stop', 'send'] : ['mic', 'send'];
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

/** Where the insertion point is in the message field; null before it has been put anywhere. */
export type FieldCaret = { start: number; end: number } | null;

/**
 * Whether the message field keeps its newest line in view as the words grow
 * past its six lines: always while it listens (the words arrive at the end);
 * otherwise only while the insertion point is at the end, so editing a line
 * further up never pulls the view away from it. A caret that hasn't been put
 * anywhere is at the end (where typing goes). `before` is the text's length
 * the caret was last reported against: the field reports the new text before
 * the caret that moved with it, so a caret at the old end is still at the end.
 */
export function followsEnd({
  dictating,
  caret,
  length,
  before = length,
}: {
  dictating: boolean;
  caret: FieldCaret;
  length: number;
  before?: number;
}): boolean {
  if (dictating || !caret) return true;
  // A selection is the reader at work on it: leave the view where it is.
  if (caret.start !== caret.end) return false;
  return caret.end >= Math.min(length, before);
}

/** The `@partial` being typed at the end of the text, if any. */
export function mentionQuery(text: string): string | null {
  const m = /(?:^|\s)@([\w.-]{0,24})$/.exec(text);
  return m ? m[1] : null;
}
