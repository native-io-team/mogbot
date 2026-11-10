/**
 * The header's content, the messages, the bars and the composer share one
 * column: each is inset by `--agents-column-inset`, defined once on
 * `.agent-chat`. The harness measures the edges (`sameColumn` on the
 * `agents-column-*` scenarios); this holds the rule where jsdom can't lay
 * anything out, so a surface can't quietly go back to its own width.
 */
import { describe, expect, it } from 'vitest';

// Read from disk: Vitest's default CSS handling empties a `?raw` CSS import,
// and this project's tsconfig has no Node types, hence the narrow cast.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const read = (file: string) => readFileSync(`src/styles/features/${file}`, 'utf8');

/** The declarations of every rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const all = [...css.matchAll(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.map((m) => m[1]).join('\n');
}

const ON_THE_COLUMN: [file: string, selector: string][] = [
  ['agents-chat.css', '.agent-chat__header'],
  ['agents-chat.css', '.agent-chat__messages'],
  ['agents-composer.css', '.agent-composer'],
  ['agents-composer.css', '.agent-composer__notice'],
  ['agents-surfaces.css', '.agent-bars'],
  ['agents-rooms.css', '.agent-room__ask'],
  ['agents-team.css', '.agents-team__column'],
  ['usage-view.css', '.agents-usage-view__column'],
];

describe('the conversation column', () => {
  it('is defined once, from the chat width and the gutter', () => {
    const chat = rule(read('agents-chat.css'), '.agent-chat');
    expect(chat).toMatch(/--agents-column-inset:\s*max\(/);
    expect(chat).toContain('var(--agents-chat-width)');
    expect(chat).toContain('var(--agents-chat-gutter)');
  });

  it.each(ON_THE_COLUMN)('%s %s is inset by it, with no width of its own', (file, selector) => {
    const body = rule(read(file), selector);
    expect(body).toContain('var(--agents-column-inset)');
    expect(body).not.toMatch(/max-width:\s*(calc\()?var\(--agents-chat-width\)/);
  });

  it('nothing else sizes itself from the chat width', () => {
    const files = [
      'agents-chat.css',
      'agents-composer.css',
      'agents-surfaces.css',
      'agents-rooms.css',
      'agents-team.css',
      'usage-view.css',
    ];
    for (const file of files) {
      const uses = read(file).match(/var\(--agents-chat-width\)/g) ?? [];
      expect(uses.length, file).toBe(file === 'agents-chat.css' ? 1 : 0);
    }
  });
});
