/**
 * Usage at a glance on the phone, as the desk's sidebar row and Usage view
 * say it (`companion-protocol/usageGlance`): one line, the stack of accounts
 * as one segmented meter (each account a segment, in order, filled to what
 * its tighter limit has left), the soonest reset, and each account as a
 * card with its limits, who used it this week and "Where did my usage go".
 *
 * Only what the Mac served: an account with no reading is an empty, outlined
 * segment, never a full one; a second sign-in of the same account holds
 * nothing and says why. Reordering and "Use this one now" stay in Settings →
 * Accounts; adding and signing in happen on the Mac.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { StackKey, UsageGlance } from '@shipstudio/companion-protocol';
import { makeStyles, useColors } from '../lib/appearance';
import { depthOf, PRESSED, radius, space, type Palette } from '../lib/theme';
import { StatusPill, T } from './ui';

const fillOf = (colors: Palette, k: StackKey) =>
  k.tone === 'warning'
    ? colors.accentWarning
    : k.state === 'in_use'
      ? colors.textPrimary
      : colors.textMuted;

const pillOf = (k: StackKey) =>
  k.state === 'in_use'
    ? 'done'
    : k.state === 'out'
      ? 'out'
      : k.state === 'same'
        ? 'waiting'
        : 'idle';

/** The stack as one meter. */
export function StackMeter({ glance, tall = false }: { glance: UsageGlance; tall?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const words = glance.keys
    .map((k) =>
      k.left === null ? `${k.name}: ${k.stateLabel.toLowerCase()}` : `${k.name}: ${k.left}% left`
    )
    .join('; ');
  return (
    <View style={styles.track} accessible accessibilityLabel={`Room left. ${words}`}>
      {glance.keys.map((k) => (
        <View
          key={k.key}
          style={[styles.seg, tall && styles.segTall, k.left === null && styles.segEmpty]}
        >
          {k.left !== null && (
            <View
              style={[styles.fill, { width: `${k.left}%`, backgroundColor: fillOf(colors, k) }]}
            />
          )}
        </View>
      ))}
    </View>
  );
}

/** The answer: one line, the meter with each account named, and the next reset. */
export function GlanceCard({ glance }: { glance: UsageGlance }) {
  const colors = useColors();
  const styles = useStyles();
  if (glance.keys.length === 0) return null;
  return (
    <View style={styles.card}>
      <T variant="title" color={glance.tone === 'calm' ? colors.textStrong : colors.accentWarning}>
        {glance.headline}
      </T>
      {glance.estimate && (
        <T variant="caption" color={colors.textMuted}>
          {glance.estimate}. An estimate, not a reading.
        </T>
      )}
      <StackMeter glance={glance} tall />
      <View style={styles.labels}>
        {glance.keys.map((k) => (
          <View key={k.key} style={styles.label}>
            <T variant="caption" color={colors.textPrimary} numberOfLines={1}>
              {k.name}
            </T>
            <T variant="caption" color={colors.textMuted} numberOfLines={1}>
              {k.state === 'same'
                ? 'Adds no room'
                : k.left === null
                  ? k.signedIn
                    ? 'No reading'
                    : 'Not signed in'
                  : `${k.left}% left`}
            </T>
          </View>
        ))}
      </View>
      {glance.soonest && (
        <T variant="small" color={colors.textSecondary}>
          Next reset: {glance.soonest.account}’s {glance.soonest.label.toLowerCase()} limit,{' '}
          {glance.soonest.resetsIn} ({glance.soonest.resetsAt})
        </T>
      )}
      {glance.low && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {glance.low.text}
            {glance.low.waitUntil ? ` ${glance.low.waitUntil}, or add an account on your Mac.` : ''}
          </T>
        </View>
      )}
      {glance.nudge && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {glance.nudge.text}. {glance.nudge.question}
          </T>
          {glance.nudge.items.map((t) => (
            <T key={t} variant="caption" color={colors.textSecondary}>
              · {t}
            </T>
          ))}
          {!glance.nudge.empty && (
            <T variant="caption" color={colors.textMuted}>
              Ask your Chief of Staff to start it, or press Give agents something to do on your Mac.
            </T>
          )}
        </View>
      )}
    </View>
  );
}

/** One account: its place, name, state, limits, who used it, and where its usage went. */
export function KeyCard({ k }: { k: StackKey }) {
  const colors = useColors();
  const styles = useStyles();
  const [story, setStory] = useState(false);
  return (
    <View style={[styles.card, (k.state === 'same' || k.state === 'off') && styles.cardQuiet]}>
      <View style={styles.head}>
        <View style={[styles.cap, k.state === 'in_use' && styles.capOn]}>
          <T
            variant="caption"
            color={k.state === 'in_use' ? colors.surfaceApp : colors.textPrimary}
          >
            {String(k.position)}
          </T>
        </View>
        <View style={styles.title}>
          <T variant="headline" color={colors.textStrong} numberOfLines={1}>
            {k.name}
          </T>
          {k.detail.length > 0 && (
            <T variant="caption" color={colors.textMuted} numberOfLines={2}>
              {k.detail.join(' · ')}
            </T>
          )}
        </View>
      </View>
      <StatusPill tone={pillOf(k)} label={k.stateLabel} style={styles.pill} />
      {k.limits.map((l) => (
        <View key={l.key} style={styles.limit}>
          <View style={styles.limitHead}>
            <T variant="small" color={colors.textSecondary}>
              {l.label}
            </T>
            <T variant="small" color={colors.textPrimary}>
              {l.left}% left
            </T>
          </View>
          <View style={styles.bar}>
            <View
              style={[
                styles.fill,
                {
                  width: `${l.left}%`,
                  backgroundColor: l.tone === 'warning' ? colors.accentWarning : colors.textPrimary,
                },
              ]}
            />
          </View>
          {l.resetsAt && (
            <T variant="caption" color={colors.textMuted}>
              Resets {l.resetsIn} · {l.resetsAt}
            </T>
          )}
          {l.pace && (
            <T variant="caption" color={colors.accentWarning}>
              {l.pace.text} · {l.pace.basis}
            </T>
          )}
        </View>
      ))}
      {k.fix && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {k.fix.text} On your Mac: Agents → Usage.
          </T>
        </View>
      )}
      {k.spent.length > 0 && (
        <View style={styles.spent}>
          <T variant="caption" color={colors.textMuted}>
            Used by these agents this week
          </T>
          {k.spent.map((s) => (
            <T key={s} variant="small" color={colors.textSecondary}>
              {s}
            </T>
          ))}
        </View>
      )}
      {k.changes.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: story }}
          onPress={() => setStory((s) => !s)}
          style={({ pressed }) => pressed && PRESSED}
        >
          <T variant="small" color={colors.textPrimary}>
            {story ? 'Hide where my usage went' : 'Where did my usage go'}
          </T>
        </Pressable>
      )}
      {story &&
        k.changes.map((c) => (
          <View key={c.key} style={styles.change}>
            <T variant="small" color={colors.textPrimary}>
              {c.title}
            </T>
            <T variant="caption" color={colors.textMuted}>
              {c.when}
            </T>
            {c.runs.map((r) => (
              <T key={r} variant="caption" color={colors.textSecondary}>
                {r}
              </T>
            ))}
            {c.elsewhere && (
              <T variant="caption" color={colors.textSecondary}>
                {c.elsewhere}
              </T>
            )}
          </View>
        ))}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  track: { flexDirection: 'row', gap: space['3xs'] },
  seg: {
    flex: 1,
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  segTall: { height: space.md, borderRadius: radius.sm },
  segEmpty: {
    backgroundColor: colors.surfaceApp,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
  },
  fill: { height: '100%', borderRadius: radius.pill },
  labels: { flexDirection: 'row', gap: space['3xs'] },
  label: { flex: 1, minWidth: 0 },
  card: {
    gap: space.sm,
    padding: space.lg,
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
  },
  cardQuiet: { backgroundColor: colors.surfaceApp, boxShadow: 'none', borderStyle: 'dashed' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cap: {
    width: space.xl,
    height: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  capOn: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  title: { flex: 1, minWidth: 0 },
  pill: { alignSelf: 'flex-start' },
  limit: { gap: space['2xs'] },
  limitHead: { flexDirection: 'row', justifyContent: 'space-between' },
  bar: {
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  low: {
    gap: space['2xs'],
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
  },
  spent: { gap: space['3xs'] },
  change: {
    gap: space['3xs'],
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
}));
