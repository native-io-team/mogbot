/**
 * The chat header's usage meter (what is left of the current 5-hour window,
 * as the engine reported it) and the bars the Usage sheet draws from an
 * older Mac, with the Mac's pace estimate under a bar when it sent one.
 * Every limit is said and drawn as what is left, as the stack says it; an
 * estimate is secondary ink, never amber (amber means "needs you"). Figures
 * from lib/usageSheet.ts; colours from the palette, light and dark.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { makeStyles, useColors, useLargeText } from '../lib/appearance';
import type { ComputeRow, ComputeView, UsageMeter, UsageTone } from '../lib/usageSheet';
import { depthOf, iconSize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { T } from './ui';

const inkOf = (colors: Palette, tone: UsageTone) =>
  tone === 'limited'
    ? colors.accentErrorLight
    : tone === 'warning'
      ? colors.accentWarning
      : colors.textSecondary;

/** The meter's diameter: an icon button's glyph. */
const RING = iconSize.button;
/** The outline's width and the gap between it and the pie. */
const OUTLINE = 1;
const GAP = space['2xs'];

/**
 * A pie of `share` (0..1) from twelve o'clock, clockwise: a wedge, a full
 * disc, or nothing.
 */
export function piePath(cx: number, cy: number, r: number, share: number): string | null {
  const s = Math.max(0, Math.min(1, share));
  if (s <= 0) return null;
  if (s >= 1)
    return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`;
  const a = 2 * Math.PI * s;
  const f = (n: number) => Number(n.toFixed(3));
  const x = f(cx + r * Math.sin(a));
  const y = f(cy - r * Math.cos(a));
  const large = s > 0.5 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${large} 1 ${x} ${y} Z`;
}

/**
 * The header's usage meter, as the desk draws it: a static outline with
 * what is left as a pie inside it. A thin arc read as a loading spinner; a
 * filled wedge in a whole circle reads as a gauge.
 */
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
  // Filled to what is left, as every usage figure is said.
  const shown = 100 - Math.max(0, Math.min(100, percent));
  const c = RING / 2;
  const pie = piePath(c, c, c - OUTLINE - GAP, shown / 100);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Usage: ${shown}% of the 5-hour limit left`}
      accessibilityHint="Context, plan limits and every account"
      hitSlop={space.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.ring, pressed && PRESSED]}
    >
      <Svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} testID="usage-meter">
        <Circle
          cx={c}
          cy={c}
          r={c - OUTLINE / 2}
          stroke={colors.textSecondary}
          strokeWidth={OUTLINE}
          fill="none"
        />
        {pie && <Path d={pie} fill={inkOf(colors, tone)} />}
      </Svg>
    </Pressable>
  );
}

/** A thin bar filled to `percent`, in its tone. */
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

/**
 * A limit: "5-hour limit  62% left", its bar filled to what is left, and
 * "Resets at 3:20 PM". With `title`, the conversation's context, said as
 * its own label ("32% full": a conversation fills, a limit runs down).
 */
export function MeterRow({ meter, title }: { meter: UsageMeter; title?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const left = 100 - meter.percent;
  const figure = title ? meter.label : `${left}% left`;
  // At accessibility sizes the name takes its own line, whole, the figure under it.
  const large = useLargeText();
  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={`${title ?? meter.label}: ${figure}. ${meter.detail}${
        meter.pace ? `. ${meter.pace.text}. ${meter.pace.basis}` : ''
      }`}
    >
      <View style={[styles.meterHead, large && styles.wrapHead]}>
        <T
          variant="body"
          color={colors.textStrong}
          style={large ? styles.wholeLine : styles.grow}
          numberOfLines={large ? undefined : 1}
        >
          {title ?? meter.label}
        </T>
        <T
          variant="small"
          color={meter.tone === 'calm' ? colors.textSecondary : inkOf(colors, meter.tone)}
        >
          {figure}
        </T>
      </View>
      <UsageBar percent={title ? meter.percent : left} tone={meter.tone} />
      <T variant="small" color={colors.textSecondary}>
        {meter.detail}
      </T>
      {meter.pace && (
        <View style={styles.pace}>
          <T variant="small" color={colors.textSecondary}>
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
          <T variant="small" color={colors.textSecondary}>
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
  },
  cardHead: { gap: space['2xs'] },
  quiet: {
    backgroundColor: colors.surfaceGroup,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
    overflow: 'hidden',
  },
  quietRow: { gap: space['2xs'], paddingHorizontal: space.lg, paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDefault },
  ring: { alignItems: 'center', justifyContent: 'center', padding: space['3xs'] },
  // The site's meter: 8pt, so a share reads at a glance across the room.
  track: {
    height: space.sm,
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
  wrapHead: { flexWrap: 'wrap' },
  wholeLine: { flexBasis: '100%' },
}));
