/**
 * Usage at a glance on the phone, as the desk's sidebar row and Usage view
 * say it (`companion-protocol/usageGlance`): one line, the stack of accounts
 * as one segmented meter (each account a segment, in order, filled to what
 * its tighter limit has left), the soonest reset, and each account as a
 * card with its limits, who used it this week and "Where did my usage go".
 * `GlanceRow` is the Agents list's line, the desk sidebar's row on the phone.
 *
 * Each account is named in full under the meter, one line each, never cut
 * to a stub. An estimate (a pace line, "Runs out ~Thu") is secondary ink:
 * amber means "needs you", and only nearly out is that.
 *
 * Only what the Mac served: an account with no reading is an empty, outlined
 * segment, never a full one; a second sign-in of the same account holds
 * nothing and says why. Reordering and "Use this one now" stay in Settings →
 * Accounts; adding and signing in happen on the Mac.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  ADD_ON_MAC,
  LOW_LEFT,
  placeLabel,
  SIGN_IN_DIFFERENT,
  type StackKey,
  type UsageGlance,
} from '@shipstudio/companion-protocol';
import { makeStyles, useColors } from '../lib/appearance';
import { depthOf, iconSize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { Icon, StatusPill, T } from './ui';

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

/** The stack as one meter: a segment per real account (a second sign-in of one draws none). */
export function StackMeter({ glance, tall = false }: { glance: UsageGlance; tall?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const words = glance.meterKeys
    .map((k) =>
      k.left === null ? `${k.name}: ${k.stateLabel.toLowerCase()}` : `${k.name}: ${k.left}% left`
    )
    .join('; ');
  return (
    <View style={styles.track} accessible accessibilityLabel={`Room left. ${words}`}>
      {glance.meterKeys.map((k) => (
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

/** What a key has left, in the legend's words. */
function roomWord(k: StackKey): string {
  if (k.left === null) return k.signedIn ? 'No reading' : 'Not signed in';
  return `${k.left}% left`;
}

/** Each account signed in twice, one line each, under the meter. */
function SameNotes({ glance }: { glance: UsageGlance }) {
  const colors = useColors();
  return (
    <>
      {glance.sameNotes.map((n) => (
        <T key={n} variant="caption" color={colors.textMuted}>
          {n}
        </T>
      ))}
    </>
  );
}

/**
 * The Agents list's usage line, as the desk sidebar's row says it, in
 * words anyone reads: "Usage 57% left this week", the stack as a thin
 * meter, and "Refills Sat 10:00 AM" (with "2 accounts" only when there
 * are). Amber only when the user must act. Opens Usage.
 */
export function GlanceRow({ glance, onPress }: { glance: UsageGlance; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  if (glance.keys.length === 0) return null;
  const { row } = glance;
  const foot = [row.refill, row.count].filter(Boolean).join(' · ');
  const label = `Usage: ${[row.figure, row.refill, row.count].filter(Boolean).join('. ')}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Every account, its limits and where its usage went"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && PRESSED]}
    >
      <T
        variant="small"
        color={row.needsYou ? colors.accentWarning : colors.textPrimary}
        numberOfLines={1}
      >
        <T variant="small" color={colors.textMuted}>
          Usage{' '}
        </T>
        {row.figure}
      </T>
      {glance.meterKeys.length > 0 && <StackMeter glance={glance} />}
      {!!foot && (
        <T variant="caption" color={colors.textMuted} numberOfLines={1}>
          {foot}
        </T>
      )}
    </Pressable>
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
      {/* A legend, one account a line: the full width for its name, so an
          email reads whole rather than as "Signed in on t…". */}
      <View style={styles.legend}>
        {glance.meterKeys.map((k) => (
          <View key={k.key} style={styles.legendRow}>
            <T variant="caption" color={colors.textMuted} style={styles.legendPlace}>
              {placeLabel(k, glance.meterKeys)}
            </T>
            <T variant="small" color={colors.textPrimary} style={styles.grow} numberOfLines={1}>
              {k.name}
            </T>
            <T variant="small" color={colors.textMuted}>
              {roomWord(k)}
            </T>
          </View>
        ))}
      </View>
      <SameNotes glance={glance} />
      {glance.signInChanged && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {glance.signInChanged.text}
          </T>
          <T variant="caption" color={colors.textMuted}>
            {ADD_ON_MAC}
          </T>
        </View>
      )}
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
export function KeyCard({ k, all = [] }: { k: StackKey; all?: readonly StackKey[] }) {
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
            {placeLabel(k, all)}
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
            {l.countdown && (
              <T variant="caption" color={colors.textSecondary}>
                ⟳ {l.countdown}
              </T>
            )}
          </View>
          <T
            variant="title"
            color={l.tone === 'warning' ? colors.accentWarning : colors.textStrong}
          >
            {l.left}%
            <T variant="small" color={colors.textMuted}>
              {' '}
              left
            </T>
          </T>
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
            {l.evenLeft !== undefined && (
              // Where it would stand at an even pace through the window.
              <View
                style={[
                  styles.even,
                  {
                    left: `${l.evenLeft}%`,
                    // Light on the fill, dark on the empty track: seen either way.
                    backgroundColor: l.evenLeft < l.left ? colors.surfaceApp : colors.textSecondary,
                  },
                ]}
              />
            )}
          </View>
          {l.paceWord && (
            <T variant="small" color={colors.textSecondary}>
              {l.paceWord}
            </T>
          )}
          {l.resetsAt && (
            <T variant="caption" color={colors.textMuted}>
              Refills {l.resetsAt}
            </T>
          )}
          {l.pace && (
            // An estimate: secondary ink, with a small mark only when little is left.
            <View style={styles.pace}>
              {l.left <= LOW_LEFT && (
                <Icon
                  name="exclamationmark.triangle"
                  size={iconSize.inline}
                  color={colors.accentWarning}
                />
              )}
              <T variant="caption" color={colors.textSecondary} style={styles.grow}>
                {l.runOut ? l.pace.basis : `${l.pace.text} · ${l.pace.basis}`}
              </T>
            </View>
          )}
        </View>
      ))}
      {k.fix && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {k.fix.text}{' '}
            {k.fix.action === 'sign_in_other'
              ? `${SIGN_IN_DIFFERENT}${k.thisMac ? '' : ', or remove it,'} on your Mac: Agents → Usage.`
              : 'On your Mac: Agents → Usage.'}
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
  legend: { gap: space['2xs'] },
  legendRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  legendPlace: { minWidth: space.md },
  grow: { flex: 1, minWidth: 0 },
  pace: { flexDirection: 'row', alignItems: 'center', gap: space['2xs'] },
  row: { gap: space['2xs'] },
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
    minWidth: space.xl,
    paddingHorizontal: space['2xs'],
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
  even: { position: 'absolute', top: 0, bottom: 0, width: space['3xs'] },
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
