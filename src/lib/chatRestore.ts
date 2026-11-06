/**
 * What a chat leaves for the next launch, per agent or room: what you were
 * typing and hadn't sent, and where you had read to. A quit, a crash or an
 * update reopens the chat with both as they were.
 *
 * In memory for the life of the window (an agent opening a project switches
 * the window away from Agents and back), and in this window's localStorage
 * for the next launch. Storage can be missing or full: everything still works
 * without it, only nothing is remembered.
 */

const DRAFTS_KEY = 'shipstudio.agents.drafts';
const PLACES_KEY = 'shipstudio.agents.readTo';
/** Kept for this many chats at most, the most recently changed. */
const MAX_KEPT = 60;
/** How soon a change reaches storage; a page hide writes it at once. */
export const SAVE_MS = 300;

/** Where a chat was read to: the line at the top of the view, and how far below the view's top edge it sat. */
export interface ReadTo {
  id: string;
  offset: number;
}

type Kept<T> = Record<string, { v: T; at: number }>;

function load<T>(key: string): Kept<T> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Kept<T>)
      : {};
  } catch {
    return {};
  }
}

function store<T>(key: string, kept: Kept<T>) {
  const newest = Object.entries(kept)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_KEPT);
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    /* a per-window convenience: storage full or off loses only this */
  }
}

/** One persisted map, read once, written a moment after it changes. */
function keeper<T>(key: string, valid: (v: unknown) => v is T) {
  let kept: Kept<T> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const all = () => (kept ??= load<T>(key));
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (kept) store(key, kept);
  };
  return {
    get(id: string): T | undefined {
      const v = all()[id]?.v;
      return valid(v) ? v : undefined;
    },
    set(id: string, v: T | undefined) {
      const map = all();
      if (v === undefined) {
        if (!(id in map)) return;
        delete map[id];
      } else {
        map[id] = { v, at: Date.now() };
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_MS);
    },
    flush,
    /** Tests: forget what was read, as a new launch would. */
    reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      kept = null;
    },
  };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isReadTo = (v: unknown): v is ReadTo =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ReadTo).id === 'string' &&
  typeof (v as ReadTo).offset === 'number' &&
  Number.isFinite((v as ReadTo).offset);

const drafts = keeper(DRAFTS_KEY, isText);
const places = keeper(PLACES_KEY, isReadTo);

/** Unsent composer text for an agent's or a room's chat (`key`), or ''. */
export function unsentDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Keep (or, empty, forget) what is typed in a chat's composer. */
export function keepDraft(key: string, text: string) {
  drafts.set(key, text ? text : undefined);
}

/** Where `key`'s chat was read to, or null: it was at the newest line. */
export function readTo(key: string): ReadTo | null {
  return places.get(key) ?? null;
}

/** Remember where `key`'s chat is read to; null when it's at the newest line. */
export function keepReadTo(key: string, at: ReadTo | null) {
  places.set(key, at ?? undefined);
}

/** Write anything waiting, now: the window is going. */
export function flushChatRestore() {
  drafts.flush();
  places.flush();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushChatRestore);
  window.addEventListener('beforeunload', flushChatRestore);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushChatRestore();
  });
}

/** Tests only: drop what was read, as a fresh launch would. */
export function resetChatRestoreForTests() {
  drafts.reset();
  places.reset();
}
