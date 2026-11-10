/** The living page's shared rules, held to what the Mac serializes (`fixtures.gen.ts`). */
import { describe, expect, it } from 'vitest';
import { agentsPage, agentsPageNone, agentsPageVersion } from './fixtures.gen';
import {
  pageAgo,
  pageBlocks,
  pageChangeLine,
  pageTouched,
  pageKeptByLine,
  pageOlderLine,
  pageUpdatedLine,
  readPage,
  routineCanKeepPageLine,
  routineNameOf,
  routinePageLine,
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
    expect(pageUpdatedLine({ at: now - 3 * 60_000, version: 4 }, now)).toBe('Updated 3 min ago');
    expect(pageUpdatedLine({ at: now - 3 * 3_600_000, version: 1 }, now)).toBe('Made 3 h ago');
    expect(
      pageUpdatedLine({ at: now - 3 * 60_000, version: 4, byRoutine: true, routine: 'Spend' }, now)
    ).toBe('Updated 3 min ago by Spend');
    expect(pageUpdatedLine({ at: now - 60_000, version: 2, byRoutine: true }, now)).toBe(
      'Updated 1 min ago by a routine'
    );
    expect(pageOlderLine({ at: now - 4 * 86_400_000, version: 1 }, now)).toBe(
      'Version 1, as it was 4 d ago.'
    );
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

  it('names the routine that keeps it, both ways, only when the history says so', () => {
    const change = { added: [], changed: [], removed: [] };
    const page = {
      title: 'November budget',
      history: [
        { version: 3, at: 3, title: 'November budget', changes: change },
        {
          version: 2,
          at: 2,
          title: 'November budget',
          changes: change,
          byRoutine: true,
          routine: 'Log the day’s card spend',
        },
        { version: 1, at: 1, title: 'November budget', changes: change, byRoutine: true },
      ],
    };
    expect(pageKeptByLine(page)).toBe('“Log the day’s card spend” keeps this page up to date');
    expect(pageKeptByLine({ history: [page.history[2]] })).toBeNull();
    expect(routinePageLine(page, 'Log the day’s card spend')).toBe(
      'Keeps “November budget” up to date'
    );
    expect(routinePageLine(page, 'Draft my day')).toBeNull();
    expect(routinePageLine(null, 'Log the day’s card spend')).toBeNull();
    expect(routineCanKeepPageLine(page)).toBe(
      'Runs in this conversation, so it can keep “November budget” up to date'
    );
    expect(routineCanKeepPageLine(null)).toBeNull();
    // As `routine_steps::routine_name` cuts it.
    expect(routineNameOf('Short')).toBe('Short');
    expect(routineNameOf('First line\nsecond')).toBe('First line…');
    expect(routineNameOf('x'.repeat(60))).toBe('x'.repeat(48) + '…');
  });
});
