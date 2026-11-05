/**
 * Result cards (`share_result`, `src-tauri/src/agents/results.rs`): the one
 * card an agent ends a piece of work on. Types and pure rules shared by the
 * desk and the phone, so both draw the same card from the same message.
 *
 * Everything on a card is the agent's own (its files, copied into the chat;
 * its links; its own lists of what it checked and didn't verify). Nothing
 * here fills a list in or guesses a missing one.
 */

import type { Attachment } from './model';

export type ShotRole = 'before' | 'after';

export type ResultItem =
  | { kind: 'file'; file: Attachment; label?: string; role?: ShotRole }
  | { kind: 'link'; url: string; label?: string };

export interface ResultCard {
  /** The same across versions of one result. */
  id: string;
  version: number;
  title: string;
  summary: string;
  items?: ResultItem[];
  checked?: string[];
  notVerified?: string[];
  /** From version 2: what changed since the version before, in the agent's words. */
  changes?: string;
  /**
   * The user's project the work is in (its path, resolved against the real
   * project list by the app): the desk's card offers Preview.
   */
  project?: string;
}

/** On a user message: "Ask for changes" on this result, as it stood then. */
export interface ResultRef {
  id: string;
  version: number;
  title: string;
}

/** Anything carrying a card: an `agent` message, or a `changes` card it rode on. */
interface Carrier {
  id: string;
  result?: ResultCard;
}

/**
 * For each result in a conversation, the message holding its newest
 * version. Older versions are folded to a line that points at it.
 */
export function newestResults(messages: readonly Carrier[]): Map<string, string> {
  const newest = new Map<string, { message: string; version: number }>();
  for (const m of messages) {
    const r = m.result;
    if (!r) continue;
    const seen = newest.get(r.id);
    if (!seen || r.version >= seen.version) newest.set(r.id, { message: m.id, version: r.version });
  }
  // Array.from, not a spread: the phone's Babel would need a runtime helper
  // this package can't resolve.
  const out = new Map<string, string>();
  newest.forEach((v, id) => out.set(id, v.message));
  return out;
}

/** The before and after pictures, when the agent gave both. */
export function beforeAfter(
  items: readonly ResultItem[] = []
): { before: Attachment; after: Attachment } | null {
  const pick = (role: ShotRole) =>
    items.find(
      (i): i is Extract<ResultItem, { kind: 'file' }> => i.kind === 'file' && i.role === role
    )?.file;
  const before = pick('before');
  const after = pick('after');
  return before && after ? { before, after } : null;
}

/**
 * The card's files and links in order, without the before/after pair when
 * that is shown side by side.
 */
export function listedItems(items: readonly ResultItem[] = []): ResultItem[] {
  const paired = beforeAfter(items);
  return items.filter(
    (i) => !(paired && i.kind === 'file' && (i.file === paired.before || i.file === paired.after))
  );
}

/**
 * The heading over the agent's "checked" lines. Attributed, never a bare
 * "Checked": the app didn't run these checks, the agent says it did.
 */
export const CHECKED_HEADING = 'It says it checked';

/** "Changes since v1": only ever the agent's own line, never made up. */
export function changesLine(card: ResultCard): string | null {
  if (card.version < 2 || !card.changes?.trim()) return null;
  return `Changes since v${card.version - 1}: ${card.changes.trim()}`;
}

/** What an item is called on the card: its label, else the file's name or the link's host. */
export function itemName(item: ResultItem): string {
  if (item.label?.trim()) return item.label.trim();
  if (item.kind === 'file') return item.file.name;
  try {
    const url = new URL(item.url);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return item.url;
  }
}

/** The line a "folded" older version shows: short enough for one line on a phone. */
export function supersededLine(card: ResultCard): string {
  return `${card.title} · v${card.version} · earlier version`;
}

/** The chip above the composer, and the quote bar on the message it sends. */
export function revisingLabel(ref: ResultRef): string {
  return `Changes to ${ref.title} · v${ref.version}`;
}
