/**
 * The review screen's reading of a unified diff: numbers from the hunk
 * headers, folds only where they save a tap's worth, words lit only where a
 * line was really edited, and the quote a long press puts in the chat.
 */

import {
  lineQuote,
  parseDiff,
  splitPath,
  wordSpans,
  type DiffRow,
  type Fold,
} from '../src/lib/diffModel';

const rowsOf = (parts: (DiffRow | Fold)[]) =>
  parts.flatMap((p) => (p.kind === 'fold' ? p.rows : [p]));

describe('parseDiff', () => {
  it('numbers lines from the hunk header and drops the file headers', () => {
    const [h] = parseDiff(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -10,3 +10,3 @@ function go()', ' a', '-b', '+c', ' d'].join(
        '\n'
      )
    );
    expect(h.context).toBe('function go()');
    expect(h.newStart).toBe(10);
    const rows = rowsOf(h.parts);
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['context', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['context', 12, 12],
    ]);
  });

  it('skips git’s no-newline note', () => {
    const [h] = parseDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b');
    expect(rowsOf(h.parts)).toHaveLength(2);
  });

  it('folds a long unchanged run, keeping three lines each side of a change', () => {
    const ctx = Array.from({ length: 20 }, (_, i) => ` line ${i}`);
    const [h] = parseDiff(['@@ -1,22 +1,22 @@', '-x', '+y', ...ctx, '-p', '+q'].join('\n'));
    const fold = h.parts.find((p) => p.kind === 'fold') as Fold;
    expect(fold.rows).toHaveLength(14);
    expect(rowsOf(h.parts)).toHaveLength(24);
  });

  it('leaves a short run alone', () => {
    const [h] = parseDiff(
      ['@@ -1,8 +1,8 @@', '-x', '+y', ' 1', ' 2', ' 3', ' 4', ' 5', '-p', '+q'].join('\n')
    );
    expect(h.parts.some((p) => p.kind === 'fold')).toBe(false);
  });

  it('lights the words that changed in an edited line', () => {
    const [h] = parseDiff('@@ -1 +1 @@\n-const size = 12;\n+const size = 16;');
    const [del, add] = rowsOf(h.parts);
    expect(del.spans?.filter((s) => s.changed).map((s) => s.text)).toEqual(['12']);
    expect(add.spans?.filter((s) => s.changed).map((s) => s.text)).toEqual(['16']);
  });
});

describe('wordSpans', () => {
  it('stays whole when the lines have little in common', () => {
    expect(wordSpans('import React from "react";', 'return <View />;')).toBeNull();
  });
});

describe('splitPath and lineQuote', () => {
  it('puts the name before its folder', () => {
    expect(splitPath('src/app/diff.tsx')).toEqual({ name: 'diff.tsx', folder: 'src/app' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', folder: '' });
  });

  it('quotes the file, the line and what it says', () => {
    expect(lineQuote('src/a.ts', { kind: 'add', text: '  x = 1', newNo: 4 })).toBe(
      'src/a.ts:4\nx = 1'
    );
    expect(lineQuote('src/a.ts', { kind: 'del', text: 'y', oldNo: 9 })).toBe(
      'src/a.ts, removed line 9\ny'
    );
  });
});
