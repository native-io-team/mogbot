/**
 * A table block: sortable by tapping a header (numbers as numbers, blanks
 * last), numeric columns right-aligned in tabular figures, the first rows
 * then "Show all". Wider than the card, it scrolls sideways in its well.
 */

import {
  formatCell,
  shortColumns,
  sortRows,
  TABLE_ROWS_SHOWN,
  type SortDir,
  type TableBlock,
} from '@shipstudio/companion-protocol';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { makeStyles, useColors } from '../../lib/appearance';
import { fonts, iconSize, PRESSED, radius, space, type } from '../../lib/theme';
import { ShowAll } from '../ShowAll';
import { SideScroll } from '../SideScroll';
import { Icon, T } from '../ui';

/**
 * A glyph's average width in ems, a little over the measured, so a near miss
 * keeps its line rather than breaking; read at the text's size now, so it
 * follows Dynamic Type.
 */
const GLYPH_EM = 0.57;
const PAD = space.sm * 2;
const MIN_COL = 56;
const MAX_COL = 220;
/** A column of long text gives up width down to this, wrapping, before the table scrolls. */
const WRAP_MIN = 112;

/**
 * Column widths for a table in `available` points: what each holds, then,
 * if that's too wide, headers wrapped at their words and long text wrapped
 * down to `WRAP_MIN`; only then does the table scroll sideways. A table
 * narrower than its card stretches its long columns to fill it, so it never
 * floats in its well. Short columns (times, names, numbers) keep one line.
 */
export function fitColumns(
  table: Pick<TableBlock, 'columns' | 'rows'>,
  available: number
): number[] {
  const GLYPH = type.small * GLYPH_EM;
  const HEAD_GLYPH = type.caption * GLYPH_EM;
  const short = shortColumns(table);
  const content = table.columns.map(
    (c, j) =>
      Math.max(0, ...table.rows.map((r) => formatCell(r[j] ?? null, c).length)) * GLYPH + PAD
  );
  const clamp = (w: number, j: number) =>
    Math.round(Math.max(MIN_COL, short[j] ? w : Math.min(MAX_COL, w)));
  const natural = table.columns.map((c, j) =>
    clamp(Math.max(content[j], c.label.length * HEAD_GLYPH + PAD), j)
  );
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (!(available > 0)) return natural;
  const grow = (ws: number[]) => {
    const extra = available - sum(ws);
    if (extra <= 0) return ws;
    const wide = ws.map((_, j) => !short[j]);
    const n = wide.filter(Boolean).length;
    // Long text takes the room; a table of short columns spreads it evenly.
    return ws.map((w, j) => Math.floor(w + (n ? (wide[j] ? extra / n : 0) : extra / ws.length)));
  };
  if (sum(natural) <= available) return grow(natural);
  const word = (label: string) => Math.max(...label.split(/\s+/).map((x) => x.length));
  const tight = table.columns.map((c, j) =>
    clamp(Math.max(content[j], word(c.label) * HEAD_GLYPH + PAD), j)
  );
  const over = sum(tight) - available;
  if (over <= 0) return grow(tight);
  const give = tight.map((w, j) => (short[j] ? 0 : Math.max(0, w - WRAP_MIN)));
  const room = sum(give);
  if (room <= 0) return tight;
  const k = Math.min(1, over / room);
  return tight.map((w, j) => Math.floor(w - give[j] * k));
}

export function BlockTable({ block }: { block: TableBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => (sort ? sortRows(block.rows, sort.col, sort.dir) : block.rows),
    [block.rows, sort]
  );
  const [available, setAvailable] = useState(0);
  const widths = useMemo(() => fitColumns(block, available), [block, available]);
  const shown = open ? rows : rows.slice(0, TABLE_ROWS_SHOWN);
  const press = (col: number) => {
    const numeric = !!block.columns[col]?.numeric;
    setSort((s) =>
      s?.col === col
        ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: numeric ? 'desc' : 'asc' }
    );
  };
  return (
    <View
      style={styles.well}
      onLayout={(e) => setAvailable(Math.floor(e.nativeEvent.layout.width - space.xs * 2))}
    >
      <SideScroll fade={colors.surfaceApp} indicator={false}>
        <View>
          <View style={[styles.row, styles.head]}>
            {block.columns.map((c, j) => {
              const on = sort?.col === j;
              return (
                <Pressable
                  key={j}
                  accessibilityRole="button"
                  accessibilityLabel={`${c.label}${on ? (sort!.dir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''}. Sort`}
                  onPress={() => press(j)}
                  style={({ pressed }) => [
                    styles.cell,
                    styles.headCell,
                    { width: widths[j], justifyContent: c.numeric ? 'flex-end' : 'flex-start' },
                    pressed && PRESSED,
                  ]}
                  testID={`table-head-${j}`}
                >
                  <T
                    variant="caption"
                    color={on ? colors.textStrong : colors.textSecondary}
                    numberOfLines={2}
                    style={{
                      fontFamily: fonts.semibold,
                      flexShrink: 1,
                      textAlign: c.numeric ? 'right' : 'left',
                    }}
                  >
                    {c.label}
                  </T>
                  {on && (
                    <Icon
                      name={sort!.dir === 'asc' ? 'chevron.up' : 'chevron.down'}
                      size={iconSize.micro}
                      color={colors.textStrong}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>
          {shown.map((r, i) => (
            <View
              key={i}
              style={[styles.row, i < shown.length - 1 && styles.divided]}
              testID="table-row"
            >
              {block.columns.map((c, j) => (
                <View key={j} style={[styles.cell, { width: widths[j] }]}>
                  <T
                    variant="small"
                    color={colors.textPrimary}
                    selectable
                    style={c.numeric ? styles.numeric : undefined}
                  >
                    {formatCell(r[j] ?? null, c) || '–'}
                  </T>
                </View>
              ))}
            </View>
          ))}
        </View>
      </SideScroll>
      {rows.length > TABLE_ROWS_SHOWN && (
        <ShowAll
          open={open}
          onPress={() => setOpen((v) => !v)}
          label={`Show all ${rows.length} rows`}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  well: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.inner,
    overflow: 'hidden',
    paddingHorizontal: space.xs,
  },
  row: { flexDirection: 'row' },
  head: { borderBottomWidth: 1, borderBottomColor: colors.borderDefault },
  divided: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  cell: { paddingHorizontal: space.sm, paddingVertical: space.sm, justifyContent: 'center' },
  headCell: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 36 },
  numeric: { textAlign: 'right', fontVariant: ['tabular-nums'] },
}));
