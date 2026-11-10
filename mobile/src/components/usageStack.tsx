/**
 * Usage on the phone, as the desk's sidebar row and Usage view say it
 * (`companion-protocol/usageGlance`): the total first, the room across every
 * account ("72% left across 2 accounts"), one bar made of a segment per
 * account in the work order, then each account as a row that opens
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
 * now" are on an account's page; adding and signing in happen on the Mac.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  ADD_ON_MAC,
  LOW_LEFT,
  OUT_OF_USAGE,
  pinnedLine,
  placeLabel,
  SIGN_IN_DIFFERENT,
  USE_THIS_ONE_NOW,
  type KeyLimit,
  type StackKey,
  type UsageGlance,
  type UsageTotal,
  totalWords,
} from '@shipstudio/companion-protocol';
import { makeStyles, useColors, useLargeText } from '../lib/appearance';
import { depthOf, iconSize, keySize, PRESSED, radius, space, type Palette } from '../lib/theme';
import { AgentKey } from './AgentKey';
import { Button, Icon, IconButton, Segmented, StatusPill, T } from './ui';

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

/** The total as one bar: a segment per account, in the work order. */
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

/** When a limit refills, as the desk's chip: a refill mark and the countdown. */
export function RefillChip({ text, label }: { text: string; label?: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View
      style={styles.chip}
      accessible={!!label}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    >
      <Icon
        name="arrow.clockwise"
        size={iconSize.micro}
        color={colors.textSecondary}
        fallback={
          <T variant="caption" color={colors.textSecondary}>
            ⟳
          </T>
        }
      />
      <T
        variant="caption"
        color={colors.textSecondary}
        numberOfLines={1}
        maxFontSizeMultiplier={CHIP_SCALE}
        style={styles.figure}
      >
        {text}
      </T>
    </View>
  );
}

/** A chip's words grow with Dynamic Type only so far: they sit on a line with a figure. */
const CHIP_SCALE = 1.6;

/**
 * The Agents list's usage glance, as the desk sidebar's row says it, as one
 * compact card: "Usage", the total across every account ("72% left · 2
 * accounts", `usageGlance.total`, never the account in use), the next refill
 * as a chip, and the total bar under it, a segment per account in the work
 * order. Amber only when the user must act. Opens Usage.
 */
export function GlanceRow({ glance, onPress }: { glance: UsageGlance; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  if (glance.keys.length === 0) return null;
  const { row, total } = glance;
  const count = total.left !== null ? row.count : null;
  // Out everywhere, the refill is a moment ("Refills Sat 10:00 AM"); otherwise a countdown.
  const out = glance.tone === 'limited';
  const chip = out ? row.refill : total.refill ? total.refill.in : null;
  const label = `Usage: ${[row.figure, count, row.refill].filter(Boolean).join('. ')}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Every account, its limits and where its usage went"
      onPress={onPress}
      style={({ pressed }) => [styles.glance, pressed && PRESSED]}
    >
      <View style={styles.glanceHead}>
        <View style={styles.grow}>
          <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={CHIP_SCALE}>
            Usage
          </T>
          <T
            variant="headline"
            color={row.needsYou ? colors.accentWarning : colors.textStrong}
            numberOfLines={1}
          >
            {row.figure}
            {count && (
              <T variant="small" color={colors.textMuted}>
                {' '}
                · {count}
              </T>
            )}
          </T>
        </View>
        {!!chip && <RefillChip text={chip} />}
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      </View>
      {total.segments.length > 0 && <TotalBar total={total} />}
    </Pressable>
  );
}

/**
 * The total first: what is left across every account, of what, and when it
 * next refills (`totalWords`, as the desk's hero and the chat's popover say
 * it); the bar, in the work order; then what needs saying. The accounts'
 * names and room are the rows right under this card, so it doesn't list them.
 */
export function TotalCard({
  glance,
  spendHere = false,
}: {
  glance: UsageGlance;
  /** "Give agents something to do" is on this screen (a Mac that takes it from the phone). */
  spendHere?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  // At accessibility sizes: "across 2 Max accounts" its own line (nested, it took
  // the display figure's line height).
  const large = useLargeText();
  if (glance.keys.length === 0) return null;
  const { total } = glance;
  const words = totalWords(glance);
  return (
    <View style={[styles.card, styles.hero]}>
      <View style={styles.answer}>
        <T variant="caption" color={colors.textMuted}>
          {words.eyebrow ?? 'Usage'}
        </T>
        {/* "72% left across 2 Max accounts": the figure, and of what, as one headline. */}
        <T
          variant={words.known ? 'display' : 'title'}
          accessibilityRole="header"
          color={
            glance.tone === 'warning'
              ? colors.accentWarning
              : words.known
                ? colors.textStrong
                : colors.textSecondary
          }
        >
          {words.figure}
          {words.across && !large && (
            <>
              {' '}
              <T variant="subhead" color={colors.textSecondary}>
                {words.across}
              </T>
            </>
          )}
        </T>
        {words.across && large && (
          <T variant="subhead" color={colors.textSecondary}>
            {words.across}
          </T>
        )}
        {words.refill && (
          <T variant="small" color={colors.textSecondary}>
            {words.refill}
          </T>
        )}
      </View>
      <TotalBar total={total} tall />
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
              {spendHere
                ? 'Ask your Chief of Staff to start it, or press Give agents something to do below.'
                : 'Ask your Chief of Staff to start it, or press Give agents something to do on your Mac.'}
            </T>
          )}
        </View>
      )}
    </View>
  );
}

/** Every account as one row in turn order, in one grouped card; a tap opens its screen. */
export function AccountRows({
  keys,
  onOpen,
  all = keys,
}: {
  keys: StackKey[];
  onOpen: (k: StackKey) => void;
  /** Every account listed (across engines), so a place names its engine when both are there. */
  all?: readonly StackKey[];
}) {
  const colors = useColors();
  const styles = useStyles();
  const large = useLargeText();
  return (
    <View style={styles.rows}>
      {keys.map((k, i) => {
        const refill = k.refillLimit?.countdown;
        const room = roomWords(k);
        return (
          <Pressable
            key={k.key}
            accessibilityRole="button"
            accessibilityLabel={`${placeLabel(k, all)}. ${k.name}, ${room ? `${room}, ` : ''}${k.stateLabel}${
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
                {placeLabel(k, all)}
              </T>
            </View>
            <View style={styles.rowBody}>
              <View style={[styles.rowLine, large && styles.wrapRow]}>
                <T
                  variant="headline"
                  color={colors.textStrong}
                  style={large ? styles.wholeLine : styles.grow}
                  numberOfLines={large ? undefined : 1}
                >
                  {k.name}
                </T>
                {!!room && (
                  <T variant="small" color={colors.textPrimary} style={styles.figure}>
                    {room}
                  </T>
                )}
              </View>
              {/* What tells it apart, as the desk's row: its plan first. */}
              {k.detail.length > 0 && (
                <T variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {k.detail[0]}
                </T>
              )}
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
                {refill && <RefillChip text={refill} />}
              </View>
            </View>
            <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** What can be done with an account from its screen, when the Mac takes it. */
export interface KeyActions {
  /** "Use this one now": absent when it can't be (in use, out, the Mac doesn't take it). */
  onUse?: () => void;
  /** One place earlier or later in the order; absent at that end. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** A change is on its way: nothing else is taken until it lands. */
  busy?: boolean;
}

/**
 * One account, as the desk's account page (`AccountDetail`): its place,
 * state and what tells it apart, with "Use this one now" and its place in
 * the order; its fix; its limits each as a card against pace, or who used it
 * (Limits | Tokens); and where its usage went. Its name is the screen's title.
 */
export function KeyCard({
  k,
  actions = {},
  all = [],
}: {
  k: StackKey;
  actions?: KeyActions;
  /** Every account listed, so its place names its engine when both are there ("Claude 2"). */
  all?: readonly StackKey[];
}) {
  const colors = useColors();
  const styles = useStyles();
  const [view, setView] = useState<'limits' | 'tokens'>('limits');
  const pinned = pinnedLine(k.pinnedBy);
  const tokens = view === 'tokens' && k.agents.length > 0;
  const moves = !!actions.onMoveUp || !!actions.onMoveDown;
  return (
    <View style={styles.detail}>
      <View style={[styles.card, (k.state === 'same' || k.state === 'off') && styles.cardQuiet]}>
        <View style={styles.head}>
          <View style={[styles.cap, styles.capLarge, k.state === 'in_use' && styles.capOn]}>
            <T
              variant="headline"
              color={k.state === 'in_use' ? colors.surfaceApp : colors.textPrimary}
              maxFontSizeMultiplier={CHIP_SCALE}
            >
              {placeLabel(k, all)}
            </T>
          </View>
          <View style={styles.title}>
            <StatusPill tone={pillOf(k)} label={k.stateLabel} />
            <T variant="small" color={colors.textMuted}>
              {[`${ordinal(k.position)} in the order`, ...k.detail].join(' · ')}
            </T>
          </View>
          {moves && (
            // Its place in the order, as the desk's Move up / Move down.
            <View style={styles.actions}>
              {actions.onMoveUp && (
                <IconButton
                  name="arrow.up"
                  size={iconSize.body}
                  label={`Try ${k.name} earlier`}
                  disabled={actions.busy}
                  onPress={actions.onMoveUp}
                />
              )}
              {actions.onMoveDown && (
                <IconButton
                  name="arrow.down"
                  size={iconSize.body}
                  label={`Try ${k.name} later`}
                  disabled={actions.busy}
                  onPress={actions.onMoveDown}
                />
              )}
            </View>
          )}
        </View>
        {actions.onUse && (
          <Button
            title={USE_THIS_ONE_NOW}
            variant="secondary"
            disabled={actions.busy}
            accessibilityLabel={`Use ${k.name} now`}
            onPress={actions.onUse}
          />
        )}
      </View>

      {k.fix && (
        <View style={styles.low}>
          <T variant="small" color={colors.textPrimary}>
            {k.fix.text}
          </T>
          <T variant="caption" color={colors.textMuted}>
            {k.fix.action === 'sign_in_other'
              ? `${SIGN_IN_DIFFERENT}${k.thisMac ? '' : ', or remove it,'} on your Mac: Agents → Usage.`
              : 'On your Mac: Agents → Usage.'}
          </T>
        </View>
      )}
      {!!pinned && (
        <T variant="small" color={colors.textMuted}>
          {pinned}
        </T>
      )}

      {k.state !== 'same' && k.signedIn && (
        <View style={styles.part}>
          {/* The section's name, and Limits | Tokens at its right, as the desk's. */}
          <View style={styles.partHead}>
            <T
              variant="headline"
              color={colors.textStrong}
              accessibilityRole="header"
              numberOfLines={1}
              style={styles.grow}
            >
              {/* One line either way: a long Tokens title wrapped beside the
                  switch and the page jumped each time it was flipped. */}
              {tokens ? 'This week' : 'Limits'}
            </T>
            {k.agents.length > 0 && (
              <View style={styles.switch}>
                <Segmented
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'limits', label: 'Limits' },
                    { value: 'tokens', label: 'Tokens' },
                  ]}
                />
              </View>
            )}
          </View>
          {tokens ? (
            <AgentsTable k={k} />
          ) : k.limits.length > 0 ? (
            k.limits.map((l) => <LimitCard key={l.key} limit={l} />)
          ) : (
            <T variant="small" color={colors.textMuted}>
              {k.state === 'out'
                ? k.stateLabel
                : 'Your usage shows here after an agent’s first reply.'}
            </T>
          )}
        </View>
      )}

      {k.changes.length > 0 && (
        <View style={styles.part}>
          <T variant="headline" color={colors.textStrong} accessibilityRole="header">
            Where it went
          </T>
          <View style={styles.card}>
            {k.changes.map((c, i) => (
              <View key={c.key} style={[styles.change, i > 0 && styles.changeNext]}>
                <T variant="small" color={colors.textStrong}>
                  {c.title}
                </T>
                <T variant="caption" color={colors.textMuted}>
                  {c.when}
                </T>
                {c.runs.map((r) => (
                  <T key={r} variant="small" color={colors.textSecondary}>
                    {r}
                  </T>
                ))}
                {c.elsewhere && (
                  <T variant="small" color={colors.textSecondary}>
                    {c.elsewhere}
                  </T>
                )}
              </View>
            ))}
          </View>
          <T variant="caption" color={colors.textMuted}>
            Each task shows the tokens Claude Code or Codex reported; a rise isn’t divided between
            tasks. Use of the same plan outside these agents counts too.
          </T>
        </View>
      )}
    </View>
  );
}

/**
 * A bar of what is left against the pace marker: where it would stand had
 * it been spent evenly through the window. Left of the marker is ahead of
 * pace; right of it, room to spare.
 */
function PaceBar({ limit: l }: { limit: KeyLimit }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View
      style={styles.bar}
      accessibilityRole="progressbar"
      accessibilityLabel={`${l.label} limit left`}
      accessibilityValue={{ min: 0, max: 100, now: l.left }}
    >
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
  );
}

/**
 * One limit as a card, as the desk's: its name and countdown chip, the big
 * figure, the pace-marked bar, the Mac's run-out estimate marked between now
 * and the refill (said as one), what that means in words, and when it refills.
 */
function LimitCard({ limit: l }: { limit: KeyLimit }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={[styles.card, styles.limit]}>
      <View style={styles.limitHead}>
        <T variant="small" color={colors.textSecondary} style={styles.grow}>
          {l.label}
        </T>
        {l.countdown && (
          <RefillChip
            text={l.countdown}
            label={l.resetsAt ? `Refills ${l.resetsAt}` : `Refills in ${l.countdown}`}
          />
        )}
      </View>
      <T variant="display" color={l.tone === 'warning' ? colors.accentWarning : colors.textStrong}>
        {l.left}%
        <T variant="small" color={colors.textMuted}>
          {' '}
          left
        </T>
      </T>
      <PaceBar limit={l} />
      {l.runOut && (
        <View accessible accessibilityLabel={`${l.runOut.text}, an estimate`}>
          <View style={styles.timeline}>
            <View style={[styles.timelineMark, { left: `${Math.round(l.runOut.along * 100)}%` }]} />
          </View>
          <View style={styles.timelineEnds} importantForAccessibility="no-hide-descendants">
            <T variant="caption" color={colors.textMuted}>
              Now
            </T>
            <T
              variant="caption"
              color={colors.textSecondary}
              style={styles.timelineMid}
              numberOfLines={2}
            >
              {l.runOut.text} · estimate
            </T>
            <T variant="caption" color={colors.textMuted}>
              Refills
            </T>
          </View>
        </View>
      )}
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
        // An estimate: secondary ink, never amber; a small mark only when little is left.
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
  );
}

/** Who used this account this week: agent key, name, its share, tokens, messages, aligned. */
function AgentsTable({ k }: { k: StackKey }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.card}>
      <View style={styles.table} accessibilityLabel={`Who used ${k.name} this week`}>
        <View style={styles.tableRow}>
          <T variant="caption" color={colors.textMuted} style={styles.grow}>
            Agent
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
            <View style={[styles.grow, styles.agentCell]}>
              <AgentKey id={a.agentId} name={a.name} size={keySize.sm} />
              <View style={styles.grow}>
                <T variant="small" color={colors.textPrimary} numberOfLines={1}>
                  {a.name}
                </T>
                <View
                  style={styles.share}
                  accessible
                  accessibilityLabel={`${a.share}% of its tokens`}
                >
                  <View style={[styles.fill, styles.shareFill, { width: `${a.share}%` }]} />
                </View>
              </View>
            </View>
            <T variant="small" color={colors.textSecondary} style={styles.num}>
              {a.tokensText}
            </T>
            <T variant="small" color={colors.textSecondary} style={styles.numNarrow}>
              {String(a.turns)}
            </T>
          </View>
        ))}
      </View>
      <T variant="caption" color={colors.textMuted}>
        Tokens as Claude Code or Codex reported them for what these agents did. Not a cost: your
        plan isn’t billed per token.
      </T>
    </View>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

const useStyles = makeStyles((colors) => ({
  track: { flexDirection: 'row', gap: space.xs },
  glance: {
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surfacePanel,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
  },
  glanceHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  answer: { gap: space.xs },
  hero: { gap: space.lg, padding: space.xl },
  figure: { fontVariant: ['tabular-nums'] },
  wrapRow: { flexWrap: 'wrap', rowGap: space['2xs'] },
  wholeLine: { flexBasis: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space['2xs'],
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
  numNarrow: { width: space['2xl'] * 2, textAlign: 'right', fontVariant: ['tabular-nums'] },
  seg: {
    flex: 1,
    height: space.tight,
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
  grow: { flex: 1, minWidth: 0 },
  pace: { flexDirection: 'row', alignItems: 'center', gap: space['2xs'] },
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
  limit: { gap: space.sm },
  limitHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  detail: { gap: space.xl },
  part: { gap: space.md },
  partHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  switch: { width: '50%' },
  actions: { flexDirection: 'row', alignItems: 'center', marginRight: -space.sm },
  capLarge: {
    minWidth: keySize.lg,
    height: keySize.lg,
    paddingHorizontal: space.sm,
    borderRadius: radius.inner,
  },
  timeline: {
    height: space['3xs'] * 2,
    marginTop: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.borderDefault,
  },
  timelineMark: {
    position: 'absolute',
    top: -space.xs / 2 - space['3xs'],
    width: space.sm,
    height: space.sm,
    marginLeft: -space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.textSecondary,
  },
  timelineEnds: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  timelineMid: { flex: 1, textAlign: 'center' },
  agentCell: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  share: {
    height: space['3xs'] * 2,
    marginTop: space['2xs'],
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  shareFill: { backgroundColor: colors.textMuted },
  changeNext: {
    marginTop: space.sm,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
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
  change: { gap: space['2xs'] },
}));
