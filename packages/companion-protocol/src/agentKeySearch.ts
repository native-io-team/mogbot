/**
 * Finding a legend by what it's for: the picker's search on the desk and the
 * phone, and the Mac's `keys::find_icon` (which resolves a word the Chief
 * passes as `icon`). The featured legends and every pack icon, searched by
 * name, tags and a few synonyms (`iconSynonyms` in agent-keys.json), so
 * "money", "invoice", "house" or "calendar" each find good keys.
 *
 * The scoring is mirrored in `src-tauri/src/agents/keys.rs`; the `find`
 * cases in agent-key-cases.json hold both to the same best match.
 */

import data from './agent-keys.json';
import { ICON_RULES, KEY_ICONS } from './agentKeys';
import { PACK_PREFIX, loadPackIndex, packIconName, type PackIndex } from './agentKeyPack';

export interface IconEntry {
  id: string;
  /** What the picker calls it. */
  name: string;
  featured: boolean;
  /** Category ids (`featured` for ours). */
  categories: string[];
  /** Stemmed words of its name. */
  nameWords: string[];
  /** Stemmed words of its tags. */
  tagWords: string[];
}

export interface IconCatalog {
  entries: IconEntry[];
  /** The pack's categories, `featured` first: the quick filters. */
  categories: { id: string; title: string }[];
}

export const FEATURED_CATEGORY = 'featured';

/** "Invoices" → "invoice"; "batteries" → "battery". The Mac's `stem`. */
export function iconStem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const stem = iconStem;

/** A word's synonyms, both sides stemmed. */
const SYNONYMS: Record<string, string[]> = Object.fromEntries(
  Object.entries(data.iconSynonyms as Record<string, string[]>).map(([k, v]) => [
    stem(k),
    v.map(stem),
  ])
);

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

const unique = (xs: string[]) => [...new Set(xs)];

/** The featured legends as entries: their names and ids, and the words that pick them for a name. */
export function featuredEntries(): IconEntry[] {
  return KEY_ICONS.map((i) => ({
    id: i.id,
    name: i.name,
    featured: true,
    categories: [FEATURED_CATEGORY],
    nameWords: unique([...wordsOf(i.name), ...wordsOf(i.id)]),
    tagWords: unique(ICON_RULES.filter((r) => r.icon === i.id).flatMap((r) => r.words.map(stem))),
  }));
}

/** Everything the picker can offer, from the pack's index. */
export function buildCatalog(index: PackIndex): IconCatalog {
  const pack = index.icons.map(([name, tags, cats]) => ({
    id: PACK_PREFIX + name,
    name: packIconName(PACK_PREFIX + name),
    featured: false,
    categories: cats.map((c) => index.categories[c][0]),
    nameWords: wordsOf(name),
    tagWords: unique(tags ? tags.split(',').flatMap(wordsOf) : []),
  }));
  return {
    entries: [...featuredEntries(), ...pack],
    categories: [
      { id: FEATURED_CATEGORY, title: 'Featured' },
      ...index.categories.map(([id, title]) => ({ id, title })),
    ],
  };
}

let catalogPromise: Promise<IconCatalog> | null = null;

/** The catalog, built once the pack's index has loaded. */
export function loadIconCatalog(): Promise<IconCatalog> {
  catalogPromise ??= loadPackIndex().then(buildCatalog, (e: unknown) => {
    catalogPromise = null;
    throw e;
  });
  return catalogPromise;
}

/** Whether two words are one typo apart (a letter added, dropped, changed or two swapped). */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));
    if (diff.length === 2 && diff[1] === diff[0] + 1) {
      return a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
    }
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well one word matches an entry: 0 for not at all. */
function wordScore(e: IconEntry, t: string): number {
  if (e.nameWords.includes(t)) return 100;
  if (t.length >= 2 && e.nameWords.some((w) => w.startsWith(t))) return 60;
  if (e.tagWords.includes(t)) return 50;
  if (t.length >= 3 && e.tagWords.some((w) => w.startsWith(t))) return 30;
  if (t.length >= 4 && [...e.nameWords, ...e.tagWords].some((w) => w.length >= 4 && oneEdit(w, t)))
    return 20;
  return 0;
}

/** A typed word's score: itself, or (at seven tenths) the best of its synonyms. */
function tokenScore(e: IconEntry, t: string): number {
  let best = wordScore(e, t) * 10;
  for (const s of SYNONYMS[t] ?? []) best = Math.max(best, wordScore(e, s) * 7);
  return best;
}

/**
 * An entry's score for a query: every word must match something; featured
 * legends and simpler names (fewer words) come first among equals.
 */
export function scoreIcon(e: IconEntry, query: string): number {
  const tokens = wordsOf(query);
  if (!tokens.length) return 0;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(e, t);
    if (!s) return 0;
    total += s;
  }
  return total + (e.featured ? 150 : 0) - e.nameWords.length * 10;
}

/**
 * The icons for a query, best first; with no words, every icon (featured
 * first). `category` narrows either to one quick filter.
 */
export function searchIcons(
  catalog: IconCatalog,
  query: string,
  category?: string | null
): IconEntry[] {
  const pool = category
    ? catalog.entries.filter((e) => e.categories.includes(category))
    : catalog.entries;
  if (!wordsOf(query).length) return pool;
  return (
    pool
      .map((e) => [e, scoreIcon(e, query)] as const)
      .filter(([, s]) => s > 0)
      // Ties by id, code unit by code unit, as the Mac sorts them.
      .sort((a, b) => b[1] - a[1] || (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0))
      .map(([e]) => e)
  );
}
