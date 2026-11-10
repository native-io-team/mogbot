/**
 * The icon pack agent keys can wear beyond the featured legends
 * (docs/internal/agent-keys.md, "The icon pack"): Lucide, vendored as data
 * in `agent-key-pack/` by `scripts/agent-key-pack.mjs` (ISC; its licence is
 * beside the data). An id is `lucide:` and the icon's name (`lucide:wallet`).
 *
 * Nothing here is read at startup. A key wearing a pack icon loads the one
 * drawings file its icon is in (by first letter, `agentKeyPackShards.ts`);
 * the picker loads the search index and every drawing when it opens. A
 * client re-draws when a file arrives (`subscribePackDrawings`).
 */

import { PACK_INDEX, PACK_SHARDS } from './agentKeyPackShards';
import type { KeyIconDrawing } from './agentKeyIcons';
import data from './agent-keys.json';

export const PACK_PREFIX: string = data.pack.prefix;
/** What the pack is called, its version and how many icons it has (the Mac checks the count). */
export const PACK_INFO = data.pack;

const ID = /^lucide:[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Whether this is shaped like a pack id. Which ids exist is the index's
 * (and the Mac's, which refuses any other); a client given one that isn't
 * there draws the default legend.
 */
export const isPackIconId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** `lucide:badge-dollar-sign` → "Badge dollar sign". */
export function packIconName(id: string): string {
  const words = id.slice(PACK_PREFIX.length).split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The search index as stored: `[name, "tag,tag", [category indexes]]`. */
export interface PackIndex {
  pack: string;
  version: string;
  categories: [string, string][];
  icons: [string, string, number[]][];
}

let indexPromise: Promise<PackIndex> | null = null;

/** The pack's names, tags and categories (the picker's search), loaded once. */
export function loadPackIndex(): Promise<PackIndex> {
  indexPromise ??= PACK_INDEX().then(
    (m: unknown) => {
      const mod = m as { default?: PackIndex };
      return mod.default ?? (m as PackIndex);
    },
    (e: unknown) => {
      // A failed load is tried again next time.
      indexPromise = null;
      throw e;
    }
  );
  return indexPromise;
}

/** Drawings by pack id; `null` for an id its file doesn't have. */
const drawings = new Map<string, KeyIconDrawing | null>();
const shardsLoaded = new Set<string>();
const shardsLoading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const l of listeners) l();
}

/** Called whenever a drawings file arrives. */
export function subscribePackDrawings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bumps each time a drawings file arrives: a `useSyncExternalStore` snapshot. */
export const packDrawingsVersion = () => version;

function shardOf(id: string): string {
  return id.charAt(PACK_PREFIX.length);
}

/** Loads the drawings file an icon is in (once; a failed load can be tried again). */
export function loadPackShard(shard: string): Promise<void> {
  if (shardsLoaded.has(shard)) return Promise.resolve();
  const pending = shardsLoading.get(shard);
  if (pending) return pending;
  const load = PACK_SHARDS[shard];
  if (!load) {
    shardsLoaded.add(shard);
    return Promise.resolve();
  }
  const p = load()
    .then((m) => {
      const mod = m as { default?: Record<string, KeyIconDrawing> };
      const map = mod.default ?? (m as Record<string, KeyIconDrawing>);
      for (const [name, d] of Object.entries(map)) {
        drawings.set(PACK_PREFIX + name, { ...d, round: true });
      }
      shardsLoaded.add(shard);
      changed();
    })
    .finally(() => shardsLoading.delete(shard));
  shardsLoading.set(shard, p);
  return p;
}

/** Every drawing: the picker, which shows them all. */
export function loadAllPackDrawings(): Promise<void> {
  return Promise.all(Object.keys(PACK_SHARDS).map(loadPackShard)).then(() => undefined);
}

/**
 * A pack icon's drawing: the drawing, `null` when the pack has no such
 * icon, or `undefined` while its file is loading (which this starts).
 */
export function packDrawing(id: string): KeyIconDrawing | null | undefined {
  const d = drawings.get(id);
  if (d !== undefined) return d;
  const shard = shardOf(id);
  if (shardsLoaded.has(shard)) return null;
  loadPackShard(shard).catch(() => undefined);
  return undefined;
}
