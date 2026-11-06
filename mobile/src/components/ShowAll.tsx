/**
 * "Show all" under a capped detail (a command, a connector's fields, a diff),
 * and "Show less" once it's open: a card's answers stay under the thumb, and
 * the whole of what it asks is one tap away, never silently cut.
 */

import { Pressable } from 'react-native';
import { makeStyles, useColors } from '../lib/appearance';
import { fonts, PRESSED, space } from '../lib/theme';
import { T } from './ui';

export function ShowAll({
  open,
  onPress,
  label,
}: {
  open: boolean;
  onPress: () => void;
  /** What the closed control says ("Show all 40 lines"); "Show all" when absent. */
  label?: string;
}) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      hitSlop={{ top: 12, bottom: 12 }}
      style={({ pressed }) => [styles.showAll, pressed && PRESSED]}
    >
      <T variant="caption" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
        {open ? 'Show less' : (label ?? 'Show all')}
      </T>
    </Pressable>
  );
}

const useStyles = makeStyles(() => ({
  showAll: { paddingHorizontal: space.md, paddingBottom: space.sm },
}));
