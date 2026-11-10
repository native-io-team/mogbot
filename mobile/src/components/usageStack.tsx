/**
 * Usage on the phone, as the desk's sidebar row and Usage view say it
 * (`companion-protocol/usageGlance`): the total first, the room across every
 * account ("72% left across 2 accounts"), one bar made of a segment per
 * account with the roomiest first, then each account as a row that opens
 * its own screen (`KeyCard`): its limits, who used it this week and "Where
 * did my usage go". `GlanceRow` is the Agents list's line, the desk
 * sidebar's row on the phone.
 *
 * An estimate (a pace line, "Runs out ~Thu") is secondary ink: amber means
 * "needs you", and only nearly out is that.
 *
 * Only what the Mac served: an account with no reading is an empty, outlined
 * segment, never a full one, and never counted as room; a second sign-in of
 * the same account adds nothing and says why. Reordering and "Use this one
 * now" stay in Settings → Accounts; adding and signing in happen on the Mac.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  ADD_ON_MAC,
  LOW_LEFT,
  OUT_OF_USAGE,
  SIGN_IN_DIFFERENT,
  type AgentEngine,
  type StackKey,
  type UsageGlance,
  type UsageTotal,
} from '@shipstudio/companion-protocol';
import { makeStyles, useColors } from '../lib/appearance';
import { depthOf, iconSize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { Icon, StatusPill, T } from './ui';

const fillOf = (colors: Palette, tone: StackKey['tone']) =>
  tone === 'warning' ? colors.accentWarning : colors.textPrimary;

const pillOf = (k: Pick<StackKey, 'state'>) =>
  k.state === 'in_use'
    ? 'done'
    : k.state === 'out'
      ? 'out'
      : k.state === 'same'
        ? 'waiting'
        : 'idle';

/** What an account adds, in a row's words. */
function roomWords(k: StackKey): string {
  if (k.state === 'same') return 'Adds no room';
  if (k.state === 'off') return '';
  if (k.share === null) return 'Not read yet';
  return `${k.share}% left`;
}

/** The total as one bar: a segment per account, most room first. */
export function TotalBar({ total, tall = false }: { total: UsageTotal; tall?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const words = total.segments.map((s) => s.words).join('; ');
  return (
    <View style={styles.track} accessible accessibilityLabel={`Room left. ${words}`}>
      {total.segments.map((s) => (
        <View
          key={s.key}
          style={[styles.seg, tall && styles.segTall, s.left === null && styles.segEmpty]}
        >
          {s.left !== null && (
            <View
              style={[
                styles.fill,
                { width: `${s.left}%`, backgroundColor: fillOf(colors, s.tone) },
              ]}
            />
          )}
        </View>
      ))}
    </View>
  );
}

/** Each account signed in twice, one line each, under the bar. */
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
 * The Agents list's usage line, as the desk sidebar's row says it: the total
 * ("72% left · 2 accounts"), the total bar and "Refills in 2d 4h". Amber
 * only when the user must act. Opens Usage.
 */
export function GlanceRow({ glance, onPress }: { glance: UsageGlance; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  if (glance.keys.length === 0) return null;
  const { row } = glance;
  const count = glance.total.left !== null ? row.count : null;
  const label = `Usage: ${[row.figure, count, row.refill].filter(Boolean).join('. ')}`;
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
        {count && (
          <T variant="small" color={colors.textMuted}>
            {' '}
            · {count}
          </T>
        )}
      </T>
      {glance.total.segments.length > 0 && <TotalBar total={glance.total} />}
      {!!row.refill && (
        <T variant="caption" color={colors.textMuted} numberOfLines={1}>
          {row.refill}
        </T>
      )}
    </Pressable>
  );
}

/**
 * The total first: what is left across every account, of what, and when it
 * next refills; the bar, most room first, with each account named under its
 * segment (a tap opens it); then what needs saying.
 */
export function TotalCard({
  glance,
  onOpen,
}: {
  glance: UsageGlance;
  onOpen?: (engine: AgentEngine, id: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  if (glance.keys.length === 0) return null;
  const { total } = glance;
  const out = glance.tone === 'limited';
  const known = total.left !== null && !out;
  const figure = known ? total.figure : glance.unread ? glance.headline : glance.row.figure;
  const refill = out
    ? glance.row.refill
    : total.refill
      ? `Next refill in ${total.refill.in}${total.counted > 1 ? ` · ${total.refill.account}` : ''}`
      : null;
  return (
    <View style={styles.card}>
      <View style={styles.answer}>
        <T variant="caption" color={colors.textMuted}>
          {total.counted > 1 ? 'All accounts' : 'Usage'}
        </T>
        <T
          variant={known ? 'display' : 'title'}
          color={
            glance.tone === 'warning'
              ? colors.accentWarning
              : known
                ? colors.textStrong
                : colors.textSecondary
          }
        >
          {figure}
        </T>
        {known && !!total.across && (
          <T variant="small" color={colors.textSecondary}>
            {total.across}
          </T>
        )}
        {refill && (
          <T variant="small" color={colors.textSecondary}>
            {refill}
          </T>
        )}
      </View>
      <TotalBar total={total} tall />
      {/* Under the bar, in the same order, one account a line: a tap opens it. */}
      <View style={styles.legend}>
        {total.segments.map((s) => (
          <Pressable
            key={s.key}
            accessibilityRole={onOpen ? 'button' : undefined}
            accessibilityLabel={s.words}
            disabled={!onOpen}
            onPress={() => onOpen?.(s.engine, s.id)}
            style={({ pressed }) => [styles.legendRow, pressed && PRESSED]}
          >
            <T variant="small" color={colors.textPrimary} style={styles.grow} numberOfLines={1}>
              {s.name}
            </T>
            <T variant="small" color={colors.textSecondary} style={styles.figure}>
              {s.left === null ? 'Not read yet' : `${s.left}% left`}
            </T>
            {s.refill && (
              <View style={styles.chip}>
                <T variant="caption" color={colors.textSecondary}>
                  ⟳ {s.refill}
                </T>
              </View>
            )}
          </Pressable>
        ))}
      </View>
      {(glance.estimate || total.unread || glance.sameNotes.length > 0) && (
        <View style={styles.notes}>
          {glance.estimate && (
            <T variant="caption" color={colors.textMuted}>
              {glance.headline}. {glance.estimate}: an estimate, not a reading.
            </T>
          )}
          {total.unread && (
            <T variant="caption" color={colors.textMuted}>
              {total.unread}.
            </T>
          )}
          <SameNotes glance={glance} />
        </View>
      )}
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

/** Every account as one row in turn order, in one grouped card; a tap opens its screen. */
export function AccountRows({ keys, onOpen }: { keys: StackKey[]; onOpen: (k: StackKey) => void }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.rows}>
      {keys.map((k, i) => {
        const refill = k.refillLimit?.countdown;
        const room = roomWords(k);
        return (
          <Pressable
            key={k.key}
            accessibilityRole="button"
            accessibilityLabel={`${k.position}. ${k.name}, ${room ? `${room}, ` : ''}${k.stateLabel}${
              refill ? `, refills in ${refill}` : ''
            }`}
            onPress={() => onOpen(k)}
            style={({ pressed }) => [
              styles.accountRow,
              i > 0 && styles.divided,
              pressed && PRESSED,
            ]}
          >
            <View style={[styles.cap, k.state === 'in_use' && styles.capOn]}>
              <T
                variant="caption"
                color={k.state === 'in_use' ? colors.surfaceApp : colors.textPrimary}
              >
                {String(k.position)}
              </T>
            </View>
            <View style={styles.rowBody}>
              <View style={styles.rowLine}>
                <T
                  variant="headline"
                  color={colors.textStrong}
                  style={styles.grow}
                  numberOfLines={1}
                >
                  {k.name}
                </T>
                {!!room && (
                  <T variant="small" color={colors.textPrimary} style={styles.figure}>
                    {room}
                  </T>
                )}
              </View>
              <View style={[styles.miniBar, k.share === null && styles.segEmpty]}>
                {k.share !== null && (
                  <View
                    style={[
                      styles.fill,
                      { width: `${k.share}%`, backgroundColor: fillOf(colors, k.tone) },
                    ]}
                  />
                )}
              </View>
              <View style={styles.rowLine}>
                <StatusPill
                  tone={pillOf(k)}
                  label={k.state === 'out' ? OUT_OF_USAGE : k.stateLabel}
                />
                <View style={styles.grow} />
                {refill && (
                  <T variant="caption" color={colors.textSecondary}>
                    ⟳ {refill}
                  </T>
                )}
              </View>
            </View>
            <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
          </Pressable>
        );
      })}
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
      {k.agents.length > 0 && (
        // Who used it: agent, tokens, turns, in aligned columns.
        <View style={styles.table} accessibilityLabel={`Who used ${k.name} this week`}>
          <View style={styles.tableRow}>
            <T variant="caption" color={colors.textMuted} style={styles.grow}>
              Used by these agents this week
            </T>
            <T variant="caption" color={colors.textMuted} style={styles.num}>
              Tokens
            </T>
            <T variant="caption" color={colors.textMuted} style={styles.numNarrow}>
              Messages
            </T>
          </View>
          {k.agents.map((a) => (
            <View key={a.key} style={[styles.tableRow, styles.tableLine]}>
              <T variant="small" color={colors.textPrimary} style={styles.grow} numberOfLines={1}>
                {a.name}
              </T>
              <T variant="small" color={colors.textSecondary} style={styles.num}>
                {a.tokensText}
              </T>
              <T variant="small" color={colors.textSecondary} style={styles.numNarrow}>
                {String(a.turns)}
              </T>
            </View>
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
  track: { flexDirection: 'row', gap: space['2xs'] },
  answer: { gap: space.xs },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: space['2xl'],
  },
  figure: { fontVariant: ['tabular-nums'] },
  chip: {
    paddingHorizontal: space.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
  },
  notes: { gap: space.xs },
  rows: {
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
    overflow: 'hidden',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  rowBody: { flex: 1, minWidth: 0, gap: space.sm },
  rowLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  miniBar: {
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  table: { gap: space['2xs'] },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tableLine: {
    paddingVertical: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  num: { width: space['2xl'] * 1.5, textAlign: 'right', fontVariant: ['tabular-nums'] },
  numNarrow: { width: space['2xl'], textAlign: 'right', fontVariant: ['tabular-nums'] },
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
  legend: { gap: space['3xs'] },
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
  even: { position: 'absolute', top: 0, bottom: 0, width: space['3xs'] },
  low: {
    gap: space['2xs'],
    padding: space.md,
    borderRadius: radius.inner,
    backgroundColor: colors.surfaceControl,
  },
  change: {
    gap: space['3xs'],
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
}));
