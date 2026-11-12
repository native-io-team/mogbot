/**
 * A list that holds still while you look at it.
 *
 * The Projects tab ranks cards by what's happening (waiting on you, an agent
 * at work, the latest output). Those change every few seconds while agents
 * work, and re-ranking on every change made the cards swap places over and
 * over, each swap animated: the "fighting" cards. Here the order is kept
 * between updates and only re-ranked when it matters or when asked:
 *
 * - something new is waiting on you (it must come to the top at once),
 * - the screen comes back into view or the list is pulled (`fresh`).
 *
 * Otherwise cards keep their places; a new item joins at the place the
 * ranking gives it among the others, and a gone one leaves.
 */
export function steadyOrder(
  previous: readonly string[],
  ranked: readonly string[],
  opts: { fresh?: boolean; urgent?: ReadonlySet<string>; wasUrgent?: ReadonlySet<string> } = {}
): string[] {
  const { fresh = false, urgent, wasUrgent } = opts;
  if (fresh || previous.length === 0) return [...ranked];
  if (urgent && [...urgent].some((k) => !wasUrgent?.has(k))) return [...ranked];
  const present = new Set(ranked);
  const kept = previous.filter((k) => present.has(k));
  const keptSet = new Set(kept);
  // Each newcomer goes in just before the first kept item the ranking puts after it.
  const out = [...kept];
  ranked.forEach((k, i) => {
    if (keptSet.has(k)) return;
    const after = ranked.slice(i + 1).find((x) => keptSet.has(x));
    const at = after === undefined ? out.length : out.indexOf(after);
    out.splice(at, 0, k);
    keptSet.add(k);
  });
  return out;
}
