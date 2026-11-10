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
}

/** One line of the history: no blocks. */
export interface PageHistoryEntry {
  version: number;
  at: number;
  title: string;
  note?: string;
  changes: PageChanges;
  byRoutine?: boolean;
}

/** `agents.page`: the page as it is (the current version's fields) and its history. */
export interface ConversationPage extends PageVersion {
  agentId: string;
  conversation: string;
  pinned: boolean;
  /** Every kept version, newest first, the current one included. */
  history: PageHistoryEntry[];
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

/** "Updated 3 min ago · v4" (or "Made 3 min ago" for the first version). */
export function pageUpdatedLine(page: Pick<PageVersion, 'at' | 'version'>, now: number): string {
  const verb = page.version <= 1 ? 'Made' : 'Updated';
  return `${verb} ${pageAgo(page.at, now)} · v${page.version}`;
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
