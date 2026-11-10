/**
 * Catch up, one at a time (Catch up's "One at a time"): everything waiting on
 * you, one card at a time (lib/catchUp.ts). Each card is the agent, what it
 * said, and what it's asking; under the thumb, Allow · Deny for a request
 * (its own one action for a login, a key, a question), Chat to open it in
 * its chat (back comes back here, to the same card), and Next. Swipe left
 * is Next too.
 *
 * Swiping right never allows. An Allow can't be taken back, and a card's
 * command and diff scroll sideways under the same finger: a swipe that was
 * meant to read the end of a line must never answer. Allow is a button,
 * inert for a beat after each card lands, as in the chat.
 */

import type { Agent, Approval } from '@shipstudio/companion-protocol';
import { previewText } from '@shipstudio/companion-protocol';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  FadeIn,
  FadeInRight,
  FadeOutLeft,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { AgentKey } from '../components/AgentKey';
import { ApprovalCard, useArmed } from '../components/ApprovalCard';
import { MessageRow } from '../components/chat';
import { RowBoundary } from '../components/RowBoundary';
import { Card, Line } from '../components/surfaces';
import { Button, Icon, IconButton, T } from '../components/ui';
import { AgentAccent } from '../lib/accent';
import {
  askingLine,
  engineName,
  failedTurn,
  failureLine,
  formatAgo,
  needsLine,
} from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import {
  advance,
  askAction,
  askState,
  buildItems,
  cardMessages,
  current,
  isDone,
  progressOf,
  OFFER_PROGRESS,
  startQueue,
  syncQueue,
  type CatchItem,
  type CatchQueue,
} from '../lib/catchUp';
import { GalleryContext, chatGallery } from '../lib/gallery';
import { haptic } from '../lib/haptics';
import { SETUP_TITLE } from '../lib/home';
import { useInFlight } from '../lib/once';
import { answerApproval, canCall, describeError, loadLatest, setOpenChat } from '../lib/session';
import { highRisk } from '../lib/needsYou';
import { useApp } from '../lib/store';
import { progress as setupProgress } from '../lib/teamSetup';
import {
  heroMark,
  keySize,
  iconSize,
  lineHeight,
  radius,
  READ_LINE,
  space,
  type,
} from '../lib/theme';

/** How long a card's chats get to load before the queue starts without them. */
const LOAD_WAIT_MS = 5000;
/** How long a card answered elsewhere, or expired, says so before moving on. */
const MOVE_ON_MS = 1600;
/** Past this share of the width, a swipe left is Next. */
const SWIPE_SHARE = 0.28;
/** The big answer buttons: taller than a large button, for the thumb. */
const BIG = space['2xl'] + space.xl;

export default function CatchUp() {
  const styles = useStyles();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const overview = useApp((s) => s.overview);
  const chats = useApp((s) => s.chats);
  const setup = useApp((s) => s.teamSetup);
  const connected = useApp((s) => s.link.kind === 'connected');
  const reviewHere = canCall('agents.import.review');

  // Every chat a card will need, loaded once before the queue starts, so
  // its order doesn't change under you as they arrive.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const agents = useApp.getState().overview?.agents ?? [];
    const loaded = useApp.getState().chats;
    const ids = connected
      ? agents
          .filter(
            (a) =>
              !a.hidden &&
              ((a.pendingApprovals ?? 0) > 0 || a.unread > 0 || !!failedTurn(a)) &&
              !loaded[a.id]?.loaded
          )
          .map((a) => a.id)
      : [];
    let live = true;
    const wait = new Promise((r) => setTimeout(r, LOAD_WAIT_MS));
    void Promise.race([Promise.allSettled(ids.map((id) => loadLatest(id))), wait]).then(
      () => live && setReady(true)
    );
    return () => {
      live = false;
    };
    // Once, on opening: later arrivals join the end through `syncQueue`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fresh = useMemo(
    () => (overview ? buildItems(overview.agents, chats, setup, reviewHere) : []),
    [overview, chats, setup, reviewHere]
  );
  const [queue, setQueue] = useState<CatchQueue | null>(null);
  useEffect(() => {
    if (ready) setQueue((q) => (q ? syncQueue(q, fresh) : startQueue(fresh)));
  }, [ready, fresh]);

  const item = queue ? current(queue) : null;
  const next = useCallback(() => setQueue((q) => (q ? advance(q) : q)), []);

  // On screen, the card's chat counts as read: the Mac clears its unread
  // and holds its alerts, as an open chat does.
  const readId = item && item.kind !== 'setup' ? item.agentId : null;
  useFocusEffect(
    useCallback(() => {
      if (!readId) return;
      setOpenChat(readId);
      return () => setOpenChat(null);
    }, [readId])
  );

  if (!queue) {
    return (
      <View style={[styles.page, styles.center, { paddingTop: insets.top }]}>
        <Spinner size={iconSize.button} label="Catching up" />
      </View>
    );
  }

  if (isDone(queue) || !item) {
    return <AllCaughtUp onBack={() => router.back()} />;
  }

  const agent = overview?.agents.find((a) => a.id === item.agentId);
  const { n, of, offer } = progressOf(queue);
  // A skill offer comes after what blocks, and is not counted in "3 of 8".
  const where = offer || of === 0 ? OFFER_PROGRESS : `${n} of ${of}`;
  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton name="xmark" label="Close" onPress={() => router.back()} />
        <T variant="headline" color={colors.textStrong} accessibilityRole="header">
          Catch up
        </T>
        <T
          variant="caption"
          color={colors.textSecondary}
          style={styles.count}
          accessibilityLabel={where}
        >
          {where}
        </T>
      </View>
      <Progress share={offer || of === 0 ? 1 : n / of} />
      {agent ? (
        <AgentAccent agentId={agent.id}>
          <Shown
            key={item.key}
            item={item}
            agent={agent}
            connected={connected}
            onNext={next}
            onChat={(at) =>
              router.push({
                pathname: '/chat/[id]',
                params: { id: agent.id, ...(at ? { at } : {}) },
              })
            }
            bottom={insets.bottom}
          />
        </AgentAccent>
      ) : (
        // Deleted while queued: nothing to show, so on to the next.
        <Skip onSkip={next} />
      )}
    </View>
  );
}

/** The thin bar: its fill glides to the new share on the UI thread. */
function Progress({ share }: { share: number }) {
  const styles = useStyles();
  const w = useSharedValue(share);
  useEffect(() => {
    w.value = withTiming(share, { duration: 260 });
  }, [share, w]);
  const fill = useAnimatedStyle(() => ({ width: `${w.value * 100}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, fill]} />
    </View>
  );
}

function Skip({ onSkip }: { onSkip: () => void }) {
  useEffect(() => onSkip(), [onSkip]);
  return null;
}

/** One card, its actions under it, and swipe left for Next. */
function Shown({
  item,
  agent,
  connected,
  onNext,
  onChat,
  bottom,
}: {
  item: CatchItem;
  agent: Agent;
  connected: boolean;
  onNext: () => void;
  onChat: (at?: string) => void;
  bottom: number;
}) {
  const styles = useStyles();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const messages = useApp((s) => s.chats[agent.id]?.messages);
  const setup = useApp((s) => s.teamSetup);
  const card = item.messageId ? messages?.find((m) => m.id === item.messageId) : undefined;
  const state = item.kind === 'ask' ? askState(item, messages) : 'pending';
  const action = askAction(card);
  const shown = useMemo(() => cardMessages(item, messages), [item, messages]);
  const gallery = useMemo(() => chatGallery(shown), [shown]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);
  // Answered from here: it moves on at once, so "answered elsewhere" is never said of it.
  const mine = useRef(false);
  const once = useInFlight();
  const pending = item.kind === 'ask' && state === 'pending';
  const armed = useArmed(pending, item.key);

  // Answered on the Mac, or expired, while it was in front of you: say so, then on.
  const moved = item.kind === 'ask' && state !== 'pending' && !mine.current;
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(onNext, MOVE_ON_MS);
    return () => clearTimeout(timer);
  }, [moved, onNext]);

  const goNext = useCallback(() => {
    haptic.light();
    onNext();
  }, [onNext]);

  const answer = (allow: boolean) =>
    once(async () => {
      if (!armed || !card?.approval) return;
      mine.current = true;
      setBusy(allow ? 'allow' : 'deny');
      setError(null);
      try {
        await answerApproval(agent.id, card.approval.requestId, allow, false);
        if (allow) haptic.success();
        else haptic.warning();
        onNext();
      } catch (e) {
        mine.current = false;
        haptic.error();
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    });

  // Swipe left: Next. The card follows the finger, and springs back short of it.
  const dx = useSharedValue(0);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          g.dx < -space.md && Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onPanResponderMove: (_, g) => {
          dx.value = Math.min(0, g.dx);
        },
        onPanResponderRelease: (_, g) => {
          if (-g.dx > width * SWIPE_SHARE) {
            dx.value = withTiming(-width, { duration: 160 });
            goNext();
          } else {
            dx.value = withSpring(0);
          }
        },
        onPanResponderTerminate: () => {
          dx.value = withSpring(0);
        },
      }),
    [dx, width, goNext]
  );

  const failure = failedTurn(agent);
  const status =
    item.kind === 'reply' && (failure || (agent.pendingApprovals ?? 0) > 0)
      ? failure && !(agent.pendingApprovals ?? 0)
        ? failureLine(failure, previewText(agent.preview), engineName(agent))
        : needsLine(agent, messages)
      : null;
  // The big slot under the thumb holds the card's one action: Allow / Deny, the
  // sign-in or key or answer (it opens the chat), Continue, or else Next.
  const chatIsMain = (pending && action.kind === 'open') || item.kind === 'setup';
  const nextIsMain = !chatIsMain && !(pending && action.kind === 'answer');
  const movedLine =
    state === 'expired'
      ? 'Not answered in time · moving on'
      : state === 'answered'
        ? 'Already answered · moving on'
        : 'No longer waiting · moving on';

  return (
    <>
      <Animated.View
        entering={FadeInRight.duration(260)}
        exiting={FadeOutLeft.duration(160)}
        style={[styles.body, slide]}
        {...pan.panHandlers}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.who}>
            <AgentKey id={agent.id} name={agent.name} color={agent.color} size={keySize.md} />
            <T variant="headline" color={colors.textStrong} numberOfLines={1} style={styles.name}>
              {agent.name}
            </T>
            <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
              {formatAgo(card?.ts ?? agent.lastActivityAt)}
            </T>
          </View>
          <GalleryContext.Provider value={gallery}>
            {shown.map((m) => (
              <RowBoundary key={m.id} resetKey={m}>
                <MessageRow message={m} agent={agent} queued={false} onError={setError} />
              </RowBoundary>
            ))}
          </GalleryContext.Provider>
          {item.kind === 'reply' && shown.length === 0 && !!agent.preview && (
            <T color={colors.textBody} style={styles.read}>
              {previewText(agent.preview)}
            </T>
          )}
          {status && <Line text={status} />}
          {item.kind === 'setup' && (
            <Card icon="list.bullet" title={SETUP_TITLE}>
              <T variant="small" color={colors.textSecondary}>
                {`${setup ? `${setupProgress(setup)} · ` : ''}in ${agent.name}’s chat`}
              </T>
            </Card>
          )}
          {card?.approval &&
            (action.kind === 'answer' ? (
              <ApprovalCard
                message={card}
                approval={card.approval}
                agent={agent}
                onError={setError}
                answers={false}
                // A risky request is read in full before it's allowed.
                full={highRisk(card.approval)}
              />
            ) : (
              <Card icon={askIcon(card.approval)} title={card.approval.title}>
                <T variant="small" color={colors.textSecondary}>
                  {askingLine(card.approval)}
                </T>
              </Card>
            ))}
          {moved && (
            <Animated.View entering={FadeIn.duration(150)}>
              <Line text={movedLine} />
            </Animated.View>
          )}
        </ScrollView>
      </Animated.View>
      <View style={[styles.actions, { paddingBottom: Math.max(bottom, space.lg) }]}>
        {!!error && (
          <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        {pending && !connected && (
          <T variant="small" color={colors.textSecondary}>
            Answer it once your Mac is back. It stays open until then.
          </T>
        )}
        <View style={styles.quiet}>
          {!chatIsMain && (
            <Button
              title="Chat"
              variant="ghost"
              size="compact"
              icon="bubble.left"
              onPress={() => onChat(card?.id)}
            />
          )}
          {!nextIsMain && <Button title="Next" variant="ghost" size="compact" onPress={goNext} />}
        </View>
        {pending && action.kind === 'answer' ? (
          <Animated.View
            entering={FadeIn.duration(400)}
            pointerEvents={armed ? 'auto' : 'none'}
            style={styles.row}
          >
            <Button
              title={action.deny}
              variant="outline"
              size="large"
              busy={busy === 'deny'}
              disabled={!!busy || !connected}
              onPress={() => void answer(false)}
              style={styles.big}
            />
            <Button
              title={action.allow}
              // Risky, as the Mac said it: Allow in the danger style.
              variant={highRisk(card?.approval) ? 'danger' : 'answer'}
              size="large"
              busy={busy === 'allow'}
              disabled={!!busy || !connected}
              onPress={() => void answer(true)}
              accessibilityHint={card?.approval?.detail || undefined}
              style={styles.big}
            />
          </Animated.View>
        ) : chatIsMain ? (
          <Button
            title={pending && action.kind === 'open' ? action.label : 'Continue'}
            variant="answer"
            size="large"
            onPress={() => onChat(card?.id)}
            style={styles.bigSingle}
          />
        ) : (
          <Button
            title="Next"
            variant="answer"
            size="large"
            onPress={goNext}
            style={styles.bigSingle}
          />
        )}
      </View>
    </>
  );
}

/** The icon its own card in the chat wears (a login's is the lock, as a key's). */
const askIcon = (a: Approval) =>
  a.login || a.secret ? 'lock.fill' : a.connector ? 'square.and.arrow.down' : 'checkmark.shield';

function AllCaughtUp({ onBack }: { onBack: () => void }) {
  const styles = useStyles();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, styles.center, { paddingTop: insets.top }]}>
      <Animated.View entering={FadeIn.duration(300)} style={styles.done}>
        <View style={styles.check}>
          <Icon name="checkmark" size={iconSize.hero} color={colors.textSecondary} />
        </View>
        <T variant="title" color={colors.textStrong} accessibilityRole="header">
          All caught up
        </T>
        <T color={colors.textSecondary} style={styles.doneText}>
          Nothing else is waiting on you.
        </T>
        <Button title="Done" variant="secondary" size="large" onPress={onBack} />
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { flex: 1, backgroundColor: colors.surfaceApp },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  count: { minWidth: keySize.lg, textAlign: 'right', paddingRight: space.sm },
  track: {
    height: space.xs,
    marginHorizontal: space.lg,
    marginBottom: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.borderDefault,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.textSecondary },
  body: { flex: 1 },
  scroll: { padding: space.lg, gap: space.lg },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flex: 1 },
  read: { fontSize: type.read, lineHeight: lineHeight(type.read, READ_LINE) },
  quiet: { flexDirection: 'row', justifyContent: 'center', gap: space.xl },
  big: { flex: 1, minHeight: BIG },
  bigSingle: { minHeight: BIG },
  actions: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderDefault,
    backgroundColor: colors.surfaceApp,
  },
  row: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  done: { alignItems: 'center', gap: space.md, paddingHorizontal: space.xl },
  check: {
    width: heroMark,
    height: heroMark,
    borderRadius: heroMark / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  doneText: { textAlign: 'center' },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
