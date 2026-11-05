/**
 * Home: every agent, in the desktop's order (pinned, then most recently
 * active), with what needs you pulled to the top. Rows slide when the order
 * changes rather than jumping.
 *
 * The connection says nothing while it's fine; when it isn't, a notice sits
 * under the title and every row shows only what was last known. On a wide
 * screen (iPad, or a big phone in landscape) the chat opens beside the list.
 */

import type { Agent, RoomView } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  RefreshControl,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';
import { AgentRow } from '../../../components/AgentRow';
import { RoomRow } from '../../../components/RoomRow';
import { roomsOffered, sortRooms } from '../../../lib/rooms';
import { ChatView } from '../../../components/ChatView';
import { QuotaLines } from '../../../components/QuotaLines';
import { useQuotaLines } from '../../../lib/quota';
import { AgentAccent } from '../../../lib/accent';
import { ConnectionNotice, LinkProblem, useNow } from '../../../components/ConnectionPill';
import { Button, Icon, IconButton, useRipple, T, tap } from '../../../components/ui';
import { toggleFor, type AgentAction } from '../../../lib/actions';
import {
  attentionCounts,
  formatAgo,
  needsAttention,
  needsYou,
  nextNeedsYou,
  pendingApproval,
  sortAgents,
} from '../../../lib/agents';
import { haptic } from '../../../lib/haptics';
import {
  call,
  canCall,
  describeError,
  loadLatest,
  markUnread,
  refreshRooms,
  setAgentToggles,
  unpair,
} from '../../../lib/session';
import { setApp, useApp } from '../../../lib/store';
import { chromeScale, fonts, iconSize, radius, space } from '../../../lib/theme';
import { makeStyles, useColors } from '../../../lib/appearance';

type Row =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'agent'; key: string; agent: Agent }
  | { kind: 'room'; key: string; room: RoomView }
  | { kind: 'hidden'; key: string; count: number };

/** Wide enough for a list and a chat side by side. */
const SPLIT_AT = 700;
/**
 * …and tall enough for an approval card to sit whole in the chat beside it.
 * A phone in landscape is wide but not tall: there the chat beside the list
 * was a strip with three buttons and no question, so it stays single-pane.
 */
const SPLIT_MIN_HEIGHT = 600;

/** What an undoable toggle says it did ("Inbox hidden"), and the toggle that undoes it. */
const UNDO: Partial<Record<AgentAction, [string, AgentAction]>> = {
  hide: ['hidden', 'unhide'],
  mute: ['muted', 'unmute'],
};

/**
 * How far above the screen's bottom edge the native tab bar reaches. On
 * Android a tab's screen already ends above the bar. On iOS it runs under
 * it: the home indicator's inset plus the bar (49pt on iPhone, 50 on iPad;
 * iOS 26's floating bar sits higher, about 64 with its margin).
 */
function tabBarClearance(insetBottom: number): number {
  if (Platform.OS !== 'ios') return 0;
  const floating = Number.parseInt(String(Platform.Version), 10) >= 26;
  return insetBottom + (floating ? 64 : Platform.isPad ? 50 : 49);
}

export default function Agents() {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const split = width >= SPLIT_AT && height >= SPLIT_MIN_HEIGHT;
  const overview = useApp((s) => s.overview);
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const live = useApp((s) => s.link.kind === 'connected');
  const removed = useApp(
    (s) =>
      s.link.kind === 'refused' && (s.link.reason === 'revoked' || s.link.reason === 'unauthorized')
  );
  // A row that needs you says what for ("Needs your OK · Wants to edit
  // Hero.tsx"), which only the chat knows: its newest page is read for any
  // agent waiting on you whose saved chat doesn't hold the request yet.
  const unsaid = useApp(
    useShallow((s) =>
      live
        ? (s.overview?.agents ?? [])
            .filter((a) => needsYou(a) && !pendingApproval(s.chats[a.id]?.messages))
            .map((a) => `${a.id}:${a.pendingApprovals}`)
        : []
    )
  );
  useEffect(() => {
    for (const key of unsaid) loadLatest(key.slice(0, key.lastIndexOf(':'))).catch(() => {});
  }, [unsaid]);
  const caps = useApp(
    useShallow((s) => ({
      update: canCall('agents.update', s.welcome),
      markUnread: canCall('agents.markUnread', s.welcome),
    }))
  );
  // Rooms only from a Mac that does them (`welcome.features`): an older one shows none.
  const rooms = useApp((s) => (roomsOffered(s.welcome) ? s.rooms : null));
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo<Row[]>(() => {
    // A Mac that removed this phone shows nothing of its agents: only the way back.
    if (!overview || removed) return [];
    const sorted = sortAgents(overview.agents);
    const visible = sorted.filter((a) => !a.hidden);
    const hidden = sorted.filter((a) => a.hidden);
    const urgent = visible.filter(needsAttention);
    const rest = visible.filter((a) => !needsAttention(a));
    const out: Row[] = [];
    const add = (a: Agent) => out.push({ kind: 'agent', key: a.id, agent: a });
    if (urgent.length) {
      out.push({ kind: 'header', key: 'h-urgent', title: 'Needs you' });
      urgent.forEach(add);
      if (rest.length) out.push({ kind: 'header', key: 'h-rest', title: 'Agents' });
    } else if ((!live || rooms?.length) && rest.length) {
      // Offline (to say "as of"), or with Rooms below: the agents get their own label.
      out.push({ kind: 'header', key: 'h-rest', title: 'Agents' });
    }
    rest.forEach(add);
    if (rooms?.length) {
      out.push({ kind: 'header', key: 'h-rooms', title: 'Rooms' });
      for (const room of sortRooms(rooms)) out.push({ kind: 'room', key: `room:${room.id}`, room });
    }
    if (hidden.length) {
      out.push({ kind: 'hidden', key: 'hidden', count: hidden.length });
      if (showHidden) hidden.forEach(add);
    }
    return out;
  }, [overview, showHidden, removed, live, rooms]);

  const flash = useCallback((text: string, run?: () => void) => {
    const entry = { text, run: run ?? (() => {}) };
    setUndo(entry);
    setTimeout(() => setUndo((u) => (u === entry ? null : u)), 4500);
  }, []);

  const onAction = useCallback(
    (agent: Agent, action: AgentAction) => {
      const fail = (e: unknown) => {
        haptic.error();
        setError(describeError(e));
        setTimeout(() => setError(null), 4000);
      };
      if (action === 'markUnread') {
        markUnread(agent.id).catch(fail);
        return;
      }
      const input = toggleFor(action);
      if (!input) return;
      haptic.select();
      setAgentToggles(agent.id, input).then(() => {
        const undoable = UNDO[action];
        if (undoable) {
          const [verb, back] = undoable;
          flash(`${agent.name} ${verb}`, () => {
            const reverse = toggleFor(back);
            if (reverse) setAgentToggles(agent.id, reverse).catch(fail);
          });
        }
      }, fail);
    },
    [flash]
  );

  const refresh = useCallback(async () => {
    if (!live) return;
    setRefreshing(true);
    try {
      setApp({ overview: await call('agents.overview', {}) });
      if (roomsOffered(useApp.getState().welcome)) await refreshRooms();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRefreshing(false);
    }
  }, [live]);

  // In the split, something is always open: what needs you, else the top agent.
  const firstAgent = rows.find((r): r is Extract<Row, { kind: 'agent' }> => r.kind === 'agent');
  const shown =
    split && overview && !removed
      ? ((selected && overview.agents.some((a) => a.id === selected) ? selected : null) ??
        firstAgent?.agent.id ??
        null)
      : null;

  const quota = useQuotaLines();
  const list = (
    <Animated.FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentInsetAdjustmentBehavior="automatic"
      itemLayoutAnimation={LinearTransition.springify().damping(20).mass(0.6)}
      contentContainerStyle={{ paddingBottom: space['2xl'], flexGrow: 1 }}
      refreshControl={
        live ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
          />
        ) : undefined
      }
      ListHeaderComponent={
        <>
          <ConnectionNotice />
          <Refused />
          {live && !removed && (
            <Summary onOpen={split ? (agentId) => setSelected(agentId) : undefined} />
          )}
          {!removed && <QuotaLines lines={quota} style={styles.quota} />}
        </>
      }
      ListEmptyComponent={
        removed ? undefined : <Empty hasOverview={!!overview} macName={macName} />
      }
      renderItem={({ item, index }) =>
        item.kind === 'header' ? (
          <SectionHeader title={item.title} live={live} first={index === 0} />
        ) : item.kind === 'hidden' ? (
          <Pressable
            onPress={() => {
              tap();
              setShowHidden((v) => !v);
            }}
            android_ripple={ripple}
            accessibilityRole="button"
            accessibilityState={{ expanded: showHidden }}
            style={styles.hiddenToggle}
          >
            <Icon
              name={showHidden ? 'chevron.down' : 'chevron.right'}
              size={iconSize.inline}
              color={colors.textMuted}
            />
            <T variant="small" color={colors.textSecondary}>
              Hidden ({item.count})
            </T>
          </Pressable>
        ) : item.kind === 'room' ? (
          <RoomRow room={item.room} live={live} />
        ) : (
          <AgentRow
            agent={item.agent}
            caps={caps}
            live={live}
            selected={item.agent.id === shown}
            onPress={split ? () => setSelected(item.agent.id) : undefined}
            onAction={onAction}
          />
        )
      }
    />
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Agents',
          // Always on: changing it (or the header) at runtime loses the title
          // when the phone rotates back. In landscape iOS shows it small anyway.
          headerLargeTitle: true,
          headerLargeTitleShadowVisible: false,
          headerLargeStyle: { backgroundColor: colors.surfaceApp },
          headerLargeTitleStyle: { fontFamily: fonts.semibold, color: colors.textStrong },
          headerRight: () => (
            <View style={styles.headerButtons}>
              {/* Always offered: an older Mac's sheet hands the request to the Chief instead. */}
              {overview && !removed && (
                <IconButton
                  name="square.and.pencil"
                  label="New agent"
                  fallback="+"
                  onPress={() => router.push('/new-agent')}
                />
              )}
              <IconButton
                name="gearshape"
                label="Settings"
                fallback="⚙"
                onPress={() => router.push('/settings')}
              />
            </View>
          ),
        }}
      />
      {split ? (
        <View style={styles.split}>
          <View style={[styles.splitList, { paddingLeft: insets.left, width: 360 + insets.left }]}>
            {list}
          </View>
          <View style={[styles.splitChat, { paddingRight: insets.right }]}>
            {shown ? (
              <AgentAccent agentId={shown}>
                <ChatView key={shown} id={shown} embedded />
              </AgentAccent>
            ) : (
              <View style={styles.center}>
                <T color={colors.textSecondary}>Pick an agent to see its chat.</T>
              </View>
            )}
          </View>
        </View>
      ) : (
        list
      )}
      {(undo || error) && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(150)}
          style={[styles.toast, { bottom: tabBarClearance(insets.bottom) + space.md }]}
          accessibilityLiveRegion="polite"
        >
          <T variant="small" color={colors.textStrong} style={{ flex: 1 }}>
            {error ?? undo?.text}
          </T>
          {!error && undo && (
            <Button
              title="Undo"
              size="compact"
              variant="ghost"
              onPress={() => {
                undo.run();
                setUndo(null);
              }}
            />
          )}
        </Animated.View>
      )}
    </>
  );
}

/**
 * What's going on, in one line: "2 need you · 3 working", and Next, which
 * opens the first thing waiting on you at the card itself. Only while the
 * Mac is answering: offline the rows already say what was last known.
 */
function Summary({ onOpen }: { onOpen?: (agentId: string) => void }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const counts = useApp(useShallow((s) => attentionCounts(s.overview?.agents ?? [], s.chats)));
  if (!counts.needYou && !counts.working) return null;
  const parts = [
    counts.needYou && `${counts.needYou} need${counts.needYou === 1 ? 's' : ''} you`,
    counts.working && `${counts.working} working`,
  ].filter(Boolean);
  const next = () => {
    const s = useApp.getState();
    const target = nextNeedsYou(s.overview?.agents ?? [], s.chats);
    if (!target) return;
    haptic.select();
    if (onOpen) return onOpen(target.agentId);
    router.push({
      pathname: '/chat/[id]',
      params: { id: target.agentId, ...(target.messageId ? { at: target.messageId } : {}) },
    });
  };
  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      layout={LinearTransition.duration(200)}
      style={styles.summary}
      accessibilityRole="summary"
    >
      {counts.needYou > 0 && (
        <Icon
          name="exclamationmark.triangle.fill"
          size={iconSize.inline}
          color={colors.accentWarning}
        />
      )}
      <T
        variant="subhead"
        color={counts.needYou ? colors.textStrong : colors.textSecondary}
        style={{ flex: 1 }}
        maxFontSizeMultiplier={2}
      >
        {parts.join(' · ')}
      </T>
      {counts.needYou > 0 && (
        <Button
          title="Next"
          size="compact"
          variant="primary"
          onPress={next}
          accessibilityHint="Opens the first thing waiting on you"
        />
      )}
    </Animated.View>
  );
}

/** "NEEDS YOU", or "AGENTS · AS OF 4 MIN AGO" when the Mac isn't answering. */
function SectionHeader({ title, live, first }: { title: string; live: boolean; first: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  useNow(30_000); // re-render to keep "as of" current
  const asOf = useApp((s) => (s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt));
  const label = live || !asOf ? title : `${title} · as of ${formatAgo(asOf)}`;
  return (
    <T
      variant="caption"
      color={colors.textMuted}
      // A label belongs to the rows under it: close below, a clear gap above.
      style={[styles.section, !first && styles.sectionNext]}
      maxFontSizeMultiplier={chromeScale}
      accessibilityRole="header"
    >
      {label.toUpperCase()}
    </T>
  );
}

/** The Mac said no for good: removed, or one side needs updating. */
function Refused() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const link = useApp((s) => s.link);
  const refusal = useApp((s) => s.refusal);
  const name = useApp((s) => s.credentials?.name ?? 'Your Mac');
  if (link.kind !== 'refused') return null;
  const removed = link.reason === 'revoked' || link.reason === 'unauthorized';
  const impostor = link.reason === 'not_your_mac';
  // The phone's own reasons to pair again: the Mac started over with a new
  // identity, or this pairing predates identity checks.
  const repair = link.reason === 'mac_reset' || link.reason === 'pair_again';
  // Not paired any more is a state, not an accusation: the phone can't tell
  // whether someone removed it or the Mac's pairings were reset, so it says
  // what's true and both ways it happens, not the Mac's own wording too.
  return (
    <Animated.View entering={FadeIn.duration(200)} style={styles.refused}>
      <T variant="headline" color={impostor ? colors.accentErrorLight : colors.textStrong}>
        {impostor
          ? 'This isn’t your Mac'
          : repair
            ? `Pair again with ${name}`
            : removed
              ? `Not paired with ${name} any more`
              : link.reason === 'update_app'
                ? 'Update this app'
                : `Update the app on ${name}`}
      </T>
      {removed ? (
        <T color={colors.textSecondary}>
          That happens when this phone is removed on the Mac, or its pairings are reset. Your agents
          and their chats are still on the Mac: pair again to pick up where you left off.
        </T>
      ) : refusal?.message ? (
        <T color={colors.textSecondary}>{refusal.message}</T>
      ) : null}
      {(removed || impostor || repair) && (
        <Button
          title="Pair again"
          variant="primary"
          icon="qrcode.viewfinder"
          style={{ alignSelf: 'flex-start' }}
          onPress={async () => {
            await unpair();
            router.replace('/pair');
            router.push('/scan');
          }}
        />
      )}
    </Animated.View>
  );
}

function Empty({ hasOverview, macName }: { hasOverview: boolean; macName: string }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const canCreate = useApp((s) => canCall('agents.create', s.welcome));
  if (hasOverview) {
    return (
      <Animated.View entering={FadeIn.duration(200)} style={styles.emptyCentered}>
        <T variant="title" color={colors.textStrong} style={styles.centerText}>
          No agents yet
        </T>
        <T color={colors.textSecondary} style={styles.centerText}>
          {canCreate
            ? `Say what one should do and ${macName} sets it up.`
            : `On ${macName}, open Agents and create one. It shows up here as soon as it exists.`}
        </T>
        {canCreate ? (
          <Button
            title="New agent"
            variant="primary"
            icon="plus"
            onPress={() => router.push('/new-agent')}
          />
        ) : (
          <Button title="Connection details" onPress={() => router.push('/connection')} />
        )}
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={FadeIn.delay(300)} style={styles.emptyCentered}>
      <LinkProblem what="Your agents" macName={macName} />
    </Animated.View>
  );
}

const useStyles = makeStyles((colors) => ({
  section: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
    letterSpacing: 0.4,
  },
  sectionNext: { paddingTop: space.xl },
  quota: { paddingHorizontal: space.lg, paddingTop: space.md },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  hiddenToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.lg,
    minHeight: 48,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingVertical: space.sm,
    minHeight: 56,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  refused: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  emptyCentered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
    minHeight: 320,
  },
  centerText: { textAlign: 'center', maxWidth: 340 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  split: { flex: 1, flexDirection: 'row' },
  splitList: {
    width: 360,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.borderDefault,
  },
  splitChat: { flex: 1 },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    paddingRight: space.xs,
    minHeight: 48,
    borderRadius: radius.card,
    backgroundColor: colors.surfaceSelected,
  },
}));
