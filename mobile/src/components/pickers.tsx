/**
 * Small choosers for the sheets that start things: chips (one or several of
 * a few words), the agent colour swatches and its key's choices. Each is a 44pt target whatever
 * it draws, and reads its colours from the palette in force.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { agentTint } from '../lib/accent';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { AGENT_COLORS } from '../lib/newAgent';
import {
  agentColorNames,
  chromeScale,
  fonts,
  iconSize,
  keySize,
  radius,
  space,
} from '../lib/theme';
import { Button, Icon, T, tap, useRipple } from './ui';
import { AgentKey } from './AgentKey';
import {
  COLORWAYS,
  KEY_CHARS,
  KEY_ICONS,
  PACK_INFO,
  iconName,
} from '@shipstudio/companion-protocol';
import { KeyIconSheet } from './KeyIconSheet';

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
        color={selected ? colors.onSelectedFill : colors.textSecondary}
        style={selected ? { fontFamily: fonts.medium } : undefined}
        maxFontSizeMultiplier={chromeScale}
        numberOfLines={1}
      >
        {label}
      </T>
    </Pressable>
  );
}

/**
 * A wrapping row of chips, spaced so their 44pt targets don't overlap. A
 * radio group, unless its chips are checkboxes (several may be on): then
 * just a labelled group.
 */
export function ChipRow({
  children,
  label,
  multiple = false,
}: {
  children: ReactNode;
  label?: string;
  multiple?: boolean;
}) {
  const styles = useStyles();
  return (
    <View
      style={styles.row}
      accessible={multiple ? false : undefined}
      accessibilityRole={multiple ? undefined : 'radiogroup'}
      accessibilityLabel={label}
    >
      {children}
    </View>
  );
}

/** What VoiceOver calls a swatch (`agentColorNames`): what it looks like, never its key. */
export const colorName = (key: string) =>
  agentColorNames[key] ?? key.charAt(0).toUpperCase() + key.slice(1);

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
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Color">
      {AGENT_COLORS.map((color) => {
        const on = color === value;
        const tint = agentTint(color, appearance);
        return (
          <Pressable
            key={color}
            accessibilityRole="radio"
            accessibilityLabel={colorName(color)}
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

/**
 * How an agent looks: its key's colourway, its legend and the keyboard key
 * it's bound to (docs/design/agent-keys.md), the desk's `AgentKeyPicker`
 * for a thumb. Each colour and legend is drawn as the key it would make; the
 * bound key is picked from the letters and digits nobody else has.
 */
export function KeyChoices({
  name,
  colorway,
  icon,
  boundKey,
  taken,
  onColorway,
  onIcon,
  onBoundKey,
}: {
  name: string;
  colorway: string;
  icon: string;
  boundKey: string | null;
  /** Keys the rest of the team is bound to: not offered. */
  taken: readonly string[];
  onColorway: (colorway: string) => void;
  onIcon: (icon: string) => void;
  onBoundKey: (key: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const free = [...KEY_CHARS].filter((k) => k === boundKey || !taken.includes(k));
  const [searching, setSearching] = useState(false);
  const featured = KEY_ICONS.some((i) => i.id === icon);
  return (
    <View style={styles.look}>
      <T variant="caption" color={colors.textSecondary}>
        Colour
      </T>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Colour">
        {COLORWAYS.map((c) => (
          <LookChoice
            key={c.id}
            label={c.name}
            on={c.id === colorway}
            onPress={() => onColorway(c.id)}
          >
            <AgentKey
              name={name}
              colorway={c.id}
              icon={icon}
              size={keySize.md}
              pressed={c.id === colorway}
            />
          </LookChoice>
        ))}
      </View>
      <T variant="caption" color={colors.textSecondary}>
        Icon
      </T>
      <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Icon">
        {/* One from the pack leads the row, so the pick is always in sight. */}
        {!featured && (
          <LookChoice label={iconName(icon)} on onPress={() => setSearching(true)}>
            <AgentKey name={name} colorway={colorway} icon={icon} size={keySize.md} pressed />
          </LookChoice>
        )}
        {KEY_ICONS.map((i) => (
          <LookChoice key={i.id} label={i.name} on={i.id === icon} onPress={() => onIcon(i.id)}>
            <AgentKey
              name={name}
              colorway={colorway}
              icon={i.id}
              size={keySize.md}
              pressed={i.id === icon}
            />
          </LookChoice>
        ))}
      </View>
      <Button
        title={`Search ${PACK_INFO.count.toLocaleString('en')} more icons`}
        icon="magnifyingglass"
        variant="secondary"
        size="compact"
        onPress={() => setSearching(true)}
        style={styles.more}
      />
      <KeyIconSheet
        visible={searching}
        name={name}
        colorway={colorway}
        icon={icon}
        boundKey={boundKey}
        onPick={onIcon}
        onClose={() => setSearching(false)}
      />
      <T variant="caption" color={colors.textSecondary}>
        Key
      </T>
      <View
        style={styles.swatches}
        accessibilityRole="radiogroup"
        accessibilityLabel="Keyboard key"
      >
        {free.map((k) => (
          <LookChoice key={k} label={`Key ${k}`} on={k === boundKey} onPress={() => onBoundKey(k)}>
            <T
              variant="subhead"
              color={k === boundKey ? colors.textStrong : colors.textSecondary}
              style={{ fontFamily: fonts.mono }}
              maxFontSizeMultiplier={chromeScale}
            >
              {k}
            </T>
          </LookChoice>
        ))}
      </View>
    </View>
  );
}

function LookChoice({
  label,
  on,
  onPress,
  children,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={() => {
        if (!on) tap();
        onPress();
      }}
      style={styles.swatchTarget}
    >
      {/* The pick is told as a keyboard tells it: the key held down (the
          caller presses it) and a small neutral check on its corner, never a
          box round it. The rest wait a little quieter. */}
      <View style={[styles.lookChoice, !on && styles.lookQuiet]}>
        {children}
        {on && <PickCheck />}
      </View>
    </Pressable>
  );
}

/**
 * The pick's mark on a key choice (here and in the icon sheet): a neutral
 * disc with a check on the key's top-right corner, cut out of the key by a
 * rim of the sheet's own surface. Neutral, never the accent: answers are
 * neutral (the desk's `.agent-look__check`).
 */
export function PickCheck() {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Animated.View
      entering={FadeIn.duration(120)}
      style={[styles.check, { backgroundColor: colors.textStrong, borderColor: colors.surfacePanel }]}
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
    >
      <Icon name="checkmark" size={iconSize.micro} color={colors.surfacePanel} />
    </Animated.View>
  );
}

const SWATCH = 28;
const RING = SWATCH + 8;
/** A key choice: the small key and its depth, with room for the check on its corner. */
const KEY_RING = keySize.md + 10;
/** The check's disc, and the rim that cuts it out of the key. */
const CHECK = 16;
const CHECK_RIM = 2;

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
  chipOn: { backgroundColor: colors.selectedFill, borderColor: colors.selectedFill },
  chipPressed: { backgroundColor: colors.surfaceControlHover },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -space['2xs'] },
  swatchTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  look: { gap: space.xs },
  more: { alignSelf: 'flex-start' },
  lookChoice: {
    width: KEY_RING,
    height: KEY_RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lookQuiet: { opacity: 0.78 },
  check: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: CHECK,
    height: CHECK,
    borderRadius: radius.pill,
    borderWidth: CHECK_RIM,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
