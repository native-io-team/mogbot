/**
 * The chat header's usage ring (the current 5-hour window, as the engine
 * reported it) and the bars the Usage sheet draws, with the Mac's pace
 * estimate under a bar when it sent one. Figures from
 * lib/usageSheet.ts; colours from the palette, light and dark.
 */

import { Pressable, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { makeStyles, useColors } from '../lib/appearance';
import type { UsageMeter, UsageTone } from '../lib/usageSheet';
import { iconSize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { T } from './ui';

const inkOf = (colors: Palette, tone: UsageTone) =>
  tone === 'limited'
    ? colors.accentErrorLight
    : tone === 'warning'
      ? colors.accentWarning
      : colors.textSecondary;

/** The ring's diameter: an icon button's glyph. */
const RING = iconSize.button;
const STROKE = space['2xs'] + space['3xs'];

export function UsageRing({
  percent,
  tone,
  onPress,
}: {
  percent: number;
  tone: UsageTone;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const r = (RING - STROKE) / 2;
  const length = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, percent));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Usage: ${shown}% of the 5-hour limit`}
      accessibilityHint="Context, plan limits and every account"
      hitSlop={space.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.ring, pressed && PRESSED]}
    >
      <Svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`}>
        <Circle
          cx={RING / 2}
          cy={RING / 2}
          r={r}
          stroke={colors.borderStrong}
          strokeWidth={STROKE}
          fill="none"
        />
        <Circle
          cx={RING / 2}
          cy={RING / 2}
          r={r}
          stroke={inkOf(colors, tone)}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${(length * shown) / 100} ${length}`}
          // From twelve o'clock, clockwise.
          transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
        />
      </Svg>
    </Pressable>
  );
}

/** A thin bar: the share used, in its tone. */
export function UsageBar({ percent, tone }: { percent: number; tone: UsageTone }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.track}>
      <View
        style={[
          styles.fill,
          {
            width: `${Math.max(0, Math.min(100, percent))}%`,
            backgroundColor: inkOf(colors, tone),
          },
        ]}
      />
    </View>
  );
}

/** "5-hour limit  38%", its bar, and "Resets at 3:20 PM". */
export function MeterRow({ meter, title }: { meter: UsageMeter; title?: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={`${title ?? meter.label}: ${meter.percent}%. ${meter.detail}${
        meter.pace ? `. ${meter.pace.text}. ${meter.pace.basis}` : ''
      }`}
    >
      <View style={styles.meterHead}>
        <T variant="body" color={colors.textStrong} style={styles.grow} numberOfLines={1}>
          {title ?? meter.label}
        </T>
        <T
          variant="small"
          color={meter.tone === 'calm' ? colors.textSecondary : inkOf(colors, meter.tone)}
        >
          {title ? meter.label : `${meter.percent}%`}
        </T>
      </View>
      <UsageBar percent={meter.percent} tone={meter.tone} />
      <T variant="small" color={colors.textSecondary}>
        {meter.detail}
      </T>
      {meter.pace && (
        <View style={styles.pace}>
          <T variant="small" color={colors.accentWarning}>
            {meter.pace.text}
          </T>
          <T variant="small" color={colors.textMuted}>
            {meter.pace.basis}
          </T>
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  ring: { alignItems: 'center', justifyContent: 'center', padding: space['3xs'] },
  track: {
    height: space.tight,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
  meter: { gap: space.xs },
  pace: { gap: space['2xs'] },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  grow: { flex: 1 },
}));
