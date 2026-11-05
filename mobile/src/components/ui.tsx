/**
 * The few primitives every screen shares: text in the type scale, the
 * semantic button family (primary / secondary / ghost / danger, as on the
 * desktop), an icon (SF Symbol on iOS, Material Symbol on Android), and the
 * status dot. Every control is at least 44pt to touch, whatever it draws.
 */

import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import {
  alpha,
  chromeScale,
  fonts,
  iconSize,
  lineHeight,
  radius,
  space,
  type,
  type Palette,
} from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
import type { Tone } from '../lib/connection';
import { useAccent, useAnswerAccent } from '../lib/accent';
import { haptic } from '../lib/haptics';
import { MATERIAL, type SFName } from '../lib/icons';
import { useApp } from '../lib/store';

/** Ripple for Android presses; iOS uses its pressed tints. */
export function useRipple() {
  const colors = useColors();
  return { color: alpha(colors.textStrong, 0.08) };
}

/** Increase Contrast: each step of grey reads one step stronger (brighter in dark, darker in light). */
const stronger = new Map<Palette, Record<string, string>>();
function strongerOf(colors: Palette): Record<string, string> {
  let map = stronger.get(colors);
  if (!map) {
    map = {
      [colors.textMuted]: colors.textSecondary,
      [colors.textSecondary]: colors.textPrimary,
      [colors.textPrimary]: colors.textStrong,
    };
    stronger.set(colors, map);
  }
  return map;
}

/**
 * Hierarchy is carried by weight, not colour: a name or a card's title is
 * `headline` (16 semibold) over a `small` secondary line, and metadata is a
 * muted `caption`. One coloured element per row at most, never a whole line.
 */
type Variant = 'body' | 'small' | 'caption' | 'subhead' | 'headline' | 'title' | 'display' | 'mono';

const variants = StyleSheet.create({
  body: { fontFamily: fonts.regular, fontSize: type.body, lineHeight: lineHeight(type.body, 1.5) },
  small: { fontFamily: fonts.regular, fontSize: type.small, lineHeight: lineHeight(type.small) },
  caption: {
    fontFamily: fonts.regular,
    fontSize: type.caption,
    lineHeight: lineHeight(type.caption),
  },
  subhead: {
    fontFamily: fonts.medium,
    fontSize: type.subhead,
    lineHeight: lineHeight(type.subhead, 1.3),
  },
  headline: {
    fontFamily: fonts.semibold,
    fontSize: type.subhead,
    lineHeight: lineHeight(type.subhead, 1.375),
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: type.title,
    lineHeight: lineHeight(type.title, 1.3),
  },
  display: {
    fontFamily: fonts.semibold,
    fontSize: type.display,
    lineHeight: lineHeight(type.display, 1.2),
    letterSpacing: -0.4,
  },
  mono: { fontFamily: fonts.mono, fontSize: type.small, lineHeight: lineHeight(type.small, 1.5) },
});

export function T({
  variant = 'body',
  color,
  style,
  ...rest
}: TextProps & { variant?: Variant; color?: string }) {
  const colors = useColors();
  const high = useApp((s) => s.highContrast);
  const ink = color ?? colors.textPrimary;
  return (
    <Text
      {...rest}
      style={[variants[variant], { color: (high && strongerOf(colors)[ink]) || ink }, style]}
    />
  );
}

/** A toggle flipped: the one tap that earns a haptic by itself. */
export const tap = haptic.select;

/**
 * `answer` is an approval's Allow: filled like a primary, but always the
 * neutral accent (`answerAccent`: near-white in dark, near-black in light),
 * never the agent's colour.
 */
type ButtonVariant = 'primary' | 'answer' | 'secondary' | 'outline' | 'ghost' | 'danger';

type ButtonColors = { bg: string; pressed: string; fg: string; border?: string };

/** Primary takes the accent in scope (lib/accent.tsx); the rest are the palette's. */
const buttonColorsOf = (
  colors: Palette
): Record<Exclude<ButtonVariant, 'primary' | 'answer'>, ButtonColors> => ({
  // Filled neutral, not outlined: beside a filled Allow it reads as the same
  // family of control, as Grok's pair does.
  secondary: {
    bg: colors.surfaceControl,
    pressed: colors.surfaceControlHover,
    fg: colors.textStrong,
  },
  // The quieter of a pair (Discard beside Keep): a line, no fill.
  outline: {
    bg: 'transparent',
    pressed: colors.surfaceControl,
    fg: colors.textStrong,
    border: colors.borderStrong,
  },
  ghost: { bg: 'transparent', pressed: colors.surfaceControl, fg: colors.textSecondary },
  danger: {
    bg: alpha(colors.accentError, 0.12),
    pressed: alpha(colors.accentError, 0.2),
    fg: colors.accentErrorLight,
  },
});

export function Button({
  title,
  variant = 'secondary',
  size = 'default',
  busy = false,
  icon,
  style,
  disabled,
  onPress,
  lines = 1,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  title: string;
  variant?: ButtonVariant;
  size?: 'default' | 'large' | 'compact';
  busy?: boolean;
  icon?: SFName;
  style?: StyleProp<ViewStyle>;
  /** A choice someone must read in full (a session's options) wraps instead of truncating. */
  lines?: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const accent = useAccent();
  const answer = useAnswerAccent();
  const filled = variant === 'primary' || variant === 'answer';
  const a = variant === 'answer' ? answer : accent;
  const off = !!disabled && !busy;
  // A disabled primary is a plain grey control, not a faded accent: a
  // half-transparent colour reads as muddy, and as almost-on.
  const c: ButtonColors = filled
    ? off
      ? { bg: colors.surfaceControl, pressed: colors.surfaceControl, fg: colors.textMuted }
      : { bg: a.accent, pressed: a.pressed, fg: a.onAccent }
    : buttonColorsOf(colors)[variant];
  const height = size === 'large' ? 50 : size === 'compact' ? 32 : 44;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || busy), busy }}
      disabled={disabled || busy}
      onPress={onPress}
      android_ripple={ripple}
      hitSlop={size === 'compact' ? 6 : undefined}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: height,
          paddingHorizontal: size === 'compact' ? space.md : space.lg,
          backgroundColor: pressed ? c.pressed : c.bg,
          borderColor: c.border ?? 'transparent',
          opacity: off && !filled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator size="small" color={c.fg} />
      ) : (
        <>
          {icon && <Icon name={icon} size={iconSize.body} color={c.fg} />}
          <T
            variant={size === 'compact' ? 'small' : 'subhead'}
            color={c.fg}
            numberOfLines={lines}
            maxFontSizeMultiplier={lines > 1 ? 2 : chromeScale}
            style={lines > 1 ? { flexShrink: 1, paddingVertical: space.sm } : undefined}
          >
            {title}
          </T>
        </>
      )}
    </Pressable>
  );
}

/** Only the sizes in `iconSize`: a 13 or a 15 is a typo in the system, so the type refuses it. */
type IconSize = (typeof iconSize)[keyof typeof iconSize];

/** An SF Symbol on iOS, its Material Symbol on Android; `fallback` if neither exists. */
export function Icon({
  name,
  size = iconSize.body,
  color,
  fallback,
}: {
  name: SFName;
  size?: IconSize;
  color?: string;
  fallback?: ReactNode;
}) {
  const colors = useColors();
  return (
    <Glyph name={name} size={size} color={color ?? colors.textSecondary} fallback={fallback} />
  );
}

function Glyph({
  name,
  size,
  color,
  fallback,
}: {
  name: SFName;
  size: number;
  color: string;
  fallback?: ReactNode;
}) {
  if (Platform.OS === 'ios') {
    return <SymbolView name={name} size={size} tintColor={color} weight="medium" />;
  }
  const material = MATERIAL[name];
  if (!material) return <>{fallback ?? null}</>;
  return (
    <SymbolView
      name={{ android: material as never }}
      size={size}
      tintColor={color}
      fallback={fallback}
    />
  );
}

export function IconButton({
  name,
  label,
  onPress,
  color: tint,
  size = iconSize.button,
  fallback,
}: {
  name: SFName;
  label: string;
  onPress: () => void;
  color?: string;
  size?: IconSize;
  fallback?: string;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const color = tint ?? colors.textSecondary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      android_ripple={{ ...ripple, borderless: true, radius: 22 }}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { backgroundColor: colors.surfaceControl },
      ]}
    >
      <Icon name={name} size={size} color={color} fallback={<T color={color}>{fallback}</T>} />
    </Pressable>
  );
}

/** A connection tone's colour in the palette in force. */
export function useToneColor(): Record<Tone, string> {
  const colors = useColors();
  return {
    ok: colors.accentSuccess,
    problem: colors.accentError,
    unknown: colors.textMuted,
    busy: colors.accentWarning,
  };
}

export function Dot({
  color,
  size = 8,
  glow = false,
}: {
  color: string;
  size?: number;
  glow?: boolean;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        ...(glow
          ? {
              shadowColor: color,
              shadowOpacity: 0.7,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 0 },
            }
          : null),
      }}
    />
  );
}

/**
 * A group's label, as iOS sets it: small capitals over the group, a header
 * to VoiceOver, and grown with Dynamic Type only as far as chrome does.
 */
export function SectionTitle({ title, style }: { title: string; style?: StyleProp<TextStyle> }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <T
      variant="caption"
      color={colors.textMuted}
      style={[styles.sectionTitle, style]}
      maxFontSizeMultiplier={chromeScale}
      accessibilityRole="header"
    >
      {title.toUpperCase()}
    </T>
  );
}

/** A grouped section on a settings-style screen. */
export function Section({
  title,
  children,
  footer,
}: {
  title?: string;
  children: ReactNode;
  footer?: string;
}) {
  const styles = useStyles();
  const colors = useColors();
  return (
    <View style={styles.section}>
      {title && <SectionTitle title={title} />}
      <View style={styles.sectionBody}>{children}</View>
      {footer && (
        <T variant="small" color={colors.textMuted} style={styles.sectionFooter}>
          {footer}
        </T>
      )}
    </View>
  );
}

const LONG_VALUE = 18;

export function Row({
  label,
  value,
  leading,
  onPress,
  last,
  destructive,
  trailing,
  detail,
  disabled,
  selected,
}: {
  label: string;
  /** A line under the label saying what it does. */
  detail?: string;
  value?: string;
  leading?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  destructive?: boolean;
  /** A choice in a list of them (a check in `trailing`): said to VoiceOver too. */
  selected?: boolean;
  /** A control in place of the chevron, such as a Switch. */
  trailing?: ReactNode;
  /**
   * An action that can't be taken right now: dimmed, not tappable, still
   * announced as a button. Say why in `detail`.
   */
  disabled?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const action = !!onPress && !disabled;
  const labelColor = disabled
    ? colors.textMuted
    : destructive
      ? colors.accentErrorLight
      : colors.textBody;
  // A value too long to sit beside its label goes under it, rather than
  // squeezing the label onto two lines.
  const long = value != null && value.length > LONG_VALUE;
  return (
    <Pressable
      disabled={!action}
      onPress={onPress}
      accessibilityRole={action || disabled ? 'button' : undefined}
      accessibilityState={
        disabled ? { disabled: true } : selected != null ? { selected } : undefined
      }
      android_ripple={action ? ripple : undefined}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: colors.surfaceGroupPressed },
      ]}
    >
      {disabled ? <View style={{ opacity: 0.4 }}>{leading}</View> : leading}
      {detail || long ? (
        <View style={styles.rowText}>
          <T color={labelColor}>{label}</T>
          {!!detail && (
            <T variant="small" color={colors.textMuted}>
              {detail}
            </T>
          )}
          {long && (
            <T variant="small" color={colors.textSecondary}>
              {value}
            </T>
          )}
        </View>
      ) : (
        <T color={labelColor} style={{ flex: 1 }}>
          {label}
        </T>
      )}
      {value != null && !long && (
        <T color={colors.textSecondary} numberOfLines={1} style={styles.rowValue}>
          {value}
        </T>
      )}
      {trailing}
      {action && !destructive && !trailing && (
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      )}
      {/* Inset from the leading edge, as iOS draws a group's dividers. */}
      {!last && <View style={styles.rowDivider} />}
    </Pressable>
  );
}

/**
 * A sheet's page. Its colour reaches past the bottom of the view, under the
 * home indicator and into the display's rounded corners, so no strip of the
 * native sheet's own background can show below the content as a square band.
 */
export function SheetPage({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.sheetPage}>
      <View pointerEvents="none" style={styles.sheetBleed} />
      {children}
    </View>
  );
}

/** How far a sheet's colour runs past its view: more than any home indicator's inset. */
const SHEET_BLEED = 160;

/** A group's divider, inset from the leading edge as iOS draws it. Put it last in a row. */
export function InsetDivider() {
  const styles = useStyles();
  return <View style={styles.rowDivider} />;
}

/** Mutually exclusive filters, as the desktop's SegmentedControl. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) tap();
              onChange(o.value);
            }}
            hitSlop={4}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <T
              variant="small"
              color={on ? colors.onSelectedFill : colors.textSecondary}
              style={on ? { fontFamily: fonts.medium } : undefined}
              maxFontSizeMultiplier={chromeScale}
            >
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  segmented: {
    flexDirection: 'row',
    padding: space['2xs'],
    gap: space['2xs'],
    borderRadius: radius.control,
    backgroundColor: colors.surfaceControl,
  },
  segment: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.inner,
  },
  segmentOn: { backgroundColor: colors.selectedFill },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginBottom: space.xl },
  sectionTitle: { marginLeft: space.lg, marginBottom: space.sm, letterSpacing: 0.4 },
  // Groups sit on a sheet or a grouped screen (surfacePanel): fill, no line.
  sectionBody: {
    backgroundColor: colors.surfaceGroup,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  sectionFooter: { marginHorizontal: space.lg, marginTop: space.sm },
  row: {
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rowText: { flex: 1, gap: space['2xs'] },
  sheetPage: { flex: 1, backgroundColor: colors.surfacePanel },
  sheetBleed: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: -SHEET_BLEED,
    backgroundColor: colors.surfacePanel,
  },
  rowDivider: {
    position: 'absolute',
    left: space.lg,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderDefault,
  },
  rowValue: { maxWidth: '45%', textAlign: 'right' },
}));
