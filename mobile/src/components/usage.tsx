/**
 * The chat header's usage ring (the current 5-hour window, as the engine
 * reported it) and the bars the Usage sheet draws, with the Mac's pace
 * estimate under a bar when it sent one. Figures from
 * lib/usageSheet.ts; colours from the palette, light and dark.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { makeStyles, useColors } from '../lib/appearance';
import type { ComputeRow, ComputeView, UsageMeter, UsageTone } from '../lib/usageSheet';
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

/**
 * Total compute's top: one short headline on whether agents can keep
 * working, when there's room again only when there's none now, and the
 * Mac's estimate across accounts when it sent one.
 */
export function ComputeSummary({ view }: { view: ComputeView }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.summary}>
      <T
        variant="title"
        color={view.tone === 'limited' ? colors.accentWarning : colors.textStrong}
        accessibilityRole="header"
      >
        {view.headline}
      </T>
      {view.detail && (
        <T variant="small" color={colors.textSecondary}>
          {view.detail}
        </T>
      )}
      {view.estimate && (
        <View style={styles.pace}>
          <T variant="small" color={colors.accentWarning}>
            {view.estimate.text}
          </T>
          <T variant="small" color={colors.textMuted}>
            {view.estimate.basis}
          </T>
        </View>
      )}
    </View>
  );
}

/** One account with a reading: its name, then each limit a row of its own. */
export function ComputeAccount({ row: r }: { row: ComputeRow }) {
  const colors = useColors();
  const styles = useStyles();
  const meters = [r.session, r.weekly, ...r.extra].filter((m): m is UsageMeter => m !== null);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <T variant="headline" color={colors.textStrong} numberOfLines={1}>
          {r.title}
        </T>
        {r.tags.length > 0 && (
          <T variant="small" color={colors.textMuted}>
            {r.tags.join(' · ')}
          </T>
        )}
      </View>
      {r.state && (
        <T variant="small" color={colors.textMuted}>
          {r.state}
        </T>
      )}
      {meters.map((m) => (
        <MeterRow key={m.key} meter={m} />
      ))}
    </View>
  );
}

/** Accounts with nothing to draw (out of usage, not signed in, not read): compact and quiet. */
export function ComputeQuiet({ rows }: { rows: ComputeRow[] }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.quiet}>
      {rows.map((r, i) => (
        <View
          key={r.key}
          style={[styles.quietRow, i > 0 && styles.divided]}
          accessible
          accessibilityLabel={`${r.title}: ${r.state ?? ''}`}
        >
          <T variant="small" color={colors.textSecondary} numberOfLines={1}>
            {r.title}
          </T>
          {r.state && (
            <T variant="small" color={colors.textMuted}>
              {r.state}
            </T>
          )}
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  summary: { gap: space.xs, paddingHorizontal: space.lg, paddingBottom: space.xs },
  card: {
    gap: space.lg,
    padding: space.lg,
    backgroundColor: colors.surfaceGroup,
    borderRadius: radius.card,
  },
  cardHead: { gap: space['2xs'] },
  quiet: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  quietRow: { gap: space['2xs'], paddingHorizontal: space.lg, paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  ring: { alignItems: 'center', justifyContent: 'center', padding: space['3xs'] },
  track: {
    height: space.tight,
    borderRadius: radius.pill,
    // Selected, not control: on a dark group the control grey is a shade
    // apart, and left the empty part of a meter invisible.
    backgroundColor: colors.surfaceSelected,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
  meter: { gap: space.xs },
  pace: { gap: space['2xs'] },
  meterHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  grow: { flex: 1 },
}));
