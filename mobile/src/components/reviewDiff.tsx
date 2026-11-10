/**
 * One file of a change, for reading on a phone: its hunks with line numbers,
 * the words that changed lit inside a changed line, long unchanged stretches
 * folded to a tap, and a long press on a line to ask the agent about it.
 * Lines never re-wrap: the file's body scrolls sideways as one, so the
 * numbers and marks stay lined up with what they number.
 */

import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { type DiffRow, type Fold, type Hunk, parseDiff } from '../lib/diffModel';
import { haptic } from '../lib/haptics';
import { fonts, PRESSED, radius, space, type as typeScale, type Palette } from '../lib/theme';
import { SideScroll } from './SideScroll';
import { T } from './ui';

const MARK: Record<DiffRow['kind'], string> = { add: '+', del: '−', context: ' ' };

const inkOf = (colors: Palette, kind: DiffRow['kind']) =>
  kind === 'add' ? colors.diffAdd : kind === 'del' ? colors.diffDel : colors.textMuted;
const bandOf = (colors: Palette, kind: DiffRow['kind']) =>
  kind === 'add' ? colors.diffAddBg : kind === 'del' ? colors.diffDelBg : undefined;
const wordOf = (colors: Palette, kind: DiffRow['kind']) =>
  kind === 'add' ? colors.diffAddWord : colors.diffDelWord;

/** The number column fits the file's largest line number. */
function gutterWidth(hunks: Hunk[]): number {
  let max = 1;
  for (const h of hunks)
    for (const p of h.parts) {
      const rows = p.kind === 'fold' ? p.rows : [p];
      for (const r of rows) max = Math.max(max, r.newNo ?? 0, r.oldNo ?? 0);
    }
  return String(max).length * typeScale.caption * 0.62 + space.sm;
}

export const ReviewDiff = memo(function ReviewDiff({
  content,
  path,
  onLine,
}: {
  content: string;
  path: string;
  /** A long press on a line: ask about it. */
  onLine?: (row: DiffRow) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const hunks = useMemo(() => parseDiff(content), [content]);
  const gutter = useMemo(() => gutterWidth(hunks), [hunks]);
  const [width, setWidth] = useState(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  if (!hunks.length) {
    return (
      <T variant="small" color={colors.textSecondary} style={styles.empty}>
        Nothing to compare in this file.
      </T>
    );
  }

  const row = (r: DiffRow, key: string) => (
    <Line key={key} row={r} gutter={gutter} onLine={onLine} path={path} />
  );
  const foldView = (f: Fold, key: string) =>
    opened.has(key) ? (
      f.rows.map((r, i) => row(r, `${key}-${i}`))
    ) : (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={`Show ${f.rows.length} unchanged lines`}
        onPress={() => {
          haptic.select();
          setOpened((s) => new Set(s).add(key));
        }}
        style={({ pressed }) => [styles.fold, pressed && { opacity: 0.6 }]}
      >
        <T variant="caption" color={colors.textMuted} style={{ width: gutter + space.lg }}>
          ⋯
        </T>
        <T variant="caption" color={colors.textMuted}>
          {`${f.rows.length} unchanged lines`}
        </T>
      </Pressable>
    );

  return (
    <View style={styles.box} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <SideScroll
        testID="review-diff-scroll"
        fade={colors.surfaceApp}
        contentContainerStyle={{ flexGrow: 1 }}
      >
        <View style={[styles.inner, width > 0 && { minWidth: width }]}>
          {hunks.map((h, hi) => (
            <View key={hi}>
              {(hi > 0 || h.newStart > 1) && (
                <View style={[styles.hunk, hi === 0 && styles.hunkFirst]}>
                  <T variant="caption" color={colors.textMuted} numberOfLines={1}>
                    {h.context ? `Line ${h.newStart} · ${h.context}` : `Line ${h.newStart}`}
                  </T>
                </View>
              )}
              {h.parts.map((p, pi) =>
                p.kind === 'fold' ? foldView(p, `${hi}-${pi}`) : row(p, `${hi}-${pi}`)
              )}
            </View>
          ))}
        </View>
      </SideScroll>
    </View>
  );
});

const Line = memo(function Line({
  row,
  gutter,
  path,
  onLine,
}: {
  row: DiffRow;
  gutter: number;
  path: string;
  onLine?: (row: DiffRow) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const band = bandOf(colors, row.kind);
  const no = row.newNo ?? row.oldNo;
  const said = row.kind === 'add' ? 'Added' : row.kind === 'del' ? 'Removed' : 'Unchanged';
  return (
    <Pressable
      accessibilityRole="text"
      accessibilityLabel={`${said}, line ${no}: ${row.text.trim() || 'blank'}`}
      accessibilityHint={onLine ? 'Long press to ask about this line' : undefined}
      onLongPress={
        onLine
          ? () => {
              haptic.select();
              onLine(row);
            }
          : undefined
      }
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        band ? { backgroundColor: band } : null,
        pressed && onLine ? PRESSED : null,
      ]}
      testID={`line-${path}-${row.kind}-${no}`}
    >
      <T variant="caption" color={colors.textMuted} style={[styles.no, { width: gutter }]}>
        {String(no ?? '')}
      </T>
      <T variant="mono" color={inkOf(colors, row.kind)} style={styles.mark}>
        {MARK[row.kind]}
      </T>
      <T
        variant="mono"
        color={row.kind === 'context' ? colors.textSecondary : colors.textPrimary}
        maxFontSizeMultiplier={1.5}
        style={styles.text}
      >
        {row.spans
          ? row.spans.map((s, i) =>
              s.changed ? (
                <T
                  key={i}
                  variant="mono"
                  color={colors.textStrong}
                  style={{ backgroundColor: wordOf(colors, row.kind), fontFamily: fonts.mono }}
                >
                  {s.text}
                </T>
              ) : (
                s.text
              )
            )
          : row.text || ' '}
      </T>
    </Pressable>
  );
});

const useStyles = makeStyles((colors) => ({
  box: { backgroundColor: colors.surfaceApp, borderRadius: radius.inner, overflow: 'hidden' },
  inner: { flexGrow: 1, paddingVertical: space.xs },
  empty: { padding: space.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingRight: space.md },
  no: {
    textAlign: 'right',
    paddingLeft: space.sm,
    paddingTop: space['2xs'],
    fontVariant: ['tabular-nums'],
  },
  mark: { width: space.lg, textAlign: 'center' },
  text: {},
  hunk: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    marginTop: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
  },
  hunkFirst: { borderTopWidth: 0, marginTop: 0 },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.xs,
    paddingLeft: space.sm,
    minHeight: space['2xl'],
  },
}));
