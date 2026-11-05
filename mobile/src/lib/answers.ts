/**
 * How an approval's answers are laid out, as data the cards and the tests
 * share. One rule in every layout: the safe pair, Deny | Allow, is the only
 * row of answers, and anything that covers more than this one request sits
 * behind ⋯, so the button under a thumb is never a broader scope.
 */

import type { PromptOption, SessionPrompt } from '@shipstudio/companion-protocol';

/**
 * An option that covers more than this one request ("Yes, allow all edits
 * during this session", "…and don't ask again").
 */
export const BROADER = /\b(all|always|during this session|don.t ask again|for this session)\b/i;

/**
 * What a broader option covers, in a sentence. The phone can't know its
 * exact reach (that's the session's), so it says what the words promise and
 * no more; anything it can't read stays "more than this one request".
 */
export function broaderCaption(label: string): string {
  const session = /\b(during|for) this session\b/i.test(label);
  const forever = /\b(always|don.t ask again)\b/i.test(label);
  const edits = /\bedit/i.test(label);
  const what = edits ? 'make edits' : 'do this';
  if (session) return `Lets it ${what} without asking for the rest of this session.`;
  if (forever) return `Lets it ${what} without asking again, not just this once.`;
  return 'Covers more than this one request.';
}

export interface IndexedOption {
  option: PromptOption;
  index: number;
}

export interface PromptAnswers {
  deny?: IndexedOption;
  allow?: IndexedOption;
  /** Behind ⋯: everything past the safe pair. Empty when there is no pair. */
  more: IndexedOption[];
  /** Shown as buttons of their own: only a question with no Deny | Allow (a plain menu). */
  listed: IndexedOption[];
}

export function promptAnswers(prompt: Pick<SessionPrompt, 'options'>): PromptAnswers {
  const indexed = prompt.options.map((option, index) => ({ option, index }));
  const deny = indexed.find(({ option }) => option.role === 'deny');
  const allow = indexed.find(({ option }) => option.role === 'allow');
  const others = indexed.filter((o) => o !== deny && o !== allow);
  const pair = !!(deny || allow);
  return { deny, allow, more: pair ? others : [], listed: pair ? [] : others };
}

/** The ⋯ sheet's explanation: what the broadest option in it covers, if any is broader. */
export function moreMessage(more: IndexedOption[]): string | undefined {
  const broad = more.filter(({ option }) => BROADER.test(option.label));
  if (!broad.length) return undefined;
  if (broad.length > 1) return 'Some of these cover more than this one request.';
  return broaderCaption(broad[0].option.label);
}
