/**
 * Small choosers for the sheets that start things: chips (one or several of
 * a few words) and the agent colour swatches. Each is a 44pt target whatever
 * it draws, and reads its colours from the palette in force.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { agentTint } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { AGENT_COLORS } from '../lib/newAgent';
import { chromeScale, iconSize, radius, space } from '../lib/theme';
import { Icon, T, tap, useRipple } from './ui';

/** Chips fit 36pt; their slop makes the target 44. */
const CHIP = 36;
const SLOP = (44 - CHIP) / 2;

export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
  role = 'radio',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /** `checkbox` when several may be on (the days of a weekly routine). */
  role?: 'radio' | 'checkbox';
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === 'radio' ? { selected } : { checked: selected }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => {
        tap();
        onPress();
      }}
      hitSlop={SLOP}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.chip,
        selected ? styles.chipOn : pressed && styles.chipPressed,
      ]}
    >
      <T
        variant="small"
        color={selected ? colors.textStrong : colors.textSecondary}
        maxFontSizeMultiplier={chromeScale}
        numberOfLines={1}
      >
        {label}
      </T>
    </Pressable>
  );
}

/** A wrapping row of chips, spaced so their 44pt targets don't overlap. */
export function ChipRow({ children, label }: { children: ReactNode; label?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {children}
    </View>
  );
}

/** Every agent colour as the app draws it in this appearance; white is the neutral accent. */
export function ColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Colour">
      {AGENT_COLORS.map((color) => {
        const on = color === value;
        const tint = agentTint(color, appearance);
        return (
          <Pressable
            key={color}
            accessibilityRole="radio"
            accessibilityLabel={color}
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) tap();
              onChange(color);
            }}
            style={styles.swatchTarget}
          >
            <View style={[styles.ring, on && { borderColor: colors.textStrong }]}>
              <View style={[styles.swatch, { backgroundColor: tint }]}>
                {on && (
                  <Animated.View entering={FadeIn.duration(120)}>
                    <Icon
                      name="checkmark"
                      size={iconSize.inline}
                      color={color === 'white' ? colors.surfaceApp : colors.inkLight}
                    />
                  </Animated.View>
                )}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const SWATCH = 28;
const RING = SWATCH + 8;

const useStyles = makeStyles((colors) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: CHIP,
    paddingHorizontal: space.md + 2,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  chipOn: { backgroundColor: colors.surfaceSelected, borderColor: colors.borderStrong },
  chipPressed: { backgroundColor: colors.surfaceControlHover },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space['2xs'] },
  swatchTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    width: SWATCH,
    height: SWATCH,
    borderRadius: SWATCH / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
