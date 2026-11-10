/**
 * Small wording rules for a result card's file and link rows
 * (components/agents/AgentResult.tsx).
 *
 * @module lib/resultItems
 */

/**
 * A row's subtitle that only says its title again: the title itself, or a
 * link's host under a title that is that link's own address
 * ("www.example.com/about" over "www.example.com"). Such a subtitle is left out.
 */
export function repeatsName(meta: string, name: string): boolean {
  if (meta === name) return true;
  // "www." is left off a row's host (`linkHost`), so it is left off here too.
  const bare = name
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .toLowerCase();
  const host = meta.replace(/^www\./i, '').toLowerCase();
  return bare === host || bare.startsWith(`${host}/`);
}
