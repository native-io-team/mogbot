/**
 * A table block: sortable by tapping a header (numbers as numbers, blanks
 * last), numeric columns right-aligned in tabular figures, the first rows
 * then "Show all". Wider than the card, it scrolls sideways in its well.
 */

import {
  formatCell,
  sortRows,
  TABLE_ROWS_SHOWN,
  type SortDir,
  type TableBlock,
} from '@shipstudio/companion-protocol';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { makeStyles, useColors } from '../../lib/appearance';
import { fonts, iconSize, PRESSED, radius, space } from '../../lib/theme';
import { ShowAll } from '../ShowAll';
import { SideScroll } from '../SideScroll';
import { Icon, T } from '../ui';

/** A column's width from what it holds: about a glyph per character, within reason. */
const GLYPH = 7.5;
const MIN_COL = 72;
const MAX_COL = 220;

export function BlockTable({ block }: { block: TableBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [open, setOpen] = useState(false);
  const rows = useMemo(
    () => (sort ? sortRows(block.rows, sort.col, sort.dir) : block.rows),
    [block.rows, sort]
  );
  const widths = useMemo(
    () =>
      block.columns.map((c, j) => {
        const longest = Math.max(
          c.label.length + 2,
          ...block.rows.map((r) => formatCell(r[j] ?? null, c).length)
        );
        return Math.max(MIN_COL, Math.min(MAX_COL, Math.round(longest * GLYPH) + space.md * 2));
      }),
    [block]
  );
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
    <View style={styles.well}>
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
                    numberOfLines={1}
                    style={{ fontFamily: fonts.semibold, flexShrink: 1 }}
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
  well: { backgroundColor: colors.surfaceApp, borderRadius: radius.inner, overflow: 'hidden' },
  row: { flexDirection: 'row' },
  head: { borderBottomWidth: 1, borderBottomColor: colors.borderDefault },
  divided: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  cell: { paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: 'center' },
  headCell: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 36 },
  numeric: { textAlign: 'right', fontVariant: ['tabular-nums'] },
}));
