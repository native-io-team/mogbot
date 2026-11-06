/**
 * Structural sharing for what the Mac sends whole.
 *
 * `agents.registry` (and a snapshot, and a pull-to-refresh) carries the entire
 * overview, and it arrives on every message an agent says. Parsed fresh, every
 * agent in it is a new object, so every memoised row on the Agents list
 * re-rendered (each with its swipe and native menu) for a change to one agent.
 * Sharing keeps the previous object wherever the new one is equal to it, so a
 * memo on `agent` holds for the agents that didn't change.
 */

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const idOf = (v: Json): string | null => (isObject(v) && typeof v.id === 'string' ? v.id : null);

/** `next`, with every part that equals the same part of `prev` replaced by `prev`'s own. */
export function shareStructure<T>(prev: Json, next: T): T {
  if (prev === next) return next;
  if (Array.isArray(next) && Array.isArray(prev)) {
    // Rows move when the list is re-sorted: match by id when they have one.
    const ids = next.map(idOf);
    const byId =
      ids.every((id) => id !== null) && prev.every((p) => idOf(p) !== null)
        ? new Map(prev.map((p) => [idOf(p), p]))
        : null;
    const out = next.map((n, i) => shareStructure(byId ? byId.get(ids[i]) : prev[i], n));
    return (out.length === prev.length && out.every((o, i) => o === prev[i]) ? prev : out) as T;
  }
  if (isObject(next) && isObject(prev)) {
    const keys = Object.keys(next);
    const out: Record<string, Json> = {};
    let same = keys.length === Object.keys(prev).length;
    for (const k of keys) {
      out[k] = shareStructure(prev[k], next[k]);
      if (out[k] !== prev[k]) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
