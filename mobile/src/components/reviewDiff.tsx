/**
 * One file of a change, for reading on a phone: its hunks with line numbers,
 * the words that changed lit inside a changed line, long unchanged stretches
 * folded to a tap, and a long press on a line to ask the agent about it.
 * Lines never re-wrap: the file's body scrolls sideways as one, so the
 * numbers stay lined up with what they number. Dense, as Linear's Diffs: one
 * number column, a thin coloured edge for a changed line (no +/− column), the
 * code a size down, and lines that only moved their spacing shown unchanged.
 */

import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { type DiffRow, type Fold, type Hunk, parseDiff } from '@shipstudio/companion-protocol';
import { haptic } from '../lib/haptics';
import { fonts, PRESSED, radius, space, type as typeScale, type Palette } from '../lib/theme';
import { SideScroll } from './SideScroll';
import { T } from './ui';

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
  return String(max).length * typeScale.caption * 0.62 + space.md;
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
  const formatting = useMemo(() => hunks.reduce((n, h) => n + h.formatting, 0), [hunks]);

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
        <T variant="caption" color={colors.textMuted} style={{ width: gutter + space.md }}>
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
          {formatting > 0 && (
            <T variant="caption" color={colors.textMuted} style={styles.note}>
              {`${formatting} line${formatting === 1 ? '' : 's'} only re-spaced, shown as unchanged`}
            </T>
          )}
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
      {/* A changed line's thin edge in its colour: the +/− said without a column. */}
      <View
        style={[
          styles.edge,
          row.kind !== 'context' && { backgroundColor: inkOf(colors, row.kind) },
        ]}
      />
      <T
        variant="caption"
        color={row.kind === 'context' ? colors.textMuted : inkOf(colors, row.kind)}
        style={[styles.no, { width: gutter }]}
      >
        {String(no ?? '')}
      </T>
      <T
        variant="mono"
        color={row.kind === 'context' ? colors.textSecondary : colors.textPrimary}
        maxFontSizeMultiplier={1.5}
        style={styles.code}
      >
        {row.spans
          ? row.spans.map((s, i) =>
              s.changed ? (
                <T
                  key={i}
                  variant="mono"
                  color={colors.textStrong}
                  style={[styles.word, { backgroundColor: wordOf(colors, row.kind) }]}
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
    lineHeight: Math.round(typeScale.caption * 1.6),
    fontVariant: ['tabular-nums'],
  },
  word: { fontFamily: fonts.mono, fontSize: typeScale.caption },
  edge: { width: space['2xs'], alignSelf: 'stretch' },
  // A size down from the chat's code: a phone's width holds a real line.
  code: {
    fontFamily: fonts.mono,
    fontSize: typeScale.caption,
    lineHeight: Math.round(typeScale.caption * 1.6),
    paddingLeft: space.sm,
  },
  note: { paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space['2xs'] },
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
