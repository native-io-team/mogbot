/**
 * Lines of a diff in mono, additions and removals tinted, never re-wrapped:
 * long lines scroll sideways, so what's shown is exactly what changes.
 */

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
  return (
    <View style={styles.box} accessibilityLabel={label}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.inner}>
          {lines.map((line, i) => {
            const t = tint[diffLineKind(line)];
            return (
              <T
                key={i}
                variant="mono"
                color={t.fg}
                selectable
                maxFontSizeMultiplier={2}
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
  box: { backgroundColor: colors.surfaceApp, borderRadius: radius.card, overflow: 'hidden' },
  inner: { paddingVertical: space.sm, minWidth: '100%' },
  line: { paddingHorizontal: space.md },
}));
