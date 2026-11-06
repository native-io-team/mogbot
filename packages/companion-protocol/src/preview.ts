/**
 * An agent's preview as a list row shows it, on the desk and the phone: plain
 * words, never the reply's markdown. "**Post 1 of 6 · Fri Nov 6, 10am**" over
 * "LINKEDIN:" over the post itself reads as the post's first sentence.
 *
 * - Markdown markers go: headings, list and quote marks, emphasis, code
 *   ticks, links (their words stay), tables' rules.
 * - A line that is only a heading, only bold, or a label ending in ":" is
 *   skipped when anything after it says more.
 * - The first meaningful line is cut to its first sentence when another
 *   follows it, so the row says one thing.
 */

/** Markdown markers out of one line, its words kept. */
export function plainLine(line: string): string {
  let s = line.trim();
  s = s.replace(/^#{1,6}\s+/, ''); // heading
  s = s.replace(/^(?:>\s*)+/, ''); // quote
  s = s.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''); // list item, task box
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // image → its alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // link → its words
  s = s.replace(/`+([^`]*)`+/g, '$1'); // code
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'); // bold
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2'); // *italic*
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2'); // _italic_
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1'); // strikethrough
  s = s.replace(/\*\*|__/g, ''); // an unclosed pair the cut left behind
  if (/^\|.*\|$/.test(s)) s = s.slice(1, -1).split('|').map((c) => c.trim()).join(' · ');
  return s.replace(/\s+/g, ' ').trim();
}

/** A heading, a bold line or a label: says what follows, not what happened. */
function isLabel(raw: string, plain: string): boolean {
  const t = raw.trim();
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(\*\*|__)[^*_]+\1:?$/.test(t)) return true;
  return /:$/.test(plain);
}

/** A rule, a table's separator row, or nothing at all. */
function isEmpty(raw: string): boolean {
  return /^\s*(?:[-*_]\s*){3,}$/.test(raw) || /^\s*\|?[\s:|-]+\|?\s*$/.test(raw) || !raw.trim();
}

/** Up to the end of its first sentence, when another follows it. */
export function firstSentence(text: string): string {
  const end = /[.!?](?=\s+["“(]?[A-Z0-9])/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

/** The row's words for an agent's preview; null when there are none. */
export function previewText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).filter((l) => !isEmpty(l));
  if (lines.length === 0) return null;
  const plain = lines.map(plainLine);
  const said = plain.findIndex((p, i) => p && !isLabel(lines[i], p));
  const line = said >= 0 ? plain[said] : plain.find(Boolean)?.replace(/:$/, '');
  if (!line) return null;
  return firstSentence(line);
}
