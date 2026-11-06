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
  | {
      kind: 'file';
      file: Attachment;
      /** The caption, in the agent's words. */
      label?: string;
      role?: ShotRole;
      /**
       * Which page (or screen) a before/after shot is of ("Home", "Pricing"):
       * the card shows one compare per page, with a switcher between them.
       */
      page?: string;
    }
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
  /**
   * "Test it": what the agent found clicking through the site in the preview
   * beside the chat (`agents/preview_test.rs`). Steps and console errors are
   * the app's observations; outcome, summary and `broken` are the agent's.
   */
  test?: TestReport;
  /**
   * Shared partway through the work, at a milestone, rather than at its
   * end: the turn carries on, and its final card is the next version.
   */
  checkpoint?: boolean;
}

export type TestStepKind =
  | 'open'
  | 'click'
  | 'type'
  | 'scroll'
  | 'viewport'
  | 'look'
  | 'console'
  | 'network'
  | 'shot'
  | 'note';

/** One thing the agent did in the preview, in the app's words (a note is the agent's). */
export interface TestStep {
  kind: TestStepKind;
  label: string;
  /** False when the action didn't do what was asked, or a note flags a problem. */
  ok: boolean;
  shot?: Attachment;
  ts: number;
}

export type TestOutcome = 'passed' | 'broken';

export interface TestReport {
  outcome: TestOutcome;
  summary: string;
  broken?: string[];
  consoleErrors?: string[];
  steps?: TestStep[];
  /** It ran against the agent's copy of the project. */
  onCopy?: boolean;
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

/** One page of a visual result: its before and after, either of which may be missing. */
export interface ComparePage {
  /** The page's name as the agent gave it; empty for a card that named none. */
  page: string;
  before?: Attachment;
  after?: Attachment;
  /** The agent's captions for each picture, when it gave them. */
  beforeLabel?: string;
  afterLabel?: string;
}

type FileItem = Extract<ResultItem, { kind: 'file' }>;

/**
 * The card's before/after pictures, one entry per page, in the order the
 * agent first named each page. A page needs at least one picture with a
 * role; the first `before` and the first `after` for a page win, and any
 * further ones stay in the item list.
 */
export function comparePages(items: readonly ResultItem[] = []): ComparePage[] {
  const pages: ComparePage[] = [];
  for (const item of items) {
    if (item.kind !== 'file' || !item.role) continue;
    const name = item.page?.trim() ?? '';
    let page = pages.find((p) => p.page === name);
    if (!page) {
      page = { page: name };
      pages.push(page);
    }
    if (item.role === 'before' && !page.before) {
      page.before = item.file;
      page.beforeLabel = item.label?.trim() || undefined;
    } else if (item.role === 'after' && !page.after) {
      page.after = item.file;
      page.afterLabel = item.label?.trim() || undefined;
    }
  }
  return pages;
}

/** The pictures `comparePages` placed, so the item list doesn't show them twice. */
function compared(items: readonly ResultItem[]): Set<Attachment> {
  const out = new Set<Attachment>();
  comparePages(items).forEach((p) => {
    if (p.before) out.add(p.before);
    if (p.after) out.add(p.after);
  });
  return out;
}

/** What a page is called on the switcher: its name, else "Page n". */
export function comparePageName(page: ComparePage, index: number): string {
  return page.page || `Page ${index + 1}`;
}

/**
 * The card's files and links in order, without the pictures shown in the
 * before/after compare.
 */
export function listedItems(items: readonly ResultItem[] = []): ResultItem[] {
  const shown = compared(items);
  return items.filter((i) => !(i.kind === 'file' && shown.has((i as FileItem).file)));
}

/** "Partway: …" over a checkpoint card, so it never reads as the finished work. */
export const CHECKPOINT_LABEL = 'Partway through';

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

/** The steps that kept a screenshot, in order: the strip of pictures a test leaves. */
export function testShots(report: TestReport | undefined): { shot: Attachment; label: string }[] {
  return (report?.steps ?? []).flatMap((s) => (s.shot ? [{ shot: s.shot, label: s.label }] : []));
}

/** The test's headline: the outcome in a few words, never more than the agent said. */
export function testHeadline(report: TestReport): string {
  if (report.outcome === 'passed') return 'Tested in the preview: it works';
  const n = report.broken?.length ?? 0;
  return n === 1
    ? 'Tested in the preview: 1 thing is broken'
    : `Tested in the preview: ${n} things are broken`;
}

/** "2 console errors", or null when the console was clean. */
export function consoleLine(report: TestReport): string | null {
  const n = report.consoleErrors?.length ?? 0;
  if (n === 0) return null;
  return n === 1 ? '1 console error' : `${n} console errors`;
}
