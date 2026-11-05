/**
 * An approval in the chat: the exact command, then Deny | Allow, with Always
 * allow (when the desktop offers a scope) one tap away behind ⋯, inert for a
 * beat after it lands. Once answered, the outcome in a line.
 */

import type { Agent, AgentMessage, Approval, ImportProposal } from '@shipstudio/companion-protocol';
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { cardOutcome, describeScope } from '../lib/agents';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import { answerApproval, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { CARD_TITLE_SCALE, chromeScale, fonts, iconSize, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { choose } from './menu';
import { Button, Icon, T, tap } from './ui';

/**
 * How long a new card's answers stay inert: the desktop's anti-misclick
 * delay. A card can land under a thumb that was tapping Send or Stop, and
 * Allow is the one tap this app must never take by accident.
 */
export const ARM_MS = 400;

const UNARMED = Symbol('unarmed');

/**
 * Whether a pending card's answers are live yet: false for `ARM_MS` after it
 * lands, and again for `ARM_MS` whenever its `layout` changes (a rotation, a
 * banner, the pin coming or going): a reflow can put a different answer
 * under a thumb that was already moving.
 */
export function useArmed(pending: boolean, layout: string | number | boolean = '') {
  const [armedFor, setArmedFor] = useState<unknown>(UNARMED);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setArmedFor(layout), ARM_MS);
    return () => clearTimeout(timer);
  }, [pending, layout]);
  // Derived in the render that changes the layout: there's no frame where the
  // new layout is live before its beat has passed.
  return pending && armedFor === layout;
}

/**
 * The chat pane a card sits in. A pending card caps its detail by its height,
 * so the question, what it's about and the answers are on screen together: in
 * a short pane (a phone in landscape, the split view) a 12-line diff would
 * otherwise push the question off the top and leave buttons with no context.
 */
export interface Pane {
  /** The list's height (0 when unknown). */
  height: number;
  /** The list's and the pinned question's together: the same whether the pin shows or not. */
  room: number;
  /** The card the chat would pin: the newest pending one. */
  candidate: string | null;
  /** The card whose question the pin is showing now. */
  pinnedId: string | null;
  /** That card says whether it needs the pin (it can't fit whole with its own question). */
  report: (id: string, needsPin: boolean) => void;
}

export const PaneContext = createContext<Pane>({
  height: 0,
  room: 0,
  candidate: null,
  pinnedId: null,
  report: () => {},
});

/**
 * Below this a pane is short (a phone in landscape, the split view): cards go
 * compact, Deny | Allow | ⋯ and nothing under them.
 */
export const SHORT_PANE = 480;

export function useShortPane() {
  const { height } = useContext(PaneContext);
  return height > 0 && height < SHORT_PANE;
}

/** Room kept clear around a fitted card: the list's and the row's padding. */
const FIT_MARGIN = 40;
/** Never squeeze the detail below a couple of lines; past that the pane scrolls as usual. */
const MIN_DETAIL = 48;

/**
 * Measure the card, its head (eyebrow and title) and its detail; while
 * pending, the detail's max height is whatever the pane has left once the
 * rest of the card fits. When even that leaves less than `MIN_DETAIL`, the
 * chat pins the question above the list and the card drops its own head
 * (`pinned`): the pin owns the question, so it's never on screen twice.
 *
 * The decision is made against the card *with* its head and the room the
 * pin and the list share, neither of which the pin changes, so it settles
 * instead of flipping the pin on and off.
 */
export function useFitDetail(pending: boolean, id: string, hasAside = false) {
  const pane = useContext(PaneContext);
  const [card, setCard] = useState(0);
  const [detail, setDetail] = useState(0);
  const [head, setHead] = useState(0);
  const [aside, setAside] = useState(0);
  const candidate = pending && pane.candidate === id;
  const pinned = pending && pane.pinnedId === id;
  const measured = pending && pane.height > 0 && card > 0;
  // The rest of the card with everything it drops while pinned (its head, and
  // an aside such as "It paused here"), whether or not they're drawn now.
  const dropped = head + space.md + (hasAside ? aside + space.md : 0);
  const restFull = card - detail + (pinned ? dropped : 0);
  const needsPin = candidate && measured && pane.room - restFull - FIT_MARGIN < MIN_DETAIL;
  const { report } = pane;
  useEffect(() => report(id, needsPin), [needsPin, id, report]);
  useEffect(() => () => report(id, false), [id, report]);
  const rest = card - detail;
  const maxHeight = measured ? Math.max(MIN_DETAIL, pane.height - rest - FIT_MARGIN) : undefined;
  return {
    onCardLayout: (e: LayoutChangeEvent) => setCard(e.nativeEvent.layout.height),
    onDetailLayout: (e: LayoutChangeEvent) => setDetail(e.nativeEvent.layout.height),
    onHeadLayout: (e: LayoutChangeEvent) => setHead(e.nativeEvent.layout.height),
    onAsideLayout: (e: LayoutChangeEvent) => setAside(e.nativeEvent.layout.height),
    maxHeight,
    /** The chat is showing this card's question in the pin: the card leaves its head out. */
    pinned,
  };
}

/** A card's detail, scrolling inside itself when it has been fitted to the pane. */
export function FittedDetail({
  fit,
  children,
}: {
  fit: ReturnType<typeof useFitDetail>;
  children: ReactNode;
}) {
  const appearance = useAppearance();
  return (
    <ScrollView
      style={{ maxHeight: fit.maxHeight, flexGrow: 0 }}
      onLayout={fit.onDetailLayout}
      nestedScrollEnabled
      scrollEnabled={fit.maxHeight !== undefined}
      showsVerticalScrollIndicator
      indicatorStyle={appearance === 'light' ? 'black' : 'white'}
    >
      {children}
    </ScrollView>
  );
}

/** At this text size the explanation folds away, so the answers stay in reach. */
const LARGE_TEXT = 1.6;

export function ApprovalCard({
  message,
  approval,
  agent,
  onError,
}: {
  message: AgentMessage;
  approval: Approval;
  agent: Agent;
  onError: (text: string) => void;
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const appearance = useAppearance();
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'always'>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_TEXT;
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const paused = pending && agent.status.state === 'idle';
  const fit = useFitDetail(pending, message.id, paused);
  const compact = useShortPane();
  const armed = useArmed(pending, `${compact}:${fit.pinned}`);
  const once = useInFlight();

  // The haptic says what the Mac did, so it waits for the Mac. One answer at
  // a time: a second tap in the same frame would be refused by the Mac.
  const answer = (allow: boolean, always = false, why?: string) =>
    once(async () => {
      if (!armed) return;
      setBusy(always ? 'always' : allow ? 'allow' : 'deny');
      try {
        await answerApproval(message.agentId, approval.requestId, allow, always, why);
        if (allow) haptic.success();
        else haptic.warning();
        setNoting(false);
      } catch (error) {
        haptic.error();
        onError(describeError(error));
      } finally {
        setBusy(null);
      }
    });

  const outcome = cardOutcome(approval);
  const scope = approval.always ? describeScope(approval.always, agent.name) : null;
  const off = !!busy || !connected;
  // Behind ⋯: the broader answer, and a denial with a note. One row of
  // answers under the thumb, never a second line of them.
  const more = [
    ...(approval.always
      ? [{ label: `Always allow ${approval.always.label}`, run: () => void answer(true, true) }]
      : []),
    { label: 'Deny with note…', run: () => setNoting(true) },
  ];

  if (!pending) {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={outcome}>
        {!!approval.detail && <Command text={approval.detail} lines={12} />}
      </Receipt>
    );
  }

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      onLayout={fit.onCardLayout}
      style={cardStyles.card}
    >
      {!fit.pinned && (
        // The pin above the chat shows the question while this can't fit whole.
        <View onLayout={fit.onHeadLayout} style={cardStyles.head}>
          <Eyebrow />
          <T variant="headline" color={colors.textStrong} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
            {approval.title}
          </T>
        </View>
      )}
      {!!approval.detail && (
        <FittedDetail fit={fit}>
          <Command text={approval.detail} lines={large ? 6 : 12} />
        </FittedDetail>
      )}
      {paused && !fit.pinned && (
        <T
          variant="small"
          color={colors.textMuted}
          maxFontSizeMultiplier={CARD_TITLE_SCALE}
          onLayout={fit.onAsideLayout}
        >
          It paused here for you. Allow it and it picks up where it left off.
        </T>
      )}
      {!connected && (
        <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          Answer it once your Mac is back. It stays open until then.
        </T>
      )}
      {noting ? (
        <Animated.View entering={FadeIn.duration(150)} style={{ gap: space.sm }}>
          <TextInput
            autoFocus
            value={note}
            onChangeText={setNote}
            maxLength={500}
            placeholder={`Tell ${agent.name} what to do instead`}
            placeholderTextColor={colors.textMuted}
            style={cardStyles.input}
            returnKeyType="send"
            keyboardAppearance={appearance}
            // Return denies with the note, and only once there is one.
            onSubmitEditing={() => note.trim() && void answer(false, false, note)}
          />
          <View style={cardStyles.actions}>
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setNoting(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Deny"
              busy={busy === 'deny'}
              disabled={!connected}
              onPress={() => void answer(false, false, note)}
              style={{ flex: 1 }}
            />
          </View>
        </Animated.View>
      ) : (
        <Animated.View
          // Inert, and fading in, until armed: a tap meant for something else lands on nothing.
          entering={FadeIn.duration(ARM_MS)}
          exiting={FadeOut.duration(120)}
          pointerEvents={armed ? 'auto' : 'none'}
          accessibilityElementsHidden={!armed}
          importantForAccessibility={armed ? 'auto' : 'no-hide-descendants'}
          style={{ gap: space.sm }}
        >
          <View style={cardStyles.actions}>
            <Button
              title="Deny"
              busy={busy === 'deny'}
              disabled={off}
              focusable={armed}
              onPress={() => void answer(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Allow"
              variant="answer"
              busy={busy === 'allow'}
              disabled={off}
              focusable={armed}
              onPress={() => void answer(true)}
              accessibilityHint={approval.detail || undefined}
              style={{ flex: 1 }}
            />
            {/*
              Never a second Allow under the thumb: anything broader is a
              deliberate second step, with what it covers spelled out.
            */}
            <MoreAnswers
              disabled={off || !armed}
              onPress={() => choose(approval.title, more, scope ?? undefined)}
            />
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/**
 * An import's review card (desktop `agents/review.rs`): the agents another
 * assistant proposed. It can't be answered here. Importing means reading
 * each agent's instructions first, and those are on the Mac's card, so this
 * one only says who they are and to go there. No Allow: the Mac refuses one.
 */
export function ReviewOnMacCard({ approval }: { approval: Approval }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const proposals = approval.connector?.review?.proposals ?? [];
  const agents = reviewLines(proposals);
  if (approval.status !== 'pending') {
    return (
      <Receipt status={approval.status} title={approval.title} outcome={cardOutcome(approval)}>
        {agents.map((line, i) => (
          <T key={i} variant="small" color={colors.textSecondary}>
            {line}
          </T>
        ))}
      </Receipt>
    );
  }
  return (
    <Animated.View layout={LinearTransition.duration(220)} style={cardStyles.card}>
      <View style={cardStyles.head}>
        {/* Not the amber "act here" mark: there's nothing to do on this phone. */}
        <Eyebrow text="ON YOUR MAC" icon="info.circle" tone="neutral" />
        <T variant="headline" color={colors.textStrong} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
          {approval.title}
        </T>
      </View>
      {agents.length > 0 && (
        <View style={{ gap: space['2xs'] }}>
          {agents.map((line, i) => (
            <T key={i} variant="small" color={colors.textSecondary}>
              {line}
            </T>
          ))}
        </View>
      )}
      <T variant="small" color={colors.textMuted} maxFontSizeMultiplier={CARD_TITLE_SCALE}>
        Each agent’s instructions are shown there before anything is created.
      </T>
    </Animated.View>
  );
}

/**
 * The agents an import proposes, from the card's own data: "Scout · Research",
 * and "replaces your Scout" where one would take an existing agent's place.
 */
export function reviewLines(proposals: ImportProposal[]): string[] {
  return proposals.map((p) => {
    const who = p.role ? `${p.name} · ${p.role}` : p.name;
    return p.clash ? `${who} · replaces your ${p.clash.name ?? p.name}` : who;
  });
}

type IconName = ComponentProps<typeof Icon>['name'];

/** A receipt's glyph is always its outcome, on every kind of card. */
export const OUTCOME_GLYPH: Record<Exclude<Approval['status'], 'pending'>, IconName> = {
  allowed: 'checkmark',
  denied: 'xmark',
  expired: 'clock',
};

/**
 * A card once it's answered: one quiet line, "✓ Allowed · what it asked", so
 * a finished request doesn't keep the footprint of a live one (three
 * answered secret cards used to take a screen). Tap for what it was about;
 * with nothing more to show, it's a plain line with no chevron and no press.
 */
export function Receipt({
  status,
  title,
  outcome,
  children,
}: {
  status: Approval['status'];
  title: string;
  /** `cardOutcome`: its first part leads the line, the whole of it shows when open. */
  outcome: string;
  children?: ReactNode;
}) {
  const colors = useColors();
  const cardStyles = useCardStyles();
  const [open, setOpen] = useState(false);
  const cut = outcome.indexOf(' · ');
  const word = cut < 0 ? outcome : outcome.slice(0, cut);
  const rest = cut < 0 ? '' : outcome.slice(cut + 3);
  const ok = status === 'allowed';
  const tint = ok ? colors.accentSuccess : colors.textSecondary;
  const glyph = OUTCOME_GLYPH[status === 'pending' ? 'expired' : status];
  const hasDetail = Children.toArray(children).length > 0 || !!rest;
  if (!hasDetail) {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        layout={LinearTransition.duration(200)}
        accessible
        accessibilityLabel={`${outcome}. ${title}`}
        style={cardStyles.receipt}
      >
        <Icon name={glyph} size={iconSize.inline} color={tint} />
        <T variant="small" color={colors.textSecondary} numberOfLines={2} style={{ flexShrink: 1 }}>
          <T variant="small" color={tint} style={{ fontFamily: fonts.medium }}>
            {word}
          </T>
          {' · '}
          {title}
        </T>
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={FadeIn.duration(200)} layout={LinearTransition.duration(200)}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${outcome}. ${title}`}
        accessibilityHint={open ? 'Hides the detail' : 'Shows what it was about'}
        hitSlop={{ top: 10, bottom: 10 }}
        onPress={() => {
          tap();
          setOpen((o) => !o);
        }}
        style={({ pressed }) => [cardStyles.receipt, pressed && { opacity: 0.6 }]}
      >
        <Icon name={glyph} size={iconSize.inline} color={tint} />
        <T
          variant="small"
          color={colors.textSecondary}
          numberOfLines={open ? undefined : 1}
          style={{ flexShrink: 1 }}
        >
          <T variant="small" color={tint} style={{ fontFamily: fonts.medium }}>
            {word}
          </T>
          {' · '}
          {title}
        </T>
        <Icon
          name={open ? 'chevron.down' : 'chevron.right'}
          size={iconSize.inline}
          color={colors.textMuted}
        />
      </Pressable>
      {open && (
        <Animated.View entering={FadeIn.duration(150)} style={cardStyles.receiptDetail}>
          {children}
          {!!rest && (
            <T variant="small" color={colors.textMuted}>
              {rest}
            </T>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );
}

/** The "⋯" beside Deny | Allow on a compact card: the other answers, in a sheet. */
export function MoreAnswers({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="More answers"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        cardStyles.more,
        pressed && { backgroundColor: colors.surfaceControlHover },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon name="ellipsis" size={iconSize.body} color={colors.textStrong} fallback={<T>…</T>} />
    </Pressable>
  );
}

/**
 * The pending card's label: amber "NEEDS YOUR OK" for an answer wanted here,
 * or neutral for one that only says where it's answered.
 */
export function Eyebrow({
  text = 'NEEDS YOUR OK',
  icon = 'exclamationmark.triangle.fill',
  tone = 'warning',
}: {
  text?: string;
  icon?: IconName;
  tone?: 'warning' | 'neutral';
}) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const tint = tone === 'warning' ? colors.accentWarning : colors.textSecondary;
  return (
    <View style={cardStyles.eyebrow}>
      <Icon name={icon} size={iconSize.inline} color={tint} />
      <T
        variant="caption"
        color={tint}
        style={cardStyles.eyebrowText}
        maxFontSizeMultiplier={chromeScale}
      >
        {text}
      </T>
    </View>
  );
}

/**
 * The exact command, never re-wrapped: a line break inside `acme-site`
 * reads as a different path. Long lines scroll sideways instead, and what
 * is selected and copied is the command itself, character for character.
 */
export function Command({ text, lines }: { text: string; lines: number }) {
  const cardStyles = useCardStyles();
  const colors = useColors();
  const [all, setAll] = useState(false);
  // Long commands are never cut silently: past `lines` they say how many
  // more there are, and a tap shows the rest.
  const rows = text.split('\n');
  const over = rows.length > lines && !all;
  return (
    <View style={cardStyles.cardDetail}>
      <ScrollView
        horizontal
        // Visible, so a line that runs off the edge reads as one to scroll.
        showsHorizontalScrollIndicator
        contentContainerStyle={cardStyles.cardDetailInner}
      >
        <T variant="mono" color={colors.textPrimary} selectable maxFontSizeMultiplier={1.5}>
          {over ? rows.slice(0, lines).join('\n') : text}
        </T>
      </ScrollView>
      {over && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setAll(true)}
          hitSlop={{ top: 8, bottom: 8 }}
          style={cardStyles.showAll}
        >
          <T variant="caption" color={colors.textSecondary} style={{ fontFamily: fonts.medium }}>
            Show all {rows.length} lines
          </T>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The card recipe every card shares: 16 in, 12 between its blocks (head,
 * detail, aside, answers), and inside the head the lines sit tight (eyebrow
 * → 6 → title → 2 → meta), so it reads as one block, not five stripes.
 */
export const useCardStyles = makeStyles((colors) => ({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  head: { gap: space.tight },
  eyebrow: { flexDirection: 'row', gap: space.tight, alignItems: 'center' },
  eyebrowText: { fontFamily: fonts.semibold, letterSpacing: 0.6 },
  cardDetail: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.inner,
    overflow: 'hidden',
  },
  cardDetailInner: { padding: space.md },
  showAll: { paddingHorizontal: space.md, paddingBottom: space.sm },
  actions: { flexDirection: 'row', gap: space.sm },
  more: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control,
    backgroundColor: colors.surfaceControl,
  },
  /** Every text field in a card or a sheet: clearly a field, on a panel, in either appearance. */
  input: {
    minHeight: 44,
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
  receipt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingVertical: space.xs,
  },
  receiptDetail: { gap: space.sm, paddingTop: space.sm, paddingLeft: space.lg + space['2xs'] },
}));
