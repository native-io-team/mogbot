/**
 * Rooms on the phone (docs/mobile.md, "Rooms"): the row on the agents list,
 * the folded line in an agent's own chat, a room's thread and its composer.
 *
 * A room's accent is neutral: no one agent owns it. Each member's name (and
 * its badge) is drawn in that member's own colour above its lines, so who
 * said what reads at a glance; the rows themselves are the chat's own
 * (`MessageRow`), cards and all, answered on behalf of the agent that asked.
 */

import {
  newestResults,
  type Agent,
  type AgentMessage,
  type AgentRef,
  type ResultRef,
  type RoomView,
} from '@shipstudio/companion-protocol';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type FlatList, Pressable, ScrollView, View, type ScrollViewProps } from 'react-native';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { AccentProvider, agentTint, useAccent } from '../lib/accent';
import { announce } from '../lib/a11y';
import { mentionQuery } from '../lib/composer';
import { clearComposer, liveMentions, setComposer, useComposerDraft } from '../lib/drafts';
import { haptic } from '../lib/haptics';
import {
  addressLine,
  answerers,
  EVERYONE,
  liveCopyCards,
  memberNames,
  membersOf,
  mentionsEveryone,
  roomItems,
  roomKey,
  ROOM_INTRO,
  roomSuggestions,
  toLine,
  turnsLine,
  workingHere,
  type RoomItem,
} from '../lib/rooms';
import { describeError, loadLatest, loadOlder, sendToRoom, setOpenChat } from '../lib/session';
import { getApp, useApp } from '../lib/store';
import { avatarSize, chromeScale, fonts, iconSize, mix, radius, space } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';
import { AgentAvatar, Spinner } from './agent';
import { DaySeparator, DraftRow, MessageRow, PendingRow, WorkingRow } from './chat';
import { MentionContext } from './Markdown';
import { ComposerField, RoundButton } from './Composer';
import { RoomBars } from './ConversationBars';
import { Icon, T, useRipple } from './ui';
import { StackedAvatars } from './RoomRow';

const NONE: never[] = [];

/** A member's name in its own colour, readable on either surface (as its badge's initials). */
function useNameColor(color: string) {
  const colors = useColors();
  const appearance = useAppearance();
  return mix(agentTint(color, appearance), colors.textPrimary, 0.7);
}

/** A member's name and badge over the first of its lines in a run. */
function Speaker({ agent }: { agent: Agent }) {
  const styles = useStyles();
  const color = useNameColor(agent.color);
  return (
    <View style={styles.speaker}>
      <AgentAvatar name={agent.name} color={agent.color} size={avatarSize.group} />
      <T variant="small" color={color} style={{ fontFamily: fonts.semibold }} numberOfLines={1}>
        {agent.name}
      </T>
    </View>
  );
}

const glide = LinearTransition.duration(220);

/** One room, full screen: its thread and its composer, in the neutral accent. */
export function RoomScreen({ id }: { id: string }) {
  return (
    <AccentProvider color={null}>
      <RoomChat id={id} />
    </AccentProvider>
  );
}

function RoomChat({ id }: { id: string }) {
  const colors = useColors();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const key = roomKey(id);
  const room = useApp((s) => s.rooms?.find((r) => r.id === id));
  const roomsKnown = useApp((s) => s.rooms !== null);
  const agents = useApp((s) => s.overview?.agents ?? NONE);
  const chat = useApp((s) => s.chats[key]);
  const pending = useApp((s) => s.pending[key] ?? NONE);
  const connected = useApp((s) => s.link.kind === 'connected');
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const members = useMemo(() => (room ? membersOf(room, agents) : NONE), [room, agents]);
  const drafts = useApp(
    useShallow((s) => Object.fromEntries(members.map((m) => [m.id, s.drafts[m.id]])))
  );
  const list = useRef<FlatList<RoomItem>>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(90);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setOpenChat(key);
      return () => setOpenChat(null);
    }, [key])
  );

  const showError = useCallback((text: string) => {
    announce(text, true);
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 4000);
  }, []);

  useEffect(() => {
    if (connected && room && !chat?.loaded)
      loadLatest(key).catch((e: unknown) => showError(describeError(e)));
  }, [connected, chat?.loaded, key, room, showError]);

  const messages = chat?.messages ?? NONE;
  const present = useMemo(
    () =>
      Object.fromEntries(Object.entries(drafts).filter(([, d]) => !!d)) as Record<
        string,
        { id: string; text: string }
      >,
    [drafts]
  );
  const items = useMemo(
    () => (room ? roomItems(room.id, members, messages, pending, present) : []),
    [room, members, messages, pending, present]
  );
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  // A member's @mention of another in its reply is drawn in that member's colour.
  const appearance = useAppearance();
  const mentionColors = useMemo(
    () =>
      members.map((m) => ({
        name: m.name,
        color: mix(agentTint(m.color, appearance), colors.textPrimary, 0.7),
      })),
    [members, appearance, colors.textPrimary]
  );
  // As in each member's own chat: the newest card for its open copy offers
  // Keep / Discard, and each result's newest version is drawn in full.
  const liveCopies = useMemo(() => liveCopyCards(members, messages), [members, messages]);
  const newest = useMemo(() => new Set(newestResults(messages).values()), [messages]);
  // A room message can't revise a result: the member's own chat opens with
  // the request staged in its composer, as on the desk.
  const router = useRouter();
  const askForChanges = useCallback(
    (agentId: string, ref: ResultRef) => {
      setComposer(agentId, { revising: ref });
      router.push({ pathname: '/chat/[id]', params: { id: agentId } });
    },
    [router]
  );

  const older = useCallback(() => {
    if (!chat?.loaded || !chat.more || loadingOlder || !connected) return;
    setLoadingOlder(true);
    loadOlder(key)
      .catch((e: unknown) => showError(describeError(e)))
      .finally(() => setLoadingOlder(false));
  }, [chat, loadingOlder, connected, key, showError]);

  const renderScroll = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView {...props} inverted offset={insets.bottom} />
    ),
    [insets.bottom]
  );

  if (!room) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '' }} />
        {roomsKnown ? (
          <>
            <T variant="title" color={colors.textStrong} style={{ textAlign: 'center' }}>
              This room was deleted
            </T>
            <T color={colors.textSecondary} style={{ textAlign: 'center' }}>
              Its agents are still on {macName}, with their own chats.
            </T>
          </>
        ) : (
          <Spinner />
        )}
      </View>
    );
  }

  const working = workingHere(members, room.id);
  const fallback = members[0];

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerTintColor: colors.textPrimary,
          headerTitle: () => <RoomHeader room={room} members={members} working={working.length} />,
        }}
      />
      <MentionContext.Provider value={mentionColors}>
        <Animated.FlatList
          ref={list}
          inverted
          data={items}
          keyExtractor={(i) => i.key}
          itemLayoutAnimation={glide}
          renderScrollComponent={renderScroll}
          contentContainerStyle={[
            styles.content,
            { paddingLeft: space.lg + insets.left, paddingRight: space.lg + insets.right },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onEndReached={older}
          onEndReachedThreshold={0.6}
          renderItem={({ item }) => (
            <RoomItemView
              item={item}
              agent={item.kind === 'message' ? byId.get(item.message.agentId) : undefined}
              fallback={fallback}
              memberCount={members.length}
              liveCopy={item.kind === 'message' && liveCopies.has(item.message.id)}
              newestResult={
                item.kind !== 'message' || !item.message.result || newest.has(item.message.id)
              }
              onAskForChanges={askForChanges}
              onError={showError}
            />
          )}
          ListFooterComponent={
            chat?.loaded && !chat.more ? (
              <View style={styles.start}>
                <StackedAvatars members={members} />
                <T variant="caption" color={colors.textSecondary} style={{ textAlign: 'center' }}>
                  {room.name} · {ROOM_INTRO}
                </T>
              </View>
            ) : chat?.loaded ? (
              <View style={styles.start}>{loadingOlder && <Spinner />}</View>
            ) : undefined
          }
        />
      </MentionContext.Provider>
      {toast && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={[styles.toast, { bottom: composerHeight + space.md }]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textStrong}>
            {toast}
          </T>
        </Animated.View>
      )}
      <KeyboardStickyView offset={{ opened: insets.bottom }}>
        <RoomComposer
          room={room}
          members={members}
          connected={connected}
          macName={macName}
          working={working.length > 0}
          onError={showError}
          onHeight={setComposerHeight}
          onSent={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
        />
      </KeyboardStickyView>
      {members.length === 0 && (
        <T color={colors.textSecondary} style={styles.center}>
          Nobody is in this room any more.
        </T>
      )}
    </View>
  );
}

function RoomHeader({
  room,
  members,
  working,
}: {
  room: RoomView;
  members: Agent[];
  working: number;
}) {
  const colors = useColors();
  const styles = useStyles();
  const connected = useApp((s) => s.link.kind === 'connected');
  const line =
    working > 0 && connected
      ? working === 1
        ? `${members.find((m) => m.status.room === room.id)?.name ?? 'One'} is replying`
        : `${working} are replying`
      : memberNames(members);
  return (
    <View style={styles.header}>
      <StackedAvatars members={members} size="header" />
      <View style={{ flexShrink: 1 }}>
        <T
          variant="headline"
          color={colors.textStrong}
          numberOfLines={1}
          maxFontSizeMultiplier={chromeScale}
        >
          {room.name}
        </T>
        <Animated.View key={line} entering={FadeIn.duration(180)}>
          <T
            variant="caption"
            color={colors.textSecondary}
            numberOfLines={1}
            maxFontSizeMultiplier={chromeScale}
          >
            {line}
          </T>
        </Animated.View>
      </View>
    </View>
  );
}

function RoomItemView({
  item,
  agent,
  fallback,
  memberCount,
  liveCopy,
  newestResult,
  onAskForChanges,
  onError,
}: {
  item: RoomItem;
  /** The member a line is from (absent for yours and the room's own). */
  agent?: Agent;
  /** Any member, for the rows that only need one to draw (yours, notes). */
  fallback?: Agent;
  memberCount: number;
  /** The newest card for the member's open copy: it offers Keep / Discard. */
  liveCopy: boolean;
  /** The newest version of its result: drawn in full, with Ask for changes. */
  newestResult: boolean;
  onAskForChanges: (agentId: string, ref: ResultRef) => void;
  onError: (text: string) => void;
}) {
  const styles = useStyles();
  const colors = useColors();
  const members = useApp((s) => s.overview?.agents ?? NONE);
  const of = (id: string) => members.find((a) => a.id === id);
  let body: React.ReactNode = null;
  if (item.kind === 'message') {
    const m: AgentMessage = item.message;
    const who = agent ?? fallback;
    const to = m.kind === 'user' ? toLine(m.mentions, memberCount) : null;
    body = who ? (
      <View style={{ gap: space.xs }}>
        {item.speaker && agent && <Speaker agent={agent} />}
        <MessageRow
          message={m}
          agent={who}
          queued={false}
          liveCopy={liveCopy}
          newestResult={newestResult}
          onAskForChanges={onAskForChanges}
          onError={onError}
        />
        {to && (
          <T variant="caption" color={colors.textMuted} style={styles.to}>
            {to}
          </T>
        )}
      </View>
    ) : null;
  } else if (item.kind === 'day') {
    body = <DaySeparator label={item.label} />;
  } else if (item.kind === 'pending') {
    body = <PendingRow pending={item.pending} />;
  } else if (item.kind === 'draft') {
    const a = of(item.agentId);
    body = (
      <View style={{ gap: space.xs }}>
        {a && <Speaker agent={a} />}
        <DraftRow id={item.key} text={item.text} />
      </View>
    );
  } else {
    const a = of(item.agentId);
    body = (
      <View style={{ gap: space.xs }}>
        {a && <Speaker agent={a} />}
        <WorkingRow label={item.label} agent={a} onError={onError} />
      </View>
    );
  }
  const grouped = item.kind === 'message' && item.grouped;
  return <View style={[styles.item, grouped && styles.itemGrouped]}>{body}</View>;
}

/**
 * The room's field: @ offers the room's members and @everyone (nobody
 * else). Sending decides who answers as the Mac will; when that's nobody
 * (no one named, no lead), it asks "Who should answer?" first, with the
 * members and Everyone to pick from.
 */
export function RoomComposer({
  room,
  members,
  connected,
  macName,
  working,
  onError,
  onSent,
  onHeight,
}: {
  room: RoomView;
  members: Agent[];
  connected: boolean;
  macName: string;
  working: boolean;
  onError: (text: string) => void;
  onSent: () => void;
  onHeight?: (h: number) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const key = roomKey(room.id);
  const draft = useComposerDraft(key);
  const [asking, setAsking] = useState(false);
  const hasContent = draft.text.trim().length > 0;
  const suggestions = useMemo(
    () => roomSuggestions(members, mentionQuery(draft.text)),
    [members, draft.text]
  );

  const setText = (text: string) => {
    setAsking(false);
    setComposer(key, { text, mentions: liveMentions(text, draft.mentions) });
  };

  const pick = (peer: AgentRef) => {
    const text = draft.text.replace(/@[\w.-]*$/, `@${peer.name} `);
    const mentions = draft.mentions.some((m) => m.id === peer.id)
      ? draft.mentions
      : [...draft.mentions, { id: peer.id, name: peer.name }];
    setComposer(key, { text, mentions });
    haptic.select();
  };

  /** Send what's typed to `to` (ids) or everyone; with neither, decide as the Mac would. */
  const submit = (choice?: { mentions: string[]; everyone: boolean }) => {
    const current = getApp().composer[key];
    const text = current?.text.trim() ?? '';
    if (!text) return;
    const named = liveMentions(current?.text ?? '', current?.mentions ?? [])
      .map((m) => m.id)
      .filter((m) => m !== EVERYONE.id);
    const everyone = choice?.everyone ?? mentionsEveryone(text);
    const mentions = choice?.mentions ?? named;
    if (answerers(room, mentions, everyone) === 'ask') {
      haptic.light();
      setAsking(true);
      announce('Who should answer?');
      return;
    }
    haptic.light();
    setAsking(false);
    clearComposer(key);
    onSent();
    sendToRoom(room.id, text, mentions, everyone).catch((error: unknown) => {
      haptic.error();
      onError(describeError(error));
    });
  };

  const hint = !connected
    ? hasContent
      ? `Not connected · Send waits for ${macName}`
      : 'Not connected · what you type stays here'
    : working
      ? turnsLine(room)
      : // Who will answer what's typed, in the desk's words.
        addressLine(
          room,
          members,
          liveMentions(draft.text, draft.mentions)
            .map((m) => m.id)
            .filter((m) => m !== EVERYONE.id),
          mentionsEveryone(draft.text)
        );

  return (
    <View
      style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}
      onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
    >
      <RoomBars />
      {asking ? (
        <Animated.View entering={FadeIn.duration(150)} style={{ gap: space.sm }}>
          <T variant="small" color={colors.textStrong} style={styles.askTitle}>
            Who should answer?
          </T>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {members.map((a) => (
              <Chip
                key={a.id}
                agent={a}
                onPress={() => submit({ mentions: [a.id], everyone: false })}
              />
            ))}
            <Chip label="Everyone" onPress={() => submit({ mentions: [], everyone: true })} />
          </ScrollView>
        </Animated.View>
      ) : (
        suggestions.length > 0 && (
          <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)}>
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {suggestions.map((a) => {
                const agent = members.find((m) => m.id === a.id);
                return agent ? (
                  <Chip key={a.id} agent={agent} onPress={() => pick(a)} />
                ) : (
                  <Chip key={a.id} label="everyone" onPress={() => pick(a)} />
                );
              })}
            </ScrollView>
          </Animated.View>
        )
      )}
      {hint && !asking && (
        <T variant="caption" color={colors.textSecondary} style={styles.hint}>
          {hint}
        </T>
      )}
      <View style={styles.composerRow}>
        <ComposerField
          value={draft.text}
          onChangeText={setText}
          placeholder={`Message ${room.name}`}
          label={`Message ${room.name}`}
        >
          <RoundButton
            label={connected ? 'Send' : `Send when ${macName} answers`}
            disabled={!hasContent}
            onPress={() => submit()}
            tone={hasContent ? 'accent' : 'off'}
          >
            <Icon
              name="arrow.up"
              size={iconSize.body}
              color={hasContent ? accent.onAccent : colors.textMuted}
              fallback={<T color={hasContent ? accent.onAccent : colors.textMuted}>↑</T>}
            />
          </RoundButton>
        </ComposerField>
      </View>
    </View>
  );
}

function Chip({ agent, label, onPress }: { agent?: Agent; label?: string; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const name = agent?.name ?? label ?? '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={agent ? `Mention ${name}` : name}
      android_ripple={ripple}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      {agent ? (
        <AgentAvatar name={agent.name} color={agent.color} size={avatarSize.group} />
      ) : (
        <Icon name="person.2" size={iconSize.inline} color={colors.textSecondary} />
      )}
      <T variant="small" color={colors.textPrimary} maxFontSizeMultiplier={chromeScale}>
        {name}
      </T>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  stacked: {
    position: 'absolute',
    // A ring of the page around each badge, so overlapping ones stay apart.
    borderWidth: 2,
    borderColor: colors.surfaceApp,
    backgroundColor: colors.surfaceApp,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 72,
    backgroundColor: colors.surfaceApp,
  },
  selected: { backgroundColor: colors.surfaceControl },
  text: { flex: 1, gap: space['2xs'] },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  name: { flexShrink: 1, flexGrow: 1 },
  mark: { width: 14, alignItems: 'flex-end' },
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.tight,
    alignSelf: 'flex-start',
    paddingVertical: space.xs,
  },
  speaker: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  content: { paddingVertical: space.md },
  item: { paddingTop: space.xl },
  itemGrouped: { paddingTop: space.md },
  to: { alignSelf: 'flex-end', marginRight: space.xs },
  start: {
    alignItems: 'center',
    paddingVertical: space.xl,
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 260 },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceSelected,
  },
  composer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    backgroundColor: colors.surfaceApp,
    gap: space.sm,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end' },
  hint: { marginLeft: space.md },
  askTitle: { marginLeft: space.md, fontFamily: fonts.medium },
  chips: { gap: space.sm, paddingHorizontal: space.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceControl,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: colors.surfaceControlHover },
}));
