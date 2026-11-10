/**
 * Relative times for list rows and chat lines.
 *
 * @module lib/formatAgo
 */

/** Compact relative time for list rows, e.g. "12m", "3h", "2d". */
export function formatAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * Past-tense age for a timestamp: "just now", "18m ago", "2d ago".
 *
 * Callers must not append " ago" to `formatAge` themselves — the sub-minute
 * case reads "now", and "now ago" is not a thing.
 */
export function formatAgo(timestamp: number, now = Date.now()): string {
  const age = formatAge(timestamp, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}
