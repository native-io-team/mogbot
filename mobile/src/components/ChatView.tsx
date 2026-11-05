/**
 * One conversation. An inverted list, so the newest line sits on the
 * composer and a growing draft pushes upward like the desktop's; scrolling
 * to the top pages in older messages; a button brings you back down, and
 * says so when an approval is waiting below.
 *
 * Used full-screen (chat/[id]) and as the right column of the iPad split
 * (`embedded`), where it draws its own header instead of the stack's.
 */

import { newestResults, type Agent, type AgentMessage } from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type FlatList,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ScrollViewProps,
  type FlatListProps,
} from 'react-native';
import {
  KeyboardChatScrollView,
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { askingLine, isQueued, needsYouHere, pendingApproval } from '../lib/agents';
import { messageActions, plainText, type MessageAction } from '../lib/actions';
import { announce } from '../lib/a11y';
import { addQuote } from '../lib/drafts';
import { preview } from '../lib/files';
import { haptic } from '../lib/haptics';
import {
  canCall,
  describeError,
  fetchPath,
  loadLatest,
  loadOlder,
  loadUntil,
  setOpenChat,
} from '../lib/session';
import { useAccent } from '../lib/accent';
import { useApp } from '../lib/store';
import { SETUP_KEY, chatItems, sentAt, withSetupCard, type Item } from '../lib/timeline';
import { setupAnchor, shows as showsSetup } from '../lib/teamSetup';
import {
  alpha,
  avatarSize,
  chromeScale,
  fonts,
  iconSize,
  radius,
  space,
  PRESSED,
} from '../lib/theme';
import {
  endOffset,
  FAR,
  FOLLOWING,
  fromEnd,
  holdFor,
  newestSignature,
  pillFor,
  scrolled,
  toEnd,
  type Follow,
} from '../lib/follow';
import { makeStyles, useColors } from '../lib/appearance';
import { AgentAvatar, Spinner } from './agent';
import { DaySeparator, DraftRow, MessageRow, PendingRow, WorkingRow } from './chat';
import { Composer } from './Composer';
import { LinkProblem } from './ConnectionPill';
import { Line } from './surfaces';
import { RoomFoldRow } from './RoomRow';
import { TeamSetupCard } from './TeamSetupCard';
import { PathContext } from './Markdown';
import { PaneContext, type Pane } from './ApprovalCard';
import { showActions } from './menu';
import { SelectSheet } from './SelectSheet';
import { Button, Dot, Icon, IconButton, useRipple, T } from './ui';

const NONE: never[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
/** A card counts as seen once its top is on screen: its title is the question. */
const VIEWABILITY = { itemVisiblePercentThreshold: 10 };

/** Rows glide to where a growing or collapsing neighbour puts them: nothing jumps. */
const glide = LinearTransition.duration(220);

/**
 * A pending approval's question, held above a pane too short for the whole
 * card (which then leaves its own question out). Tap: back to its answers.
 */
function PinnedQuestion({
  title,
  line,
  inset,
  onPress,
}: {
  title: string;
  line: string;
  inset: { left: number; right: number };
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Needs your OK: ${title}`}
        accessibilityHint="Scrolls to its answers"
        onPress={onPress}
        android_ripple={ripple}
        style={({ pressed }) => [
          styles.pinned,
          { paddingLeft: space.lg + inset.left, paddingRight: space.lg + inset.right },
          pressed && Platform.OS === 'ios' && PRESSED,
        ]}
      >
        <Icon
          name="exclamationmark.triangle.fill"
          size={iconSize.inline}
          color={colors.accentWarning}
        />
        <View style={{ flex: 1 }}>
          <T variant="small" color={colors.textStrong} numberOfLines={1}>
            {title}
          </T>
          {line !== title && (
            <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
              {line}
            </T>
          )}
        </View>
        <Icon name="chevron.down" size={iconSize.inline} color={colors.textMuted} />
      </Pressable>
    </Animated.View>
  );
}

export function ChatView({
  id,
  at,
  compose = false,
  embedded = false,
  notice,
}: {
  id: string;
  at?: string;
  /** Said once, as the chat opens (what a share couldn't attach). */
  notice?: string;
  /** Opened to write (the "New message" quick action): the field has the keyboard. */
  compose?: boolean;
  embedded?: boolean;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const hasOverview = useApp((s) => !!s.overview);
  const chat = useApp((s) => s.chats[id]);
  const draft = useApp((s) => s.drafts[id]);
  const pending = useApp((s) => s.pending[id] ?? NONE);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const list = useRef<FlatList<Item>>(null);
  // Following the newest line, or let go to read back (lib/follow.ts).
  const [follow, setFollow] = useState<Follow>(FOLLOWING);
  const [far, setFar] = useState(false);
  // The keyboard's lift, as the list's top inset: where the newest end is now.
  const insetTop = useRef(0);
  // A finger on the list, or its fling still running: only that lets go.
  const dragging = useRef(false);
  const flinging = useRef(false);
  const [listHeight, setListHeight] = useState(0);
  // The pin and the list together: the room a card is measured against, the
  // same whether the pin shows or not.
  const [roomHeight, setRoomHeight] = useState(0);
  // The pending card that said it can't fit whole with its question.
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(90);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [toast, setToast] = useState<string | null>(notice ?? null);
  const [selecting, setSelecting] = useState<AgentMessage | null>(null);
  // A search hit to land on: paged in, scrolled to, and lit up once.
  const [target, setTarget] = useState<string | null>(null);
  // The rows on screen: "Needs your OK ↓" says nothing while its card is one of them.
  const [inView, setInView] = useState<ReadonlySet<string>>(NO_KEYS);
  const onViewable = useRef<NonNullable<FlatListProps<Item>['onViewableItemsChanged']>>(
    ({ viewableItems }) => setInView(new Set(viewableItems.map((v) => v.key)))
  ).current;

  // On screen: the Mac clears its unread and holds this agent's alerts.
  useFocusEffect(
    useCallback(() => {
      setOpenChat(id);
      return () => setOpenChat(null);
    }, [id])
  );

  const showError = useCallback((text: string) => {
    announce(text, true);
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  }, []);

  // Said once on opening (what a share couldn't attach): shown from the first frame.
  useEffect(() => {
    if (!notice) return;
    announce(notice, true);
    const timer = setTimeout(() => setToast((t) => (t === notice ? null : t)), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // First open, or after a snapshot made the cached copy stale.
  useEffect(() => {
    if (connected && agent && !chat?.loaded)
      loadLatest(id).catch((e: unknown) => showError(describeError(e)));
  }, [connected, chat?.loaded, id, showError, agent]);

  const messages = chat?.messages ?? NONE;
  // "Setting up your team" is a row like a message, where it was posted.
  const setup = useApp((s) => (agent?.isMain && showsSetup(s.teamSetup) ? s.teamSetup : null));
  const setupAt = useMemo(() => (setup ? setupAnchor(setup, messages) : null), [setup, messages]);
  const items = useMemo<Item[]>(() => {
    if (!agent) return [];
    const rows = chatItems(agent, messages, pending, draft);
    return setup && chat?.loaded ? withSetupCard(rows, setupAt, !!chat.more) : rows;
  }, [agent, messages, draft, pending, setup, setupAt, chat?.loaded, chat?.more]);
  // In a pane too short for a whole card, the question it's asking stays
  // pinned at the top, so the answers at the bottom never stand alone. Only
  // a card this phone can answer: an import's review is answered on the Mac.
  const card = useMemo(() => pendingApproval(messages), [messages]);
  // The header must agree with the card: an approval in the chat is "needs you",
  // even in the beat before the status event says so.
  const asking = !!card;
  // Only the newest change card of the agent's open copy offers Keep / Discard.
  const liveCopyCard = useMemo(() => {
    const id = agent?.copy?.id;
    if (!id) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === 'changes' && messages[i].changes?.copy?.id === id)
        return messages[i].id;
    }
    return null;
  }, [messages, agent?.copy?.id]);
  // Each result's newest version is drawn in full; older ones fold.
  const newestResult = useMemo(() => new Set(newestResults(messages).values()), [messages]);
  // The failure that ended the last turn, with nothing said since: only it
  // says "send a message to try again".
  const latestFailure = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const kind = messages[i].kind;
      if (kind === 'error') return messages[i].id;
      if (kind === 'user' || kind === 'agent' || kind === 'check_in') return null;
    }
    return null;
  }, [messages]);
  const pinQuestion = !!card?.approval && pinFor === card.id;
  const reportPin = useCallback(
    (cardId: string, needsPin: boolean) =>
      setPinFor((now) => (needsPin ? cardId : now === cardId ? null : now)),
    []
  );
  const pane = useMemo<Pane>(
    () => ({
      height: listHeight,
      room: roomHeight,
      candidate: card?.id ?? null,
      pinnedId: pinQuestion && card ? card.id : null,
      report: reportPin,
    }),
    [listHeight, roomHeight, card, pinQuestion, reportPin]
  );
  // A phone in landscape: the notch or the Dynamic Island is at a side.
  const side = embedded ? { left: 0, right: 0 } : { left: insets.left, right: insets.right };
  const newest = newestSignature(items[0]);
  // Read by the scroll handler, which outlives a render.
  const newestRef = useRef(newest);
  useLayoutEffect(() => {
    newestRef.current = newest;
  }, [newest]);

  // The pill and the toast ride the keyboard with the composer, as KeyboardStickyView does.
  const keyboard = useReanimatedKeyboardAnimation();
  const lift = embedded ? 0 : insets.bottom;
  const overKeyboard = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: keyboard.height.value + interpolate(keyboard.progress.value, [0, 1], [0, lift]),
      },
    ],
  }));

  /** To the newest line, wherever the keyboard has put it, and following it again. */
  const toNewest = useCallback((animated = true) => {
    setFollow(toEnd());
    setFar(false);
    list.current?.scrollToOffset({ offset: endOffset(insetTop.current), animated });
  }, []);

  useEffect(() => {
    if (!at || !connected) return;
    let live = true;
    loadUntil(id, at).then(
      (found) => {
        if (!live) return;
        if (found) setTarget(at);
        else showError('That message is too far back to open here.');
      },
      (e: unknown) => live && showError(describeError(e))
    );
    return () => {
      live = false;
    };
  }, [at, id, connected, showError]);

  const targetIndex = target ? items.findIndex((i) => i.key === target) : -1;
  useEffect(() => {
    if (targetIndex < 0) return;
    const timer = setTimeout(
      () => list.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: true }),
      60
    );
    return () => clearTimeout(timer);
  }, [targetIndex]);

  const older = useCallback(() => {
    if (!chat?.loaded || !chat.more || loadingOlder || !connected) return;
    setLoadingOlder(true);
    loadOlder(id)
      .catch((e: unknown) => showError(describeError(e)))
      .finally(() => setLoadingOlder(false));
  }, [chat, loadingOlder, connected, id, showError]);

  // The bar's Continue: to the card where it was posted (paging back to it
  // if it's older than what's loaded), lit once.
  const [findSetup, setFindSetup] = useState(false);
  const setupShown = items.some((i) => i.key === SETUP_KEY);
  useEffect(() => {
    if (!findSetup) return;
    if (setupShown) {
      setFindSetup(false);
      setTarget(SETUP_KEY);
      const timer = setTimeout(() => setTarget((t) => (t === SETUP_KEY ? null : t)), 2000);
      return () => clearTimeout(timer);
    }
    if (chat?.more) older();
    else setFindSetup(false);
  }, [findSetup, setupShown, chat?.more, older]);

  const renderScroll = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView
        {...props}
        inverted
        offset={embedded ? 0 : insets.bottom}
        onContentInsetChange={(inset) => {
          insetTop.current = inset.top;
        }}
      />
    ),
    [insets.bottom, embedded]
  );

  const onMessageAction = useCallback(
    (m: AgentMessage) => {
      haptic.select();
      const remember = canCall('agents.memoryChange') && canCall('agents.memorySuggest');
      // The time it was sent lives here, not under every bubble.
      showActions(sentAt(m.ts), messageActions(m, remember), (action: MessageAction) => {
        switch (action) {
          case 'copy':
            void Clipboard.setStringAsync(m.kind === 'agent' ? plainText(m.text) : m.text);
            haptic.success();
            break;
          case 'copyMarkdown':
            void Clipboard.setStringAsync(m.text);
            haptic.success();
            break;
          case 'quote':
            addQuote(id, m.kind === 'agent' ? plainText(m.text) : m.text);
            break;
          case 'select':
            setSelecting(m);
            break;
          case 'remember':
            router.push({ pathname: '/remember', params: { id, messageId: m.id } });
            break;
        }
      });
    },
    [id, router]
  );

  const openPath = useCallback(
    (path: string) => {
      if (!connected) return showError(`Opening files needs ${macName}.`);
      setToast(`Getting ${path.split('/').pop()} from ${macName}…`);
      fetchPath(id, path).then(
        (file) => {
          setToast(null);
          return preview(file.uri, file.mime);
        },
        (e: unknown) => {
          haptic.error();
          showError(describeError(e));
        }
      );
    },
    [connected, id, macName, showError]
  );

  if (!agent) {
    // Only a live overview can say an agent is gone; a saved one may predate it.
    if (hasOverview && connected) {
      return <Gone embedded={embedded} macName={macName} onBack={() => router.back()} />;
    }
    // Opened from an alert with nothing saved: say why it's empty, never a bare spinner.
    return (
      <View style={styles.center}>
        {!embedded && <Stack.Screen options={{ title: 'Conversation' }} />}
        {connected ? <Spinner /> : <LinkProblem what="Your conversations" macName={macName} />}
      </View>
    );
  }

  const header = <Header agent={agent} />;
  const openSheet = () => router.push({ pathname: '/agent/[id]', params: { id } });
  const urgentBelow =
    !follow.pinned &&
    (needsYouHere(agent, chat?.messages) || asking) &&
    !messages.some((m) => m.approval?.status === 'pending' && inView.has(m.id));
  const pill = pillFor(follow, far ? FAR + 1 : 0, newest, urgentBelow);

  return (
    <View style={{ flex: 1 }}>
      {embedded ? (
        <View style={styles.embeddedHeader}>
          <Pressable
            accessibilityRole="button"
            onPress={openSheet}
            style={({ pressed }) => [{ flex: 1 }, pressed && PRESSED]}
          >
            {header}
          </Pressable>
          <IconButton name="info.circle" label={`About ${agent.name}`} onPress={openSheet} />
        </View>
      ) : (
        <Stack.Screen
          options={{
            // Back and the header's controls in this agent's colour, not the Chief's.
            headerTintColor: accent.accent,
            headerTitle: () => (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Instructions, memory, files and routines"
                onPress={openSheet}
                style={({ pressed }) => pressed && PRESSED}
              >
                {header}
              </Pressable>
            ),
            headerRight: () => (
              <IconButton
                name="info.circle"
                label={`About ${agent.name}`}
                fallback="ⓘ"
                onPress={openSheet}
              />
            ),
          }}
        />
      )}
      <View style={{ flex: 1 }} onLayout={(e) => setRoomHeight(e.nativeEvent.layout.height)}>
        {pinQuestion && card?.approval && (
          <PinnedQuestion
            title={card.approval.title}
            line={askingLine(card.approval)}
            inset={side}
            onPress={() => {
              const index = items.findIndex((i) => i.key === card.id);
              // The card's bottom edge to the bottom of the pane: its answers in reach.
              if (index >= 0)
                list.current?.scrollToIndex({ index, viewPosition: 0, animated: true });
            }}
          />
        )}
        <PathContext.Provider value={openPath}>
          <PaneContext.Provider value={pane}>
            <Animated.FlatList
              ref={list}
              inverted
              data={items}
              keyExtractor={(i) => i.key}
              itemLayoutAnimation={glide}
              onLayout={(e: LayoutChangeEvent) => setListHeight(e.nativeEvent.layout.height)}
              // Let go to read back: the rows on screen hold still while the
              // newest grows or arrives below them. Following: none, so the
              // inverted list keeps the newest line on the composer.
              maintainVisibleContentPosition={holdFor(follow)}
              renderItem={({ item, index }) => (
                <ItemView
                  item={item}
                  // Lines one after another sit at the Line gap, not a paragraph apart.
                  afterLine={
                    index + 1 < items.length
                      ? isLineItem(items[index + 1])
                      : !!chat?.loaded && !chat.more
                  }
                  agent={agent}
                  liveCopyCard={liveCopyCard}
                  newestResult={newestResult}
                  latestFailure={latestFailure}
                  onError={showError}
                  onLongPress={onMessageAction}
                  lit={item.key === target}
                />
              )}
              onScrollToIndexFailed={(info) => {
                // Not measured yet: get near it, then try again once it's laid out.
                list.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                setTimeout(
                  () =>
                    list.current?.scrollToIndex({
                      index: info.index,
                      viewPosition: 0.5,
                      animated: true,
                    }),
                  120
                );
              }}
              renderScrollComponent={renderScroll}
              contentContainerStyle={[
                styles.content,
                { paddingLeft: space.lg + side.left, paddingRight: space.lg + side.right },
              ]}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onEndReached={older}
              onEndReachedThreshold={0.6}
              onViewableItemsChanged={onViewable}
              viewabilityConfig={VIEWABILITY}
              onScrollBeginDrag={() => {
                dragging.current = true;
              }}
              onScrollEndDrag={() => {
                dragging.current = false;
              }}
              onMomentumScrollBegin={() => {
                flinging.current = true;
              }}
              onMomentumScrollEnd={() => {
                flinging.current = false;
              }}
              onScroll={(e) => {
                const distance = fromEnd(e.nativeEvent.contentOffset.y, insetTop.current);
                const byUser = dragging.current || flinging.current;
                // Bail-outs keep these from re-rendering on every event.
                setFollow((now) => scrolled(now, distance, newestRef.current, byUser));
                setFar(distance > FAR);
              }}
              scrollEventThrottle={32}
              initialNumToRender={16}
              maxToRenderPerBatch={12}
              windowSize={13}
              ListFooterComponent={
                chat?.loaded && !chat.more ? (
                  <Line text={`Start of your conversation with ${agent.name}`} />
                ) : chat?.loaded ? (
                  <View style={styles.start}>{loadingOlder && <Spinner />}</View>
                ) : undefined
              }
              ListEmptyComponent={
                chat?.loaded ? undefined : (
                  <View style={[styles.start, { transform: [{ scaleY: -1 }] }]}>
                    {connected ? (
                      <Spinner />
                    ) : (
                      // Nothing saved for this chat and the Mac away: why, and what to do.
                      <LinkProblem what="Your conversations" macName={macName} />
                    )}
                  </View>
                )
              }
            />
          </PaneContext.Provider>
        </PathContext.Provider>
      </View>
      {pill && (
        <Animated.View
          entering={ZoomIn.duration(160)}
          exiting={ZoomOut.duration(120)}
          style={[
            styles.jumpWrap,
            { bottom: composerHeight + space.md, right: space.lg + side.right },
            overKeyboard,
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              pill.says === 'urgent'
                ? 'Needs your OK. Jump to it'
                : pill.says === 'new'
                  ? 'New messages below. Jump to the newest'
                  : 'Jump to the newest'
            }
            android_ripple={ripple}
            onPress={() => toNewest()}
            // Neutral like any jump control: an amber dot says it's waiting on you, not a fill.
            style={({ pressed }) => [styles.jump, pressed && Platform.OS === 'ios' && PRESSED]}
          >
            {pill.says === 'urgent' && (
              <View style={{ marginLeft: space.xs }}>
                <Dot color={colors.accentWarning} />
              </View>
            )}
            <Icon
              name="arrow.down"
              size={iconSize.body}
              color={colors.textPrimary}
              fallback={<T>↓</T>}
            />
            {!!pill.says && (
              <T
                variant="small"
                color={colors.textPrimary}
                maxFontSizeMultiplier={chromeScale}
                style={{ fontFamily: fonts.medium, marginRight: space.xs }}
              >
                {pill.says === 'urgent' ? 'Needs your OK' : 'New'}
              </T>
            )}
          </Pressable>
        </Animated.View>
      )}
      {toast && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={[
            styles.toast,
            overKeyboard,
            {
              bottom: composerHeight + space.md + (pill ? 52 : 0),
              left: space.lg + side.left,
              right: space.lg + side.right,
            },
          ]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textStrong}>
            {toast}
          </T>
        </Animated.View>
      )}
      <KeyboardStickyView offset={{ opened: embedded ? 0 : insets.bottom }}>
        <Composer
          agent={agent}
          autoFocus={compose}
          connected={connected}
          macName={macName}
          onError={showError}
          onHeight={setComposerHeight}
          side={side}
          onSent={() => toNewest()}
          onOpenSetup={() => setFindSetup(true)}
        />
      </KeyboardStickyView>
      <SelectSheet
        message={selecting}
        onClose={() => setSelecting(null)}
        onQuote={(text) => {
          addQuote(id, text);
          setSelecting(null);
        }}
      />
    </View>
  );
}

function ItemView({
  item,
  agent,
  liveCopyCard,
  newestResult,
  latestFailure,
  onError,
  onLongPress,
  lit,
  afterLine,
}: {
  afterLine?: boolean;
  item: Item;
  agent: Agent;
  liveCopyCard?: string | null;
  newestResult?: Set<string>;
  latestFailure?: string | null;
  onError: (t: string) => void;
  onLongPress: (m: AgentMessage) => void;
  lit?: boolean;
}) {
  const styles = useStyles();
  const body =
    item.kind === 'message' ? (
      <MessageRow
        message={item.message}
        agent={agent}
        queued={isQueued(item.message, agent)}
        liveCopy={item.message.id === liveCopyCard}
        newestResult={!item.message.result || !!newestResult?.has(item.message.id)}
        latestFailure={item.message.id === latestFailure}
        onError={onError}
        onLongPress={onLongPress}
      />
    ) : item.kind === 'day' ? (
      <DaySeparator label={item.label} />
    ) : item.kind === 'pending' ? (
      <PendingRow pending={item.pending} />
    ) : item.kind === 'draft' ? (
      <DraftRow id={item.key} text={item.text} />
    ) : item.kind === 'room' ? (
      <RoomFoldRow fold={item.fold} />
    ) : item.kind === 'setup' ? (
      <TeamSetupCard chief={agent.name} onError={onError} />
    ) : (
      <WorkingRow label={item.label} agent={agent} onError={onError} />
    );
  // A run from one side sits close together; a new speaker gets room.
  const grouped = item.kind === 'message' && item.grouped;
  // A meta line about the block above it (what changed, a session started)
  // belongs to that block: it sits close under it, not a paragraph away.
  const attached =
    grouped &&
    // A live copy's changes are a Card of their own, not a line under the block.
    ((item.message.kind === 'changes' && item.message.id !== liveCopyCard) ||
      (item.message.kind === 'session' &&
        (item.message.session?.event === 'started' || item.message.session?.event === 'sent')));
  const tight = afterLine && isLineItem(item);
  return (
    <View
      style={[
        styles.item,
        grouped && styles.itemGrouped,
        attached && styles.itemAttached,
        tight && styles.itemAfterLine,
      ]}
    >
      {lit && <Glow />}
      {body}
    </View>
  );
}

/**
 * Whether a row is drawn as a Line (a time, a note, an answered card, a task
 * that started): consecutive Lines collapse to the Line gap.
 */
function isLineItem(item: Item | undefined): boolean {
  if (!item) return false;
  if (item.kind === 'day') return true;
  if (item.kind !== 'message') return false;
  const m = item.message;
  if (m.work || m.result) return false;
  switch (m.kind) {
    case 'note':
    case 'check_in':
      return true;
    case 'session':
      return m.session?.event === 'started' || m.session?.event === 'sent';
    case 'approval':
      return !!m.approval && m.approval.status !== 'pending';
    case 'error':
      return m.failure?.kind === 'usage_limit';
    default:
      return false;
  }
}

/** The row a search hit opened on: lit, then fading back. */
function Glow() {
  const styles = useStyles();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withDelay(900, withTiming(0, { duration: 900 })));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View pointerEvents="none" style={[styles.glow, style]} />;
}

/**
 * Identity only: who this is (name and role). What it's doing is said once in
 * its row on the list and once in the conversation (a bar, the working line,
 * a card), never a third time up here.
 */
function Header({ agent }: { agent: Agent }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <AgentAvatar name={agent.name} color={agent.color} size={avatarSize.header} />
      <View style={{ flexShrink: 1 }}>
        <T
          variant="headline"
          color={colors.textStrong}
          numberOfLines={1}
          maxFontSizeMultiplier={chromeScale}
        >
          {agent.name}
        </T>
        {!!agent.role && (
          <T
            variant="caption"
            color={colors.textSecondary}
            numberOfLines={1}
            maxFontSizeMultiplier={chromeScale}
          >
            {agent.role}
          </T>
        )}
      </View>
    </View>
  );
}

/** A chat for an agent the Mac no longer has (deleted, or a stale alert). */
function Gone({
  embedded,
  macName,
  onBack,
}: {
  embedded: boolean;
  macName: string;
  onBack: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.gone}>
      {!embedded && <Stack.Screen options={{ title: '' }} />}
      <T variant="title" color={colors.textStrong} style={{ textAlign: 'center' }}>
        This agent was removed
      </T>
      <T color={colors.textSecondary} style={{ textAlign: 'center' }}>
        It isn’t on {macName} any more, so there’s nothing to show or send here.
      </T>
      {!embedded && <Button title="Back to Agents" onPress={onBack} />}
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: space.lg, paddingVertical: space.md },
  // Each cell is drawn upright, so paddingTop is the space between a row and
  // the older one above it: a grouped row (same side, same run) trims it.
  // A new speaker gets clear room; consecutive items from the same speaker
  // (a change summary, a reply, a file, an approval card) are separate blocks
  // and still need air between them.
  item: { paddingTop: space.xl + space.xs },
  itemGrouped: { paddingTop: space.lg },
  itemAttached: { paddingTop: space.tight },
  // A Line under a Line: their own padding is the gap.
  itemAfterLine: { paddingTop: space.xs },
  glow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: -space.lg,
    right: -space.lg,
    backgroundColor: alpha(colors.accentFocus, 0.14),
  },
  start: { alignItems: 'center', paddingVertical: space.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 260 },
  embeddedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  pinned: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    minHeight: 44,
    backgroundColor: colors.surfacePanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  jumpWrap: { position: 'absolute', right: space.lg },
  jump: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: space.tight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    shadowColor: colors.black,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceSelected,
  },
  gone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
}));
