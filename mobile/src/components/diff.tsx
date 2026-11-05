/**
 * Lines of a diff in mono, additions and removals tinted, never re-wrapped:
 * long lines scroll sideways, so what's shown is exactly what changes.
 */

import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { diffLineKind, type DiffLineKind } from '../lib/diff';
import { radius, space, type Palette } from '../lib/theme';
import { T } from './ui';

/** A line's ink and band, from the palette's own diff roles (tuned per appearance). */
const tintOf = (colors: Palette): Record<DiffLineKind, { fg: string; bg?: string }> => ({
  add: { fg: colors.diffAdd, bg: colors.diffAddBg },
  del: { fg: colors.diffDel, bg: colors.diffDelBg },
  hunk: { fg: colors.textMuted },
  context: { fg: colors.textPrimary },
});

export function DiffLines({ lines, label }: { lines: string[]; label?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const tint = tintOf(colors);
  // The bands span the box, not just the longest line: the scroll content is
  // as wide as its lines, so the box's own width (in points) is the floor.
  const [width, setWidth] = useState(0);
  return (
    <View
      style={styles.box}
      accessibilityLabel={label}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {/* The indicator shows, so a line running off the edge reads as one to scroll. */}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.content}>
        <View style={[styles.inner, width > 0 && { minWidth: width }]}>
          {lines.map((line, i) => {
            const t = tint[diffLineKind(line)];
            return (
              <T
                key={i}
                variant="mono"
                color={t.fg}
                selectable
                maxFontSizeMultiplier={1.5}
                style={[styles.line, t.bg ? { backgroundColor: t.bg } : null]}
              >
                {line || ' '}
              </T>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  box: { backgroundColor: colors.surfaceApp, borderRadius: radius.inner, overflow: 'hidden' },
  content: { flexGrow: 1 },
  inner: { flexGrow: 1, paddingVertical: space.sm },
  line: { paddingHorizontal: space.md },
}));
