/**
 * Initials for an agent or room name, for the places that still show letters
 * (a room's badge). Agents themselves are keys (`AgentKey`).
 *
 * @module lib/agentInitials
 */

/**
 * "Chief of Staff" → "CS", "Finance" → "FI", "Acme Site" → "AS". A number
 * keeps its digits ("Agent 3" → "A3", "Agent 12" → "12"), so a numbered run
 * of agents doesn't collapse onto one badge. (Rooms still use initials.)
 */
export function agentInitials(name: string): string {
  // Only letters and digits make initials: "Finance (from Grok)" is
  // "Finance", never "F(". A trailing aside in brackets is dropped.
  const words = name
    .replace(/\s*[([{].*$/u, '')
    .trim()
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

/** The first letter and the next consonant: "Client Sites QA" → "CL". */
function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/**
 * Initials that don't collide with an agent listed before this one
 * (`names`, in creation order, the Chief first): "Chief of Staff" keeps "CS"
 * and "Client Sites QA" becomes "CL". A name not in the list (one being
 * typed) gives way to all of them.
 */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const before = index === -1 ? names : names.slice(0, index);
  return before.some((n) => n !== name && agentInitials(n) === own) ? consonantInitials(name) : own;
}
