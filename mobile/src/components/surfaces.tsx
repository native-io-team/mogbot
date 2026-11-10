/**
 * The three surfaces a conversation is built from, besides its messages, as
 * the desk draws them (`src/components/agents/AgentCard.tsx`, docs/agents.md
 * "Lines, cards and bars"). Everything that isn't something someone said is
 * one of these, so a chat with a request, a copy waiting to be kept and an
 * import going on at once still reads as one product.
 *
 * - **Line**: one quiet centred sentence, no surface, that wraps (never cut:
 *   the cut half is usually the reassuring part). Something that happened, a
 *   time between messages, with at most one text action.
 * - **Card**: something that wants a decision or holds a result. Icon and
 *   title (a quiet meta at the right), a muted source line, the body, a muted
 *   note, then the actions right-aligned with the single affirmative last.
 * - **Bar**: the state of this conversation until it ends (you're driving it
 *   on the Mac, an import is going, the message being written asks for
 *   changes, the Mac is out of reach), directly above the composer, in a
 *   fixed order, at most two at a time (`lib/bars.ts`).
 *
 * The actions follow the desk's rules: the affirmative answer (Allow, Save,
 * Keep changes) is the neutral `answer` button, never the agent's colour;
 * the rest are `outline`; `danger` only for what destroys work.
 */

import { useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
  Platform,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { makeStyles, useColors, useTextScale } from '../lib/appearance';
import { BAR_ORDER, MAX_BARS, type BarId, type BarTone } from '../lib/bars';
import { TypingDots } from './TypingDots';
import {
  CARD_TITLE_SCALE,
  chromeScale,
  depthOf,
  fonts,
  iconSize,
  lineHeight,
  radius,
  space,
  type,
  type Palette,
} from '../lib/theme';
import type { SFName } from '../lib/icons';
import { DISABLED_OPACITY, Dot, Icon, T, tap, useRipple } from './ui';

/**
 * A card glides to its new size as it folds. Not on the web (QA only):
 * there a layout glide is measured on the screen, so a card in the inverted
 * chat also slid whenever a row arrived below it, the wrong way, over the
 * new row. On the phone it's measured within the card's parent.
 */
const CARD_GLIDE = Platform.OS === 'web' ? undefined : LinearTransition.duration(220);

/** What the card's icon is tinted with: muted by default, warning only for real risk. */
export type CardTone = 'warning' | 'error';

export function Card({
  icon,
  tone,
  title,
  meta,
  source,
  note,
  actions,
  children,
  hideHead = false,
  quiet = false,
  onLayout,
  onHeadLayout,
  style,
  testID,
  accessibilityLabel,
}: {
  /** Semantic: a shield for a request, a lock for a key, a folder for a copy. */
  icon: SFName;
  tone?: CardTone;
  title: string;
  /** Quiet, at the right of the title ("v2"). */
  meta?: string;
  /** Muted line under the title: whose, and where ("Acme Site · in acme-site"). */
  source?: string;
  /** Muted consequence line, before the actions. */
  note?: ReactNode;
  /** Right-aligned; the caller puts the single affirmative last. */
  actions?: ReactNode;
  children?: ReactNode;
  /** The chat pins the question above the list: the card leaves its head out. */
  hideHead?: boolean;
  /**
   * An offer, not a gate (a skill card: nothing waits on it): no raised
   * sheet, a faint hairline, its title a step quieter. As the desk's
   * `.agent-approval[data-offer]`.
   */
  quiet?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  onHeadLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const styles = useCardStyles();
  const tint =
    tone === 'warning'
      ? colors.accentWarning
      : tone === 'error'
        ? colors.accentErrorLight
        : colors.textMuted;
  return (
    <Animated.View
      layout={CARD_GLIDE}
      onLayout={onLayout}
      style={[styles.card, quiet && styles.cardQuiet, style]}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      {!hideHead && (
        <View onLayout={onHeadLayout} style={styles.head} testID="card-head">
          <View style={styles.titleRow}>
            <View style={styles.icon}>
              <Icon name={icon} size={iconSize.body} color={tint} />
            </View>
            <T
              variant="headline"
              color={quiet ? colors.textSecondary : colors.textStrong}
              maxFontSizeMultiplier={CARD_TITLE_SCALE}
              accessibilityRole="header"
              style={{ flex: 1 }}
            >
              {title}
            </T>
            {!!meta && (
              <T
                variant="caption"
                color={colors.textMuted}
                maxFontSizeMultiplier={chromeScale}
                style={styles.meta}
              >
                {meta}
              </T>
            )}
          </View>
          {!!source && (
            <T
              variant="small"
              color={colors.textMuted}
              maxFontSizeMultiplier={CARD_TITLE_SCALE}
              testID="card-source"
            >
              {source}
            </T>
          )}
        </View>
      )}
      {children}
      {note ? (
        typeof note === 'string' ? (
          <T
            variant="small"
            color={colors.textMuted}
            maxFontSizeMultiplier={CARD_TITLE_SCALE}
            testID="card-note"
          >
            {note}
          </T>
        ) : (
          <View testID="card-note">{note}</View>
        )
      ) : null}
      {actions ? <CardActions>{actions}</CardActions> : null}
    </Animated.View>
  );
}

/** A card's answers: right-aligned, wrapping when they can't share a row. */
export function CardActions({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useCardStyles();
  return (
    <View style={[styles.actions, style]} testID="card-actions">
      {children}
    </View>
  );
}

/** A button sharing a card's answer row: an even share of it, never under 44pt. */
export const ACTION = { flexGrow: 1, flexBasis: 96 } as const;
/** An action that takes the row to itself, above the answers (Ask for changes beside a copy). */
export const ACTION_ROW = { flexGrow: 1, flexBasis: '100%' } as const;
/** Two to a row: a third answer wraps under them and takes the row (Copy code · Open GitHub / Cancel). */
export const ACTION_PAIR = { flexGrow: 1, flexBasis: '40%' } as const;

/**
 * A card's inner width on this phone: the screen less the chat's gutter and
 * the card's own padding, each side. Sheets are no narrower.
 */
const CARD_INSET = space.lg * 2 + space.lg * 2 + space.xs;
/**
 * A semibold label's average glyph, in ems: a little over the measured
 * ("Connect Linear" is 122pt at 16), so a near miss wraps rather than cuts.
 */
const LABEL_EM = 0.55;

/** How wide a button needs to be to say `title` whole, at a text size. */
export function actionWidth(title: string, fontSize: number): number {
  return Math.ceil(title.length * fontSize * LABEL_EM) + space.lg * 2 + 2;
}

/**
 * How a card's answers share their row, from what they say and the text size
 * in force: an even share each when every label fits whole; two to a row when
 * three can't share one; one to a row when even two can't. Never a cut label
 * ("Copy co…", "Open Gi…"), at any text size. `reserve` is room already taken
 * in the row (the 44pt ⋯ beside Deny and Allow).
 */
export function actionShare(
  titles: readonly string[],
  rowWidth: number,
  fontSize: number,
  reserve = 0
): ViewStyle {
  const n = titles.length;
  if (n === 0) return ACTION;
  const need = Math.max(...titles.map((t) => actionWidth(t, fontSize)));
  const fits = (k: number, room: number) => k * need + (k - 1) * space.sm <= room;
  if (fits(n, rowWidth - (reserve ? reserve + space.sm : 0))) return ACTION;
  if (n >= 3 && fits(2, rowWidth)) return ACTION_PAIR;
  return ACTION_ROW;
}

/** `actionShare` for this phone's width and text size: the style each answer in the row takes. */
export function useActionShare(titles: readonly string[], reserve = 0): ViewStyle {
  const { width, fontScale } = useWindowDimensions();
  useTextScale(); // re-render when Settings → Text size changes `type`
  const fontSize = type.subhead * Math.min(fontScale || 1, chromeScale);
  return actionShare(titles, width - CARD_INSET, fontSize, reserve);
}

/**
 * The one sentence every card offline carries in its note slot, with its
 * answers still drawn and disabled: a card keeps its shape when the Mac goes.
 */
export const OFFLINE_NOTE = 'Answer it once your Mac is back. It stays open until then.';

/**
 * One quiet centred sentence: a note, where a new conversation began, a time
 * between messages, an answered card's outcome, a task that started. Wraps
 * (never cut); at most one text action. It can open something (`onPress`,
 * with a chevron) or unfold what it was about in place (`detail`).
 */
export function Line({
  text,
  lead,
  icon,
  tone,
  action,
  onPress,
  pressHint,
  detail,
  trail,
  header = false,
  testID,
}: {
  text: string;
  /** A first word set off from the rest, in the line's tone ("Allowed · …"). */
  lead?: string;
  icon?: SFName;
  /**
   * `warning`: a failure that's still a line (a usage limit is not an error).
   * `success`: only the icon and the lead word take it ("✓ Allowed").
   */
  tone?: 'warning' | 'success';
  action?: { label: string; onPress: () => void; hint?: string };
  /** The whole line opens something (a task, a diff). */
  onPress?: () => void;
  pressHint?: string;
  /** What it was about, unfolded under the line by a tap. */
  detail?: ReactNode;
  /** Inline after the words (a diff's +/− counts). */
  trail?: ReactNode;
  /** A time between messages: a header to VoiceOver, so it can jump by them. */
  header?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useLineStyles();
  const [open, setOpen] = useState(false);
  const ink = tone === 'warning' ? colors.accentWarning : colors.textMuted;
  const mark =
    tone === 'success' ? colors.accentSuccess : tone === 'warning' ? colors.accentWarning : ink;
  const label = lead ? `${lead}. ${text}` : text;
  const press = detail
    ? () => {
        tap();
        setOpen((o) => !o);
      }
    : onPress;
  const chevron = detail
    ? open
      ? 'chevron.down'
      : 'chevron.right'
    : onPress
      ? 'chevron.right'
      : null;
  const words = (
    <View style={styles.lineText}>
      {icon && <Icon name={icon} size={iconSize.inline} color={mark} />}
      <T
        variant="caption"
        color={ink}
        maxFontSizeMultiplier={header ? chromeScale : CARD_TITLE_SCALE}
        style={styles.lineWords}
      >
        {!!lead && (
          <T variant="caption" color={mark} style={{ fontFamily: fonts.medium }}>
            {lead}
            {' · '}
          </T>
        )}
        {text}
        {trail}
      </T>
      {chevron && <Icon name={chevron} size={iconSize.inline} color={colors.textMuted} />}
    </View>
  );
  const hint =
    pressHint ?? (detail ? (open ? 'Hides the detail' : 'Shows what it was about') : undefined);
  return (
    <View style={styles.line} testID={testID ?? 'line'}>
      {press ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={detail ? { expanded: open } : undefined}
          accessibilityHint={hint}
          hitSlop={{ top: 10, bottom: 10 }}
          onPress={press}
          style={({ pressed }) => [styles.linePress, pressed && { opacity: 0.6 }]}
        >
          {words}
        </Pressable>
      ) : (
        <View
          style={styles.linePress}
          accessible
          accessibilityLabel={label}
          accessibilityRole={header ? 'header' : 'text'}
        >
          {words}
        </View>
      )}
      {open && !!detail && (
        <Animated.View entering={FadeIn.duration(150)} style={styles.lineDetail}>
          {detail}
        </Animated.View>
      )}
      {action && <TextAction {...action} />}
    </View>
  );
}

/** A word you can tap in a line or a bar: small to see, 44pt to hit. */
export function TextAction({
  label,
  onPress,
  hint,
  muted,
  disabled = false,
  expanded,
}: {
  label: string;
  onPress: () => void;
  hint?: string;
  muted?: boolean;
  disabled?: boolean;
  /** A toggle that shows more (Details, Other ways): said to VoiceOver. */
  expanded?: boolean;
}) {
  const colors = useColors();
  const ripple = useRipple();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      android_ripple={{ ...ripple, borderless: true }}
      onPress={onPress}
      style={({ pressed }) => [
        pressed && { opacity: 0.6 },
        disabled && { opacity: DISABLED_OPACITY },
      ]}
    >
      {/* Small, not caption: beside 16pt values and answers a 12pt link read as a footnote. */}
      <T
        variant="small"
        color={muted ? colors.textSecondary : colors.textStrong}
        style={{ fontFamily: fonts.medium }}
        maxFontSizeMultiplier={chromeScale}
      >
        {label}
      </T>
    </Pressable>
  );
}

export interface BarSpec {
  id: BarId;
  tone: BarTone;
  title: string;
  detail?: string;
  /** A glyph in place of the dot (a speech bubble for "Changes to X"). */
  icon?: SFName;
  /** Something is going on now: the typing dots lead, in the state's colour. */
  live?: boolean;
  /** The whole bar opens something (the Connection screen). */
  onPress?: () => void;
  pressHint?: string;
  /** One text action at the end ("Remove"), or an ✕. */
  action?: { label: string; onPress: () => void; icon?: SFName };
}

/** A bar's state colour: status roles and neutral only, never the agent's accent. */
export const barTint = (colors: Palette): Record<BarTone, string> => ({
  waiting: colors.accentWarning,
  active: colors.statusRunning,
  info: colors.textMuted,
  problem: colors.accentErrorLight,
});

/** One bar: a dot (or icon) in the state's colour, the title and its detail, an action. */
export function Bar({ bar }: { bar: BarSpec }) {
  const colors = useColors();
  const styles = useBarStyles();
  const tint = barTint(colors);
  const body = (
    <>
      {bar.live ? (
        <TypingDots color={tint[bar.tone]} />
      ) : bar.icon ? (
        <Icon name={bar.icon} size={iconSize.inline} color={tint[bar.tone]} />
      ) : (
        <View style={styles.dot}>
          <Dot color={tint[bar.tone]} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <T
          variant="small"
          color={colors.textPrimary}
          numberOfLines={2}
          maxFontSizeMultiplier={chromeScale}
        >
          {bar.title}
        </T>
        {!!bar.detail && (
          <T
            variant="caption"
            color={colors.textSecondary}
            numberOfLines={2}
            maxFontSizeMultiplier={chromeScale}
          >
            {bar.detail}
          </T>
        )}
      </View>
    </>
  );
  const action = bar.action && (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bar.action.label}
      hitSlop={14}
      onPress={bar.action.onPress}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
    >
      {bar.action.icon ? (
        <Icon
          name={bar.action.icon}
          size={iconSize.inline}
          color={colors.textMuted}
          fallback={<T>×</T>}
        />
      ) : (
        <T variant="caption" color={colors.textStrong} maxFontSizeMultiplier={chromeScale}>
          {bar.action.label}
        </T>
      )}
    </Pressable>
  );
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      layout={LinearTransition.duration(180)}
      testID={`bar-${bar.id}`}
      style={styles.bar}
    >
      {bar.onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bar.detail ? `${bar.title}. ${bar.detail}` : bar.title}
          accessibilityHint={bar.pressHint}
          onPress={bar.onPress}
          style={({ pressed }) => [styles.barRow, pressed && { opacity: 0.6 }]}
        >
          {body}
        </Pressable>
      ) : (
        <View
          style={styles.barRow}
          accessible
          accessibilityLabel={bar.detail ? `${bar.title}. ${bar.detail}` : bar.title}
          accessibilityLiveRegion="polite"
        >
          {body}
        </View>
      )}
      {action}
    </Animated.View>
  );
}

/**
 * The bars above the composer, in their fixed order. Past two, the rest fold
 * into one "N more" that opens them: the composer is never pushed off the
 * screen by its own notices.
 */
export function BarStack({ bars }: { bars: BarSpec[] }) {
  const styles = useBarStyles();
  const [expanded, setExpanded] = useState(false);
  const { shown, folded } = stackBars(bars, expanded);
  if (!shown.length) return null;
  return (
    <View style={styles.stack} testID="bars">
      {shown.map((b) => (
        <Bar key={b.id} bar={b} />
      ))}
      {folded > 0 && (
        <View style={styles.more}>
          <TextAction label={`${folded} more`} muted onPress={() => setExpanded(true)} />
        </View>
      )}
    </View>
  );
}

/** Sorted into the fixed order; the first two shown unless opened. Exported for tests. */
export function stackBars<B extends { id: BarId }>(
  bars: B[],
  expanded = false
): { shown: B[]; folded: number } {
  const sorted = [...bars].sort((a, b) => BAR_ORDER.indexOf(a.id) - BAR_ORDER.indexOf(b.id));
  const shown = expanded ? sorted : sorted.slice(0, MAX_BARS);
  return { shown, folded: sorted.length - shown.length };
}

/**
 * The card recipe every card shares: 16 in, 12 between its blocks (head,
 * body, note, answers), and inside the head the lines sit tight.
 */
export const useCardStyles = makeStyles((colors) => ({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    // A sheet, as the desk's cards: a ring and a long soft drop.
    boxShadow: depthOf(colors).card,
    // Nothing inside draws past the corner: a pressed row, a well or an
    // image at the edge is cut to the card's own curve, never squared off.
    overflow: 'hidden',
  },
  cardQuiet: {
    backgroundColor: 'transparent',
    borderColor: colors.borderSubtle,
    boxShadow: 'none',
  },
  head: { gap: space['2xs'] },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.tight },
  // The glyph at the title's own size, as on the desk (16 beside 15-16),
  // centred on the headline's first line.
  icon: { height: lineHeight(type.subhead, 1.375), justifyContent: 'center' },
  // Quiet text, not a chip: a bordered box on a card reads as a control.
  meta: { fontVariant: ['tabular-nums'], lineHeight: lineHeight(type.subhead, 1.375) },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: space.sm,
  },
}));

const useLineStyles = makeStyles(() => ({
  line: {
    alignItems: 'center',
    gap: space['2xs'],
    paddingVertical: space.xs,
    paddingHorizontal: space.xl,
  },
  linePress: { maxWidth: '100%' },
  lineText: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.tight,
    maxWidth: '100%',
  },
  // What a line was about: the card's own words, as written.
  lineDetail: { alignSelf: 'stretch', gap: space.sm, paddingTop: space.xs },
  lineWords: { textAlign: 'center', letterSpacing: 0.2, flexShrink: 1 },
}));

const useBarStyles = makeStyles((colors) => ({
  stack: { gap: space.tight, paddingBottom: space.sm },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    // The card corner (theme.ts: summary bars are `card`): under a 16pt card an inner corner read as another family.
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
    overflow: 'hidden',
  },
  barRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.tight,
  },
  dot: { width: iconSize.inline, alignItems: 'center' },
  more: { alignItems: 'flex-end', paddingRight: space.xs },
}));
