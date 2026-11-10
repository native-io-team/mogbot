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

/** What a reply shrinks to when its card says the same. */
export const FOLDED_REPLY = 'Here it is:';

/** Words of a text with markdown, punctuation, case and spacing removed. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>~|\[\]()]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Share of `reply`'s words that `card` also has (each word counted once per use). */
function covered(reply: string[], card: string[]): number {
  if (reply.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const w of card) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of reply) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      pool.set(w, left - 1);
      hit++;
    }
  }
  return hit / reply.length;
}

interface Foldable extends Carrier {
  kind: string;
  text: string;
  attachments?: unknown[];
}

/**
 * A result card often arrives right under the reply that already said the
 * same thing. When the agent bubble just before a card (nothing from you in
 * between) is substantially the card's summary, it shrinks to one line and
 * the card keeps the words. A reply with anything the card doesn't have
 * (under 85% of its words in the card's title and summary) is left whole.
 */
export function foldResultReplies<T extends Foldable>(messages: readonly T[]): T[] {
  let out: T[] | null = null;
  for (let i = 1; i < messages.length; i++) {
    const card = messages[i].result;
    if (!card || card.checkpoint) continue;
    let j = i - 1;
    while (j >= 0 && (messages[j].kind === 'note' || messages[j].kind === 'changes')) j--;
    const reply = messages[j];
    if (!reply || reply.kind !== 'agent' || reply.result || reply.attachments?.length) continue;
    if (reply.text.trim() === FOLDED_REPLY) continue;
    const mine = words(reply.text);
    if (mine.length < 8) continue;
    if (covered(mine, words(`${card.title} ${card.summary}`)) < 0.85) continue;
    out ??= messages.slice();
    out[j] = { ...reply, text: FOLDED_REPLY };
  }
  return out ?? (messages as T[]);
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

/**
 * Every version of each result in a conversation, oldest first, keyed by the
 * result's id: what the card's version switcher (v1 · v2) offers. Only what
 * the log holds; a version the log no longer has is simply absent.
 */
export function resultVersions(messages: readonly Carrier[]): Map<string, ResultCard[]> {
  const out = new Map<string, ResultCard[]>();
  for (const m of messages) {
    const r = m.result;
    if (!r) continue;
    const list = out.get(r.id) ?? [];
    // A version recorded twice is shown once: the later one wins.
    const at = list.findIndex((c) => c.version === r.version);
    if (at >= 0) list[at] = r;
    else list.push(r);
    out.set(r.id, list);
  }
  out.forEach((list) => list.sort((a, b) => a.version - b.version));
  return out;
}

/**
 * The state a result card's pill says, from what the card itself carries:
 * shared partway through, an earlier version, or the finished work. Never
 * "verified": that is the agent's to say, in its checks.
 */
export type ResultStatus = 'partway' | 'earlier' | 'finished';

export function resultStatus(card: ResultCard, newest: boolean): ResultStatus {
  if (!newest) return 'earlier';
  return card.checkpoint ? 'partway' : 'finished';
}

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  partway: CHECKPOINT_LABEL,
  earlier: 'Earlier version',
  finished: 'Finished',
};

/**
 * What kind of place a link goes, for its row's icon: a site running on this
 * Mac, a repository, a document or sheet, or any other page. Read from the
 * address alone, so it is only ever an icon, never words.
 */
export type LinkKind = 'local' | 'repo' | 'doc' | 'web';

export function linkKind(url: string): LinkKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'web';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local'))
    return 'local';
  if (/(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/.test(host)) return 'repo';
  if (/(^|\.)(docs\.google\.com|notion\.so|notion\.site|dropbox\.com|figma\.com)$/.test(host))
    return 'doc';
  return 'web';
}

/** A link's address as its row's second line: the host, without "www.". */
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A picture must be at least this much taller than wide to be a phone screen. */
export const PORTRAIT_RATIO = 1.3;
/** Widest a phone screen is in pixels (a 3x Pro Max is 1320); wider is a desktop shot. */
const PHONE_MAX_PX = 1320;
/** At most this wide, a picture is a phone at 1x (CSS pixels), whatever its length. */
const PHONE_1X_PX = 500;
/** A phone's screen, between 1x and 3x, is this shape (16:9 up to today's tall ones). */
const PHONE_SCREEN = { min: 1.7, max: 2.4 };
const DESK_WORDS = /\b(desktop|laptop|tablet|ipad|wide|widescreen|monitor)\b/i;
const PHONE_WORDS = /\b(phone|mobile|iphone|android)\b/i;

/**
 * Whether a picture is a phone screen, so it gets a device frame. The agent's
 * own words (caption, page or file name) decide first: "desktop" never gets a
 * phone frame, "phone" does when the picture is tall. Without them, the size
 * decides: a full-page desktop shot is tall too, so tall alone is not enough.
 */
export function isPortrait(
  size: { width: number; height: number } | null | undefined,
  words?: string
): boolean {
  if (!size || size.width <= 0) return false;
  const ratio = size.height / size.width;
  if (ratio < PORTRAIT_RATIO) return false;
  const said = (words ?? '').replace(/[-_.]/g, ' ');
  if (DESK_WORDS.test(said)) return false;
  if (PHONE_WORDS.test(said)) return true;
  if (size.width <= PHONE_1X_PX) return true;
  if (size.width > PHONE_MAX_PX) return false;
  return ratio >= PHONE_SCREEN.min && ratio <= PHONE_SCREEN.max;
}
