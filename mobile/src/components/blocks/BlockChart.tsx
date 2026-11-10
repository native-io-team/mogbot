/**
 * A chart block, drawn from the shared model (`chartModel` in the protocol's
 * blocks.ts) with react-native-svg: the desk draws the same paths. Thin
 * marks, a recessive grid, a legend only for two or more series, words in
 * text roles (never the series colour). Touch a column (or drag across) for
 * its values; a pie lists its slices under it, so nothing is colour alone.
 */

import {
  chartHasData,
  chartLabel,
  chartModel,
  formatValue,
  indexAt,
  legendEntries,
  tooltipAt,
  type CartesianModel,
  type ChartBlock,
  type PieModel,
} from '@shipstudio/companion-protocol';
import { useMemo, useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line as SvgLine, Path, Text as SvgText } from 'react-native-svg';
import { makeStyles, useColors, useTextScale } from '../../lib/appearance';
import {
  alpha,
  chartSize,
  chromeScale,
  fonts,
  radius,
  seriesColor,
  space,
  type,
  type Palette,
} from '../../lib/theme';
import { T } from '../ui';

export function BlockChart({ block }: { block: ChartBlock }) {
  const colors = useColors();
  const styles = useStyles();
  useTextScale();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  if (!chartHasData(block)) {
    return (
      <T variant="small" color={colors.textMuted} style={styles.empty}>
        Nothing to chart yet.
      </T>
    );
  }
  if (block.chart === 'sparkline') return <Sparkline block={block} />;
  const pie = block.chart === 'pie' || block.chart === 'donut';
  const legend = pie ? [] : legendEntries(block);
  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="image"
      accessibilityLabel={chartLabel(block)}
    >
      {legend.length > 0 && (
        <View style={styles.legend} testID="chart-legend">
          {legend.map((l) => (
            <View key={l.slot + l.name} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: seriesColor(colors, l.slot) }]} />
              <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={chromeScale}>
                {l.name}
              </T>
            </View>
          ))}
        </View>
      )}
      <View onLayout={onLayout} style={{ height: pie ? chartSize.pie : chartSize.height }}>
        {width > 0 &&
          (pie ? (
            <PieChart block={block} width={width} />
          ) : (
            <Cartesian block={block} width={width} />
          ))}
      </View>
      {pie && <PieLegend block={block} />}
      {!!block.axis && !pie && (
        <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
          {block.axis}
        </T>
      )}
    </View>
  );
}

function Cartesian({ block, width }: { block: ChartBlock; width: number }) {
  const colors = useColors();
  const styles = useStyles();
  const height = chartSize.height;
  const model = useMemo(
    () => chartModel(block, width, height) as CartesianModel,
    [block, width, height]
  );
  const [at, setAt] = useState<number | null>(null);
  const pick = (e: GestureResponderEvent) => setAt(indexAt(model, e.nativeEvent.locationX));
  const isBar = block.chart === 'bar';
  const surface = colors.surfacePanel;
  const tip = at == null ? null : tooltipAt(block, at);
  const tipX = at == null ? 0 : model.xs[at]!;
  const tipLeft = Math.max(0, Math.min(width - chartSize.tooltip, tipX - chartSize.tooltip / 2));
  return (
    <View
      style={{ width, height }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => true}
      onResponderGrant={pick}
      onResponderMove={pick}
      testID="chart-plot"
    >
      <Svg width={width} height={height}>
        {model.ticks.map((t) => (
          <G key={t.value}>
            <SvgLine
              x1={model.plot.x}
              x2={model.plot.x + model.plot.w}
              y1={t.y}
              y2={t.y}
              stroke={t.value === 0 ? colors.borderStrong : colors.borderSubtle}
              strokeWidth={1}
            />
            <SvgText
              x={model.plot.x - space.tight}
              y={t.y + type.caption / 3}
              fontSize={type.caption}
              fontFamily={fonts.regular}
              fill={colors.textMuted}
              textAnchor="end"
            >
              {t.label}
            </SvgText>
          </G>
        ))}
        {model.xLabels.map((l) => (
          <SvgText
            key={l.index}
            x={l.x}
            y={height - space.xs}
            fontSize={type.caption}
            fontFamily={fonts.regular}
            fill={colors.textMuted}
            textAnchor={
              !isBar && l.index === 0
                ? 'start'
                : !isBar && l.index === block.labels.length - 1
                  ? 'end'
                  : 'middle'
            }
          >
            {l.label}
          </SvgText>
        ))}
        {at != null && (
          <SvgLine
            x1={tipX}
            x2={tipX}
            y1={model.plot.y}
            y2={model.plot.y + model.plot.h}
            stroke={colors.borderStrong}
            strokeWidth={1}
          />
        )}
        {model.bars.map((b) => (
          <Path
            key={`${b.series}-${b.index}`}
            d={b.path}
            fill={seriesColor(colors, b.slot)}
            opacity={at == null || at === b.index ? 1 : 0.45}
          />
        ))}
        {model.lines.map((s) => (
          <G key={s.slot}>
            {s.area && (
              <Path
                d={s.area}
                fill={alpha(
                  seriesColor(colors, s.slot),
                  block.chart === 'area' ? chartSize.wash * 2 : chartSize.wash
                )}
              />
            )}
            <Path
              d={s.line}
              stroke={seriesColor(colors, s.slot)}
              strokeWidth={chartSize.line}
              fill="none"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {endPoints(s.points).map((p) => (
              <Circle
                key={p.x}
                cx={p.x}
                cy={p.y}
                r={chartSize.dot}
                fill={seriesColor(colors, s.slot)}
                stroke={surface}
                strokeWidth={chartSize.ring}
              />
            ))}
            {at != null && s.points[at] && (
              <Circle
                cx={s.points[at]!.x}
                cy={s.points[at]!.y}
                r={chartSize.dot}
                fill={seriesColor(colors, s.slot)}
                stroke={surface}
                strokeWidth={chartSize.ring}
              />
            )}
          </G>
        ))}
      </Svg>
      {tip && (
        <View style={[styles.tip, { left: tipLeft }]} pointerEvents="none" testID="chart-tooltip">
          <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {tip.title}
          </T>
          {tip.rows.map((r) => (
            <View key={r.slot} style={styles.tipRow}>
              <View style={[styles.swatch, { backgroundColor: seriesColor(colors, r.slot) }]} />
              {block.series.length > 1 && (
                <T
                  variant="caption"
                  color={colors.textSecondary}
                  numberOfLines={1}
                  style={{ flex: 1 }}
                >
                  {r.name}
                </T>
              )}
              <T variant="caption" color={colors.textStrong} style={styles.tipValue}>
                {r.value}
              </T>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** A line's last point carries a dot (and a lone point, which has no line). */
function endPoints(points: ({ x: number; y: number } | null)[]): { x: number; y: number }[] {
  const real = points.filter((p): p is { x: number; y: number } => !!p);
  if (!real.length) return [];
  return [real[real.length - 1]!];
}

function PieChart({ block, width }: { block: ChartBlock; width: number }) {
  const colors = useColors();
  const model = useMemo(() => chartModel(block, width, chartSize.pie) as PieModel, [block, width]);
  const units = { prefix: block.prefix, suffix: block.suffix };
  return (
    <Svg width={width} height={chartSize.pie}>
      {model.slices.map((s) => (
        <Path
          key={s.index}
          d={s.path}
          fill={seriesColor(colors, s.slot)}
          stroke={colors.surfacePanel}
          strokeWidth={model.slices.length > 1 ? chartSize.ring : 0}
          strokeLinejoin="round"
          fillRule="evenodd"
        />
      ))}
      {model.inner > 0 && (
        <>
          <SvgText
            x={model.cx}
            y={model.cy + type.title / 3}
            fontSize={type.title}
            fontFamily={fonts.semibold}
            fill={colors.textStrong}
            textAnchor="middle"
          >
            {formatValue(model.total, units)}
          </SvgText>
          <SvgText
            x={model.cx}
            y={model.cy + type.title / 3 + type.caption + space.xs}
            fontSize={type.caption}
            fontFamily={fonts.regular}
            fill={colors.textMuted}
            textAnchor="middle"
          >
            Total
          </SvgText>
        </>
      )}
    </Svg>
  );
}

/** A pie's slices, each with its value and share: the table view, always shown. */
function PieLegend({ block }: { block: ChartBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const values = block.series[0]?.values ?? [];
  const total = values.reduce<number>((a, v) => a + (typeof v === 'number' && v > 0 ? v : 0), 0);
  return (
    <View style={styles.pieRows} testID="pie-legend">
      {block.labels.map((label, i) => {
        const v = values[i];
        if (typeof v !== 'number' || v <= 0) return null;
        return (
          <View key={label + i} style={styles.pieRow}>
            <View
              style={[styles.swatch, { backgroundColor: seriesColor(colors, Math.min(i, 7) + 1) }]}
            />
            <T variant="small" color={colors.textPrimary} style={{ flex: 1 }} numberOfLines={1}>
              {label}
            </T>
            <T variant="small" color={colors.textStrong} style={styles.num}>
              {formatValue(v, { prefix: block.prefix, suffix: block.suffix })}
            </T>
            <T variant="small" color={colors.textMuted} style={[styles.num, styles.share]}>
              {total > 0 ? `${Math.round((v / total) * 100)}%` : ''}
            </T>
          </View>
        );
      })}
    </View>
  );
}

/** A trend the size of a sentence: the line, its last value, and where it started. */
function Sparkline({ block }: { block: ChartBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const model = useMemo(
    () => chartModel(block, chartSize.sparkWidth, chartSize.spark) as CartesianModel,
    [block]
  );
  const values = (block.series[0]?.values ?? []).filter((v): v is number => typeof v === 'number');
  const last = values[values.length - 1];
  const units = { prefix: block.prefix, suffix: block.suffix };
  return (
    <View style={styles.spark} accessible accessibilityLabel={chartLabel(block)}>
      <Svg width={chartSize.sparkWidth} height={chartSize.spark}>
        <SparkPath model={model} colors={colors} />
      </Svg>
      <T variant="headline" color={colors.textStrong}>
        {formatValue(last ?? null, units)}
      </T>
      {block.series[0]?.name ? (
        <T variant="small" color={colors.textMuted} numberOfLines={1} style={{ flexShrink: 1 }}>
          {block.series[0].name}
        </T>
      ) : null}
    </View>
  );
}

/** A sparkline's line in the quiet ink, its current point in the strong one. */
export function SparkPath({ model, colors }: { model: CartesianModel; colors: Palette }) {
  const s = model.lines[0];
  if (!s) return null;
  const end = endPoints(s.points)[0];
  return (
    <>
      <Path
        d={s.line}
        stroke={colors.textMuted}
        strokeWidth={chartSize.line}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {end && <Circle cx={end.x} cy={end.y} r={chartSize.dot - 1} fill={colors.textStrong} />}
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: { gap: space.sm },
  empty: { paddingVertical: space.md },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md, rowGap: space.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  swatch: {
    width: chartSize.swatch,
    height: chartSize.swatch,
    borderRadius: chartSize.swatch / 2,
  },
  tip: {
    position: 'absolute',
    top: 0,
    width: chartSize.tooltip,
    gap: space['2xs'],
    paddingVertical: space.tight,
    paddingHorizontal: space.sm,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  tipValue: { fontFamily: fonts.semibold, fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  pieRows: { gap: space.xs },
  pieRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  num: { fontVariant: ['tabular-nums'] },
  share: { minWidth: 40, textAlign: 'right' },
  spark: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
}));
