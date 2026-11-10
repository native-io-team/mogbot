/**
 * The chat header's usage meter (what is used of the current 5-hour window,
 * as the engine reported it) and the bars the Usage sheet draws from an
 * older Mac, with the Mac's pace estimate under a bar when it sent one.
 * Every limit is said and drawn as what is used, as the stack says it; an
 * estimate is secondary ink, never amber (amber means "needs you"). Figures
 * from lib/usageSheet.ts; colours from the palette, light and dark.
 */

import { Pressable, StyleSheet, View } from 'react-native';
import { makeStyles, useColors, useLargeText } from '../lib/appearance';
import type { ComputeRow, ComputeView, UsageMeter, UsageTone } from '../lib/usageSheet';
import { depthOf, meter as meterSize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { T } from './ui';

/** The warning role from 80% used and when used up (it refills by itself: never error red). */
const inkOf = (colors: Palette, tone: UsageTone, calm = colors.textSecondary) =>
  tone === 'limited' || tone === 'warning' ? colors.accentWarning : calm;

/**
 * The header's usage meter: what is used of the 5-hour window, said as a
 * figure ("52%") in the header's tint. A pie in a circle read as the
 * appearance toggle at half, and a thin arc as a spinner; a number reads as
 * one thing only. Amber from 80% used, as every usage figure.
 */
export function UsageRing({
  percent,
  tone,
  tint,
  onPress,
}: {
  percent: number;
  tone: UsageTone;
  /** The header's tint (the agent's colour), as its other buttons; else secondary ink. */
  tint?: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const shown = Math.round(Math.max(0, Math.min(100, percent)));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Usage: ${shown}% of the 5-hour limit used`}
      accessibilityHint="Context, plan limits and every account"
      hitSlop={space.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.ring, pressed && PRESSED]}
    >
      <T
        variant="headline"
        color={inkOf(colors, tone, tint)}
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
        testID="usage-meter"
        style={styles.ringFigure}
      >
        {`${shown}%`}
      </T>
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
 * A limit: "5-hour limit  38% used", its bar filled to what is used, and
 * "Refills at 3:20 PM". With `title`, the conversation's context, said as
 * its own label ("32% full": a conversation fills, a limit is used).
 */
export function MeterRow({ meter, title }: { meter: UsageMeter; title?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const figure = title ? meter.label : (meter.figure ?? `${meter.percent}% used`);
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
      <UsageBar percent={meter.percent} tone={meter.tone} />
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
  ring: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space['2xs'] },
  // Figures that don't jiggle as the reading moves.
  ringFigure: { fontVariant: ['tabular-nums'] },
  // The one meter (theme `meter`, the desk's `--meter-*`), on its
  // see-through track, which shows on a dark group as on a light one.
  track: {
    height: meterSize.height,
    borderRadius: radius.pill,
    backgroundColor: colors.meterTrack,
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
