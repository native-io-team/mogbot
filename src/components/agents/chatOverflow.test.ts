/**
 * Two narrow-window bugs the torture harness (`agents-torture` at 820px)
 * found, held here because jsdom has no layout to measure them in:
 *
 * - A reply with a code block or table filled its row, and Copy + the time
 *   beside it were pushed past the column's edge (`min-width: 0`).
 * - A wide table squeezed its columns to a letter or two, breaking words
 *   and numbers ("Northwi|nd", "€3.|10") instead of scrolling in its frame,
 *   because the bubble's `overflow-wrap: anywhere` counts toward a table's
 *   narrowest size; cells use `break-word`, which doesn't.
 */
import { describe, expect, it } from 'vitest';

// Read from disk: Vitest's default CSS handling empties a `?raw` CSS import,
// and this project's tsconfig has no Node types, hence the narrow cast.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const css = readFileSync('src/styles/features/agents-chat.css', 'utf8');

/** The declarations of every rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const all = [...css.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.map((m) => m[1]).join('\n');
}

describe('chat overflow in a narrow window', () => {
  it('an agent reply may shrink so its Copy and time stay inside the column', () => {
    expect(rule('.agent-bubble--agent')).toMatch(/min-width:\s*0/);
  });

  it('table cells never break inside a word', () => {
    expect(rule('.agent-markdown th,\n.agent-markdown td')).toMatch(/overflow-wrap:\s*break-word/);
  });
});
