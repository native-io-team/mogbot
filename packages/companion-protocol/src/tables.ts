/**
 * Tables in chat, on the desk and the phone: which columns hold figures, so
 * they're right-aligned (with tabular figures) and their digits line up, as a
 * spreadsheet's do. One rule, so a table reads the same on both.
 *
 * A column is numeric when every body cell that isn't empty or a dash is a
 * figure: an amount, a count, a percentage, a multiple ("$5,350", "-12%",
 * "1.2k", "(40)", "3×"). The header doesn't count, and a column with no
 * figures at all isn't one. An alignment the author wrote (`:--`, `--:`)
 * always wins.
 *
 * @module companion-protocol/tables
 */

/** A figure, whole cell: sign, currency, digits with separators, a unit or percent. */
const FIGURE =
  /^[([]?\s*[-+−±~≈]?\s*[$€£¥₹]?\s*\d[\d,.  ' ]*(?:[%‰×x]|[kKmMbB]|bn|pp|pts?)?\s*[)\]]?$/;
/** Cells that say "nothing here": they don't make a column words. */
const BLANK = /^(?:|[-–—]|n\/a|N\/A|–|…)$/;

/** Whether one cell's text is a figure. */
export function isFigure(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 32 && FIGURE.test(t);
}

/**
 * Per column: whether its body is figures. `rows` are the body cells' plain
 * text, row by row; ragged rows are fine.
 */
export function numericColumns(rows: readonly (readonly string[])[], columns: number): boolean[] {
  return Array.from({ length: columns }, (_, c) => {
    let figures = 0;
    for (const row of rows) {
      const text = (row[c] ?? '').trim();
      if (BLANK.test(text)) continue;
      if (!isFigure(text)) return false;
      figures += 1;
    }
    return figures > 0;
  });
}

/**
 * The alignment each column renders with: the author's when they wrote one,
 * else right for a numeric column, else none (start).
 */
export function columnAlign(
  authored: readonly ('left' | 'right' | 'center' | null)[],
  rows: readonly (readonly string[])[]
): ('left' | 'right' | 'center' | null)[] {
  const numeric = numericColumns(rows, authored.length);
  return authored.map((a, c) => a ?? (numeric[c] ? 'right' : null));
}
