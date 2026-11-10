/**
 * A conversation's living page (`page`, `src-tauri/src/agents/page.rs`):
 * one page pinned above the chat that the agent, and the routines that run
 * in that conversation, keep up to date. Its content is a block set
 * (`blocks.ts`), each block with the `id` the agent patches it by, so the
 * desk and the phone draw it with the blocks they already have. Nothing on
 * a page answers (no choices, comparison or form).
 *
 * Every update that changes something is a new version; the Mac keeps the
 * ones before with what changed, and a client can read any kept version.
 * The user can unpin it; the agent keeps it current either way.
 */

import { readBlocks, type BlockSet } from './blocks';

/** What changed from the version before, by block id. */
export interface PageChanges {
  added: string[];
  changed: string[];
  removed: string[];
  retitled?: boolean;
}

/** One version, as `agents.pageVersion` returns it. */
export interface PageVersion {
  version: number;
  /** When it was made, ms. */
  at: number;
  title: string;
  /** A block set, as `readBlocks` takes it; each item carries an `id`. */
  blocks: unknown;
  /** The agent's one line on what changed. */
  note?: string;
  changes: PageChanges;
  /** Made by a routine's run. */
  byRoutine?: boolean;
  /** That routine's name, when the run was one routine's (`page::Update::routine`). */
  routine?: string;
}

/** One line of the history: no blocks. */
export interface PageHistoryEntry {
  version: number;
  at: number;
  title: string;
  note?: string;
  changes: PageChanges;
  byRoutine?: boolean;
  routine?: string;
}

/** `agents.page`: the page as it is (the current version's fields) and its history. */
export interface ConversationPage extends PageVersion {
  agentId: string;
  conversation: string;
  pinned: boolean;
  /** Every kept version, newest first, the current one included. */
  history: PageHistoryEntry[];
}

/**
 * Who made a version, for its history line: "by Evening budget check" when
 * a routine's run did and it is known which, "by a routine" when not, and
 * nothing for a turn the user started.
 */
export function pageByLine(entry: Pick<PageHistoryEntry, 'byRoutine' | 'routine'>): string | null {
  if (!entry.byRoutine) return null;
  return entry.routine ? `by ${entry.routine}` : 'by a routine';
}

/** The page's blocks, if this build can draw any of them. */
export function pageBlocks(version: Pick<PageVersion, 'blocks'>): BlockSet | null {
  return readBlocks({ blocks: version.blocks } as Parameters<typeof readBlocks>[0]);
}

/** "just now", "3 min ago", "2 h ago", "4 d ago". */
export function pageAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * The page bar's line: "Updated 3 min ago by Log the day’s card spend" when
 * the newest version was a routine's, else "Updated 3 min ago" ("Made …" for
 * the first version). The version number belongs to the history only.
 */
export function pageUpdatedLine(
  page: Pick<PageVersion, 'at' | 'version' | 'byRoutine' | 'routine'>,
  now: number
): string {
  const verb = page.version <= 1 ? 'Made' : 'Updated';
  const by = pageByLine(page);
  return `${verb} ${pageAgo(page.at, now)}${by ? ` ${by}` : ''}`;
}

/** A version's plain name in the history: "Version 4". */
export function pageVersionName(version: number): string {
  return `Version ${version}`;
}

/** Over an older version: "Version 1, as it was 4 d ago." */
export function pageOlderLine(older: Pick<PageVersion, 'at' | 'version'>, now: number): string {
  return `${pageVersionName(older.version)}, as it was ${pageAgo(older.at, now)}.`;
}

/** The way back from an older version to the page as it is. */
export const PAGE_BACK_TO_LATEST = 'Back to the latest';

/**
 * The routine that keeps the page current, as its history names it: the
 * newest version made by a named routine. Null when no routine has changed
 * it, or none known by name.
 */
export function pageRoutine(page: Pick<ConversationPage, 'history'>): string | null {
  return page.history.find((h) => h.byRoutine && h.routine)?.routine ?? null;
}

/** "“Log the day’s card spend” keeps this page up to date", over the history. */
export function pageKeptByLine(page: Pick<ConversationPage, 'history'>): string | null {
  const routine = pageRoutine(page);
  return routine ? `“${routine}” keeps this page up to date` : null;
}

/**
 * A routine's name as the Mac records it on a page's history
 * (`routine_steps::routine_name`): its note's first line, cut at 48
 * characters, with "…" when anything was left off.
 */
export function routineNameOf(note: string): string {
  const first = (note.split('\n')[0] ?? '').trim();
  let name = Array.from(first).slice(0, 48).join('');
  if (Array.from(name).length < Array.from(note.trim()).length) name = name.trimEnd() + '…';
  return name;
}

/**
 * Under a routine's row: "Keeps “November budget” up to date" when the page
 * of the conversation it runs in was changed by it (its history says so).
 * Nothing is claimed for a routine that hasn't touched the page.
 */
export function routinePageLine(
  page: Pick<ConversationPage, 'title' | 'history'> | null | undefined,
  routineNote: string
): string | null {
  if (!page) return null;
  const name = routineNameOf(routineNote);
  if (!name) return null;
  return page.history.some((h) => h.byRoutine && h.routine === name)
    ? `Keeps “${page.title}” up to date`
    : null;
}

/**
 * Over a new routine (or one being changed) in a conversation with a page:
 * it runs there, so it can keep the page current.
 */
export function routineCanKeepPageLine(
  page: Pick<ConversationPage, 'title'> | null | undefined
): string | null {
  return page ? `Runs in this conversation, so it can keep “${page.title}” up to date` : null;
}

/** The title a block id stands for on a version, else the id itself. */
function nameOf(id: string, blocks: unknown): string {
  const set = isObject(blocks) && Array.isArray(blocks.items) ? blocks.items : [];
  const block = set.find((b) => isObject(b) && b.id === id);
  if (isObject(block) && typeof block.title === 'string' && block.title.trim()) {
    return block.title.trim();
  }
  return id.replace(/[-_]+/g, ' ');
}

/**
 * What changed, in words: "Added Budget · Changed This week · Removed Old".
 * Titles come from the version the block is on (the removed ones from the
 * version before, when given).
 */
export function pageChangeLine(changes: PageChanges, blocks: unknown, before?: unknown): string {
  const parts: string[] = [];
  const names = (ids: string[], on: unknown) => ids.map((id) => nameOf(id, on)).join(', ');
  if (changes.added.length) parts.push(`Added ${names(changes.added, blocks)}`);
  if (changes.changed.length) parts.push(`Changed ${names(changes.changed, blocks)}`);
  if (changes.removed.length) parts.push(`Removed ${names(changes.removed, before ?? blocks)}`);
  if (changes.retitled) parts.push('Renamed');
  return parts.join(' · ');
}

/** The ids a version changed or added: what the page marks as new. */
export function pageTouched(changes: PageChanges): Set<string> {
  return new Set([...changes.added, ...changes.changed]);
}

/** A `ConversationPage` from the wire, or null when it isn't one this build reads. */
export function readPage(raw: unknown): ConversationPage | null {
  if (!isObject(raw)) return null;
  if (
    typeof raw.agentId !== 'string' ||
    typeof raw.conversation !== 'string' ||
    typeof raw.version !== 'number' ||
    typeof raw.at !== 'number' ||
    typeof raw.title !== 'string' ||
    typeof raw.pinned !== 'boolean' ||
    !Array.isArray(raw.history)
  ) {
    return null;
  }
  if (!pageBlocks(raw as unknown as PageVersion)) return null;
  return raw as unknown as ConversationPage;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
