/** The living page's shared rules, held to what the Mac serializes (`fixtures.gen.ts`). */
import { describe, expect, it } from 'vitest';
import { agentsPage, agentsPageNone, agentsPageVersion } from './fixtures.gen';
import {
  pageAgo,
  pageBlocks,
  pageChangeLine,
  pageTouched,
  pageUpdatedLine,
  readPage,
} from './page';

describe('living page', () => {
  it('reads what the Mac sends, and draws its blocks', () => {
    const page = readPage(agentsPage);
    expect(page?.version).toBe(2);
    expect(page?.history.map((h) => h.version)).toEqual([2, 1]);
    const set = pageBlocks(page!);
    expect(set?.items.map((b) => b.kind)).toEqual(['metrics', 'checklist', 'links']);
    expect(readPage(agentsPageNone)).toBeNull();
    expect(pageBlocks(agentsPageVersion!)?.items).toHaveLength(2);
    expect(readPage({ ...agentsPage, blocks: { v: 99, items: [] } })).toBeNull();
  });

  it('says when it changed and what, in words', () => {
    const now = 1_762_290_000_000;
    expect(pageAgo(now - 20_000, now)).toBe('just now');
    expect(pageUpdatedLine({ at: now - 3 * 60_000, version: 4 }, now)).toBe(
      'Updated 3 min ago · v4'
    );
    expect(pageUpdatedLine({ at: now - 3 * 3_600_000, version: 1 }, now)).toBe('Made 3 h ago · v1');
    expect(pageAgo(now - 3 * 86_400_000, now)).toBe('3 d ago');
    const page = readPage(agentsPage)!;
    expect(pageChangeLine(page.changes, page.blocks, agentsPageVersion!.blocks)).toBe(
      'Added links · Changed This week'
    );
    expect(
      pageChangeLine({ added: [], changed: [], removed: [], retitled: true }, page.blocks)
    ).toBe('Renamed');
    expect([...pageTouched(page.changes)]).toEqual(['links', 'tasks']);
  });
});
