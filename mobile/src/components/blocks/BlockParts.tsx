/**
 * The blocks that show rather than ask: metric tiles, facts, a checklist,
 * steps, links, a callout, code and an image. Each in the app's own parts
 * (text roles, hairlines, the inner radius), never the agent's colour.
 */

import {
  chartModel,
  metricDelta,
  metricValue,
  type CalloutBlock,
  type CartesianModel,
  type ChartBlock,
  type ChecklistBlock,
  type CodeBlock,
  type FactsBlock,
  type ImageBlock,
  type LinksBlock,
  type Metric,
  type MetricsBlock,
  type StepStatus,
  type StepsBlock,
} from '@shipstudio/companion-protocol';
import { useMemo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import Svg from 'react-native-svg';
import { makeStyles, useColors } from '../../lib/appearance';
import type { SFName } from '../../lib/icons';
import {
  chartSize,
  depthOf,
  fonts,
  iconSize,
  lineHeight,
  PRESSED,
  radius,
  space,
  type,
  type Palette,
} from '../../lib/theme';
import { Attachments } from '../attachments';
import { DiffLines } from '../diff';
import { ShowAll } from '../ShowAll';
import { SideScroll } from '../SideScroll';
import { Icon, T } from '../ui';
import { SparkPath } from './BlockChart';

/* ---- Metrics ------------------------------------------------------------------- */

export function BlockMetrics({ block }: { block: MetricsBlock }) {
  const styles = useStyles();
  const pair = block.items.length > 1;
  return (
    <View style={styles.tiles}>
      {block.items.map((m, i) => (
        <MetricTile key={m.label + i} metric={m} half={pair} />
      ))}
    </View>
  );
}

function MetricTile({ metric, half }: { metric: Metric; half: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const delta = metricDelta(metric);
  const value = metricValue(metric);
  const tone =
    delta?.tone === 'good'
      ? colors.accentSuccess
      : delta?.tone === 'bad'
        ? colors.accentErrorLight
        : colors.textMuted;
  const arrow: SFName | null =
    delta?.direction === 'up'
      ? 'arrow.up.right'
      : delta?.direction === 'down'
        ? 'arrow.down.right'
        : null;
  const spark = useMemo(() => {
    if (!metric.trend || metric.trend.length < 2) return null;
    const block: ChartBlock = {
      kind: 'chart',
      chart: 'sparkline',
      summary: '',
      labels: [],
      series: [{ name: metric.label, values: metric.trend }],
    };
    return chartModel(block, chartSize.sparkWidth, chartSize.spark) as CartesianModel;
  }, [metric.trend, metric.label]);
  const said = [
    metric.label,
    value,
    delta
      ? `${delta.text}${metric.vs ? ` ${metric.vs}` : ''}, ${delta.tone === 'good' ? 'good' : delta.tone === 'bad' ? 'bad' : 'no change'}`
      : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View
      style={[styles.tile, half && styles.tileHalf]}
      accessible
      accessibilityLabel={said}
      testID="metric-tile"
    >
      <T variant="caption" color={colors.textSecondary} numberOfLines={2}>
        {metric.label}
      </T>
      <T variant="display" color={colors.textStrong} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </T>
      {delta && (
        <View style={styles.delta}>
          {arrow && <Icon name={arrow} size={iconSize.inline} color={tone} />}
          <T variant="caption" color={tone} style={{ fontFamily: fonts.semibold }}>
            {delta.text}
          </T>
          {!!metric.vs && (
            <T
              variant="caption"
              color={colors.textMuted}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {metric.vs}
            </T>
          )}
        </View>
      )}
      {spark && (
        <Svg width={chartSize.sparkWidth} height={chartSize.spark}>
          <SparkPath model={spark} colors={colors} />
        </Svg>
      )}
    </View>
  );
}

/* ---- Facts --------------------------------------------------------------------- */

export function BlockFacts({ block }: { block: FactsBlock }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View>
      {block.items.map((f, i) => (
        <View
          key={f.label + i}
          style={[styles.fact, i < block.items.length - 1 && styles.divided]}
          accessible
          accessibilityLabel={`${f.label}: ${f.value}`}
        >
          <T variant="small" color={colors.textMuted} style={styles.factLabel}>
            {f.label}
          </T>
          <T variant="small" color={colors.textStrong} selectable style={styles.factValue}>
            {f.value}
          </T>
        </View>
      ))}
    </View>
  );
}

/* ---- Checklist ----------------------------------------------------------------- */

export const checklistMeta = (block: ChecklistBlock) =>
  `${block.items.filter((i) => i.done).length} of ${block.items.length} done`;

export function BlockChecklist({ block }: { block: ChecklistBlock }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {block.items.map((it, i) => (
        <View
          key={it.text + i}
          style={styles.check}
          accessible
          accessibilityRole="checkbox"
          accessibilityState={{ checked: it.done }}
          accessibilityLabel={`${it.text}${it.note ? `. ${it.note}` : ''}`}
        >
          <View style={styles.checkIcon}>
            <Icon
              name={it.done ? 'checkmark.circle.fill' : 'circle'}
              size={iconSize.body}
              color={it.done ? colors.accentSuccess : colors.textFaint}
            />
          </View>
          <View style={styles.flex}>
            <T variant="body" color={it.done ? colors.textSecondary : colors.textBody}>
              {it.text}
            </T>
            {!!it.note && (
              <T variant="small" color={colors.textMuted}>
                {it.note}
              </T>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

/* ---- Steps --------------------------------------------------------------------- */

const STEP_WORD: Record<StepStatus, string> = {
  done: 'Done',
  current: 'In progress',
  todo: 'To do',
  failed: 'Failed',
};

export function BlockSteps({ block }: { block: StepsBlock }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View>
      {block.items.map((s, i) => {
        const last = i === block.items.length - 1;
        return (
          <View
            key={s.title + i}
            style={styles.step}
            accessible
            accessibilityLabel={`Step ${i + 1}, ${s.title}, ${STEP_WORD[s.status] ?? ''}${s.detail ? `. ${s.detail}` : ''}`}
            testID={`step-${s.status}`}
          >
            <View style={styles.rail}>
              <StepMark status={s.status} colors={colors} />
              {!last && <View style={styles.railLine} />}
            </View>
            <View style={[styles.flex, !last && styles.stepGap]}>
              <View style={styles.stepHead}>
                <T
                  variant="subhead"
                  color={s.status === 'todo' ? colors.textSecondary : colors.textStrong}
                  style={styles.flex}
                >
                  {s.title}
                </T>
                {!!s.when && (
                  <T variant="caption" color={colors.textMuted}>
                    {s.when}
                  </T>
                )}
              </View>
              {s.status === 'current' || s.status === 'failed' ? (
                <T
                  variant="caption"
                  color={s.status === 'failed' ? colors.accentErrorLight : colors.textSecondary}
                >
                  {STEP_WORD[s.status]}
                </T>
              ) : null}
              {!!s.detail && (
                <T variant="small" color={colors.textMuted}>
                  {s.detail}
                </T>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function StepMark({ status, colors }: { status: StepStatus; colors: Palette }) {
  const styles = useStyles();
  if (status === 'done')
    return <Icon name="checkmark.circle.fill" size={iconSize.body} color={colors.accentSuccess} />;
  if (status === 'failed')
    return <Icon name="xmark.circle.fill" size={iconSize.body} color={colors.accentErrorLight} />;
  if (status === 'current')
    return (
      <View style={[styles.ring, { borderColor: colors.statusRunning }]}>
        <View style={[styles.ringDot, { backgroundColor: colors.statusRunning }]} />
      </View>
    );
  return <View style={[styles.ring, { borderColor: colors.borderStrong }]} />;
}

/* ---- Links --------------------------------------------------------------------- */

const openLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) void Linking.openURL(url);
};

export function BlockLinks({ block }: { block: LinksBlock }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {block.items.map((l, i) => (
        <Pressable
          key={l.url + i}
          accessibilityRole="link"
          accessibilityLabel={`${l.label}, ${l.domain}`}
          accessibilityHint="Opens in your browser"
          onPress={() => openLink(l.url)}
          style={({ pressed }) => [styles.link, pressed && PRESSED]}
          testID="block-link"
        >
          <View style={styles.linkIcon}>
            <Icon name="globe" size={iconSize.body} color={colors.textMuted} />
          </View>
          <View style={styles.flex}>
            <T variant="subhead" color={colors.textStrong} numberOfLines={2}>
              {l.label}
            </T>
            <T variant="caption" color={colors.textMuted} numberOfLines={1}>
              {l.note ? `${l.domain} · ${l.note}` : l.domain}
            </T>
          </View>
          <Icon name="arrow.up.right" size={iconSize.inline} color={colors.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}

/* ---- Callout ------------------------------------------------------------------- */

export function BlockCallout({ block }: { block: CalloutBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const look = {
    info: { icon: 'info.circle' as SFName, word: 'Note', hue: colors.statusRunning },
    warning: {
      icon: 'exclamationmark.triangle' as SFName,
      word: 'Warning',
      hue: colors.accentWarning,
    },
    success: { icon: 'checkmark.circle.fill' as SFName, word: 'Done', hue: colors.accentSuccess },
  }[block.tone] ?? { icon: 'info.circle' as SFName, word: 'Note', hue: colors.statusRunning };
  return (
    <View
      style={[styles.callout, { borderLeftColor: look.hue }]}
      accessible
      accessibilityLabel={`${look.word}${block.title ? `, ${block.title}` : ''}. ${block.text}`}
      testID={`callout-${block.tone}`}
    >
      <View style={styles.calloutHead}>
        <Icon name={look.icon} size={iconSize.body} color={look.hue} />
        <T variant="headline" color={colors.textStrong} style={styles.flex}>
          {block.title ? block.title : look.word}
        </T>
      </View>
      <T variant="body" color={colors.textBody} selectable>
        {block.text}
      </T>
    </View>
  );
}

/* ---- Code ---------------------------------------------------------------------- */

const CODE_LINES = 16;

export function BlockCode({ block }: { block: CodeBlock }) {
  const colors = useColors();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const lines = block.code.replace(/\n$/, '').split('\n');
  const diff = (block.language ?? '').toLowerCase() === 'diff';
  if (diff) return <DiffLines lines={lines} cap={CODE_LINES} label={block.title ?? 'Diff'} />;
  const long = lines.length > CODE_LINES;
  const shown = long && !open ? lines.slice(0, CODE_LINES) : lines;
  return (
    <View style={styles.code}>
      {!!block.language && (
        <T variant="caption" color={colors.textMuted} style={styles.codeLang}>
          {block.language}
        </T>
      )}
      <SideScroll fade={colors.surfaceApp} contentContainerStyle={{ flexGrow: 1 }}>
        <T variant="mono" color={colors.textPrimary} selectable style={styles.codeText}>
          {shown.join('\n')}
        </T>
      </SideScroll>
      {long && (
        <ShowAll
          open={open}
          onPress={() => setOpen((v) => !v)}
          label={`Show all ${lines.length} lines`}
        />
      )}
    </View>
  );
}

/* ---- Image --------------------------------------------------------------------- */

export function BlockImage({ block, agentId }: { block: ImageBlock; agentId: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.image}>
      <Attachments agentId={agentId} attachments={[block.file]} />
      {!!block.caption && (
        <T variant="small" color={colors.textMuted}>
          {block.caption}
        </T>
      )}
    </View>
  );
}

const RING = iconSize.body - 2;
const RING_DOT = RING / 2 - 1;

const useStyles = makeStyles((colors) => ({
  flex: { flex: 1 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '100%',
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
  },
  tileHalf: { flexBasis: '40%' },
  delta: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  fact: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm },
  divided: { borderBottomWidth: 1, borderBottomColor: colors.borderDefault },
  factLabel: { width: '38%' },
  factValue: { flex: 1, textAlign: 'right', fontFamily: fonts.medium },
  list: { gap: space.sm },
  check: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  checkIcon: { height: lineHeight(type.body, 1.5), justifyContent: 'center' },
  step: { flexDirection: 'row', gap: space.md },
  rail: { alignItems: 'center', width: iconSize.body, paddingTop: space['2xs'] },
  railLine: {
    flex: 1,
    width: 2,
    marginTop: space.xs,
    backgroundColor: colors.borderDefault,
    borderRadius: radius.sm,
  },
  stepGap: { paddingBottom: space.md },
  stepHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 1,
  },
  ringDot: { width: RING_DOT, height: RING_DOT, borderRadius: RING_DOT / 2 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
  },
  linkIcon: { width: iconSize.body, alignItems: 'center' },
  callout: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfacePanel,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderLeftWidth: 3,
  },
  calloutHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  code: { backgroundColor: colors.surfaceApp, borderRadius: radius.inner, overflow: 'hidden' },
  codeLang: { paddingHorizontal: space.md, paddingTop: space.sm },
  codeText: { paddingHorizontal: space.md, paddingVertical: space.sm },
  image: { gap: space.xs },
}));
