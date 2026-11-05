/**
 * An approval in the chat: the exact command, then Deny / Allow (and Always
 * allow, when the desktop offers a scope), inert for a beat after it lands.
 * Once answered, the outcome in a line.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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
import { answerApproval, describeError } from '../lib/session';
import { useApp } from '../lib/store';
import { alpha, chromeScale, colors, fonts, radius, space, type } from '../lib/theme';
import { Button, choose, Icon, T } from './ui';

/**
 * How long a new card's answers stay inert: the desktop's anti-misclick
 * delay. A card can land under a thumb that was tapping Send or Stop, and
 * Allow is the one tap this app must never take by accident.
 */
export const ARM_MS = 400;

/** Whether a pending card's answers are live yet: false for `ARM_MS` after it lands. */
export function useArmed(pending: boolean) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return armed;
}

/**
 * The height of the chat pane a card sits in (0 when unknown). A pending card
 * caps its detail by it, so the question, what it's about and the answers
 * are on screen together: in a short pane (a phone in landscape, the split
 * view) a 12-line diff would otherwise push the question off the top and
 * leave three buttons with no context.
 */
export const PaneHeightContext = createContext(0);

/**
 * Below this a pending card can't fit whole (a phone in landscape, the split
 * view): the chat pins the question above the list, and cards go compact,
 * Deny | Allow with the broader answers one tap away.
 */
export const SHORT_PANE = 480;

export function useShortPane() {
  const pane = useContext(PaneHeightContext);
  return pane > 0 && pane < SHORT_PANE;
}

/** Room kept clear around a fitted card: the list's and the row's padding. */
const FIT_MARGIN = 40;
/** Never squeeze the detail below a few lines; past that the pane scrolls as usual. */
const MIN_DETAIL = 88;

/**
 * Measure the card and its detail; while pending, the detail's max height is
 * whatever the pane has left once the rest of the card (title, answers) fits.
 * The rest's height is the card's less the detail's, which a cap doesn't
 * change, so the fit settles in one pass.
 */
export function useFitDetail(pending: boolean) {
  const pane = useContext(PaneHeightContext);
  const [card, setCard] = useState(0);
  const [detail, setDetail] = useState(0);
  const rest = card - detail;
  const maxHeight =
    pending && pane > 0 && card > 0 ? Math.max(MIN_DETAIL, pane - rest - FIT_MARGIN) : undefined;
  return {
    onCardLayout: (e: LayoutChangeEvent) => setCard(e.nativeEvent.layout.height),
    onDetailLayout: (e: LayoutChangeEvent) => setDetail(e.nativeEvent.layout.height),
    maxHeight,
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
  return (
    <ScrollView
      style={{ maxHeight: fit.maxHeight, flexGrow: 0 }}
      onLayout={fit.onDetailLayout}
      nestedScrollEnabled
      scrollEnabled={fit.maxHeight !== undefined}
      showsVerticalScrollIndicator
      indicatorStyle="white"
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
  const [busy, setBusy] = useState<null | 'allow' | 'deny' | 'always'>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const armed = useArmed(approval.status === 'pending');
  const [explained, setExplained] = useState(false);
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= LARGE_TEXT;
  const connected = useApp((s) => s.link.kind === 'connected');
  const pending = approval.status === 'pending';
  const paused = pending && agent.status.state === 'idle';

  // The haptic says what the Mac did, so it waits for the Mac.
  const answer = async (allow: boolean, always = false, why?: string) => {
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
  };

  const outcome = cardOutcome(approval);
  const scope = approval.always ? describeScope(approval.always, agent.name) : null;
  const off = !!busy || !connected;
  const fit = useFitDetail(pending);
  const compact = useShortPane();

  return (
    <Animated.View
      layout={LinearTransition.duration(220)}
      onLayout={fit.onCardLayout}
      style={[cardStyles.card, pending && cardStyles.cardPending]}
    >
      {pending && <Eyebrow />}
      <T variant="subhead" color={colors.textWhite} maxFontSizeMultiplier={2}>
        {approval.title}
      </T>
      {!!approval.detail && (
        <FittedDetail fit={fit}>
          <Command text={approval.detail} lines={large ? 6 : 12} />
        </FittedDetail>
      )}
      {paused && (
        <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
          It paused here for you. Allow it and it picks up where it left off.
        </T>
      )}
      {pending && !connected && (
        <T variant="small" color={colors.textSecondary} maxFontSizeMultiplier={2}>
          Answer it once your Mac is back. It stays open until then.
        </T>
      )}
      {pending && noting ? (
        <Animated.View entering={FadeIn.duration(150)} style={{ gap: space.sm }}>
          <TextInput
            autoFocus
            value={note}
            onChangeText={setNote}
            maxLength={500}
            placeholder={`Tell ${agent.name} what to do instead`}
            placeholderTextColor={colors.textMuted}
            style={cardStyles.noteInput}
            returnKeyType="send"
            keyboardAppearance="dark"
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
      ) : pending ? (
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
              variant="primary"
              busy={busy === 'allow'}
              disabled={off}
              focusable={armed}
              onPress={() => void answer(true)}
              accessibilityHint={approval.detail || undefined}
              style={{ flex: 1 }}
            />
            {compact && (
              // A short pane: Deny | Allow are the card's last line, under the
              // thumb; the broader answers wait one tap away, with what they cover.
              <MoreAnswers
                disabled={off || !armed}
                onPress={() =>
                  choose(
                    approval.title,
                    [
                      ...(approval.always
                        ? [
                            {
                              label: `Always allow ${approval.always.label}`,
                              run: () => void answer(true, true),
                            },
                          ]
                        : []),
                      { label: 'Deny with note…', run: () => setNoting(true) },
                    ],
                    scope ?? undefined
                  )
                }
              />
            )}
          </View>
          {!compact && approval.always && (
            <View style={{ gap: space.xs }}>
              <Button
                title={`Always allow ${approval.always.label}`}
                busy={busy === 'always'}
                disabled={off}
                focusable={armed}
                onPress={() => void answer(true, true)}
                accessibilityHint={scope ?? undefined}
              />
              {large && !explained ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="What does always allow cover?"
                  hitSlop={{ top: 10, bottom: 10 }}
                  onPress={() => setExplained(true)}
                  style={cardStyles.disclosure}
                >
                  <Icon name="info.circle" size={12} color={colors.textSecondary} />
                  <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
                    What does this cover?
                  </T>
                </Pressable>
              ) : (
                <T variant="caption" color={colors.textSecondary} maxFontSizeMultiplier={2}>
                  {scope}
                </T>
              )}
            </View>
          )}
          {!compact && (
            <Button
              title="Deny with note…"
              variant="ghost"
              disabled={off}
              focusable={armed}
              onPress={() => setNoting(true)}
            />
          )}
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(200).delay(100)}>
          <T
            variant="small"
            color={approval.status === 'allowed' ? colors.accentSuccess : colors.textSecondary}
          >
            {outcome}
          </T>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/** The "⋯" beside Deny | Allow on a compact card: the other answers, in a sheet. */
export function MoreAnswers({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="More answers"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        cardStyles.more,
        pressed && { backgroundColor: colors.surfaceControl },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon name="ellipsis" size={16} color={colors.textPrimary} fallback={<T>…</T>} />
    </Pressable>
  );
}

/** The pending card's label. */
export function Eyebrow({ text = 'NEEDS YOUR OK' }: { text?: string }) {
  return (
    <View style={cardStyles.eyebrow}>
      <Icon name="exclamationmark.triangle.fill" size={12} color={colors.accentWarning} />
      <T
        variant="caption"
        color={colors.accentWarning}
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
  return (
    <View style={cardStyles.cardDetail}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={cardStyles.cardDetailInner}
      >
        <T
          variant="mono"
          color={colors.textPrimary}
          selectable
          numberOfLines={lines}
          maxFontSizeMultiplier={2}
        >
          {text}
        </T>
      </ScrollView>
    </View>
  );
}

export const cardStyles = StyleSheet.create({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg + 8,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  cardPending: { borderColor: alpha(colors.accentWarning, 0.45) },
  eyebrow: { flexDirection: 'row', gap: space.tight, alignItems: 'center' },
  eyebrowText: { fontFamily: fonts.semibold, letterSpacing: 0.6 },
  cardDetail: {
    backgroundColor: colors.surfaceApp,
    borderRadius: radius.card,
    overflow: 'hidden',
  },
  cardDetailInner: { padding: space.md },
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
  },
  actions: { flexDirection: 'row', gap: space.sm },
  more: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.borderStrong,
  },
  noteInput: {
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceControl,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
});
