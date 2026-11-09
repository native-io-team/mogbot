/**
 * Home: every agent, in the desktop's order (pinned, then most recently
 * active), with what needs you pulled to the top. Rows slide when the order
 * changes rather than jumping.
 *
 * The connection says nothing while it's fine; when it isn't, a notice sits
 * under the title and every row shows only what was last known. On a wide
 * screen (iPad, or a big phone in landscape) the chat opens beside the list.
 */

import { shareStructure } from '../../../lib/structure';
import {
  CHIEF_LOOK,
  teamLine,
  workingCount,
  type Agent,
  type RoomView,
} from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { takeExitNotice } from '../../../lib/crash';
import {
  Platform,
  RefreshControl,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Arrive } from '../../../components/Arrive';
import { useArrivedKeys } from '../../../lib/arrivals';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useShallow } from 'zustand/react/shallow';
import { AgentAvatar } from '../../../components/agent';
import { AgentRow } from '../../../components/AgentRow';
import { ImportChoiceCard } from '../../../components/ImportChoiceCard';
import { RoomRow } from '../../../components/RoomRow';
import { pendingHere, roomKey, roomsOffered, sortRooms } from '../../../lib/rooms';
import { ChatView } from '../../../components/ChatView';
import { QuotaLines } from '../../../components/QuotaLines';
import { useQuotaLines } from '../../../lib/quota';
import { AgentAccent } from '../../../lib/accent';
import { ConnectionNotice, LinkProblem, useNow } from '../../../components/ConnectionPill';
import { DemoCard } from '../../../components/DemoCard';
import { Button, Dot, Icon, IconButton, useRipple, T, tap } from '../../../components/ui';
import { toggleFor, type AgentAction } from '../../../lib/actions';
import { formatAgo, needsYou, pendingApproval } from '../../../lib/agents';
import { barWords, buildHome, type HomeBar } from '../../../lib/home';
import { progress } from '../../../lib/teamSetup';
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
import { useRefresh } from '../../../lib/refresh';
import { RefreshStatus } from '../../../components/RefreshStatus';
import { largeTitle } from '../../../lib/navigation';
import {
  agentColorKeys,
  avatarSize,
  chromeScale,
  depthOf,
  iconSize,
  PRESSED,
  radius,
  space,
} from '../../../lib/theme';
import { makeStyles, useColors } from '../../../lib/appearance';

type Row =
  | { kind: 'header'; key: string; title: string; team?: number }
  | { kind: 'team'; key: string; working: number }
  | { kind: 'agent'; key: string; agent: Agent; quiet?: boolean }
  | { kind: 'bar'; key: string; bar: HomeBar }
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

/** The list's content box: a little room under the last row, and nothing else. */
const LIST_CONTENT = { paddingBottom: space['2xl'] } as const;
const ROW_LAYOUT = LinearTransition.springify().damping(20).mass(0.6);

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
  // The context, not useHeaderHeight: that throws where there's no header (a test).
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
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
  // A room's row says "Needs your OK" for a card left waiting after the turn
  // ended, which only its thread shows: as for agents, its newest page is read
  // for any room with a member waiting on you whose saved thread doesn't hold
  // a pending card yet. (The card is in that member's own count, wherever it
  // was raised, so this may read a room that turns out not to hold it.)
  const roomsUnsaid = useApp(
    useShallow((s) => {
      if (!live || !roomsOffered(s.welcome)) return [];
      const agents = s.overview?.agents ?? [];
      return (s.rooms ?? [])
        .map((r) => {
          const owed = agents
            .filter((a) => r.members.includes(a.id) && (a.pendingApprovals ?? 0) > 0)
            .reduce((n, a) => n + (a.pendingApprovals ?? 0), 0);
          const thread = s.chats[roomKey(r.id)]?.messages;
          return owed > 0 && !(thread && pendingHere(thread)) ? `${r.id}:${owed}` : '';
        })
        .filter(Boolean);
    })
  );
  useEffect(() => {
    for (const key of roomsUnsaid) {
      loadLatest(roomKey(key.slice(0, key.lastIndexOf(':')))).catch(() => {});
    }
  }, [roomsUnsaid]);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last run ended in a crash: said once, where the app opens.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void takeExitNotice().then((notice) => {
      if (!live || !notice) return;
      setError(notice);
      timer = setTimeout(() => setError((e) => (e === notice ? null : e)), 8000);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const teamSetup = useApp((s) => s.teamSetup);
  const rows = useMemo<Row[]>(() => {
    // A Mac that removed this phone shows nothing of its agents: only the way back.
    if (!overview || removed) return [];
    // The Chief first, always; one bar for what waits on you; pinned; the rest (lib/home).
    const home = buildHome(overview.agents, live ? teamSetup : null);
    const out: Row[] = [];
    const add = (a: Agent) =>
      out.push({ kind: 'agent', key: a.id, agent: a, quiet: home.quiet.has(a.id) });
    // Offline (to say "as of"), or with Rooms below: the agents get their own label.
    // The team at a glance, as on the desk: "3 working" or "All quiet". Only
    // while connected: offline, who is working isn't known.
    const working = live ? workingCount(overview.agents) : undefined;
    if (!live || rooms?.length)
      out.push({ kind: 'header', key: 'h-rest', title: 'Agents', team: working });
    else if (working !== undefined) out.push({ kind: 'team', key: 'team', working });
    if (home.chief) add(home.chief);
    if (home.bar) out.push({ kind: 'bar', key: 'bar', bar: home.bar });
    home.pinned.forEach(add);
    home.rest.forEach(add);
    const hidden = home.hidden;
    if (rooms?.length) {
      out.push({ kind: 'header', key: 'h-rooms', title: 'Rooms' });
      for (const room of sortRooms(rooms)) out.push({ kind: 'room', key: `room:${room.id}`, room });
    }
    if (hidden.length) {
      out.push({ kind: 'hidden', key: 'hidden', count: hidden.length });
      if (showHidden) hidden.forEach(add);
    }
    return out;
  }, [overview, showHidden, removed, live, rooms, teamSetup]);

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

  // Offline, a pull just lets go: the control stays mounted either way, since
  // unmounting one mid-refresh leaves the list held down (lib/refresh).
  const { refreshing, onRefresh, outcome, dismiss } = useRefresh(async () => {
    if (useApp.getState().link.kind !== 'connected') throw new Error('offline');
    try {
      const fresh = await call('agents.overview', {});
      setApp((s) => ({ overview: shareStructure(s.overview, fresh) }));
      if (roomsOffered(useApp.getState().welcome)) await refreshRooms();
    } catch (e) {
      setError(describeError(e));
      throw e;
    }
  });

  // In the split, something is always open: what needs you, else the top agent.
  const firstAgent = rows.find((r): r is Extract<Row, { kind: 'agent' }> => r.kind === 'agent');
  const shown =
    split && overview && !removed
      ? ((selected && overview.agents.some((a) => a.id === selected) ? selected : null) ??
        firstAgent?.agent.id ??
        null)
      : null;

  const quota = useQuotaLines();
  // Memoised on what the buttons depend on, not rebuilt each render: see `largeTitle`.
  const hasList = !!overview && !removed;
  const screenOptions = useMemo(
    () =>
      largeTitle(colors, 'Agents', {
        // Always on: changing it (or the header) at runtime loses the title
        // when the phone rotates back. In landscape iOS shows it small anyway.
        headerRight: () => (
          <View style={styles.headerButtons}>
            {/* Always offered: an older Mac's sheet hands the request to the Chief instead. */}
            {hasList && (
              <IconButton
                name="plus"
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
      }),
    [colors, styles, hasList, router]
  );
  // An agent made while the list is up rises into it once; the list as it
  // loads holds still.
  const agentKeys = useMemo(() => rows.flatMap((r) => (r.kind === 'agent' ? [r.key] : [])), [rows]);
  const arrived = useArrivedKeys(agentKeys, !!overview, false);
  const list = (
    <Animated.FlatList
      data={rows}
      keyExtractor={(r) => r.key}
      contentInsetAdjustmentBehavior="automatic"
      // Rows don't spring into a new order while the list itself springs back
      // from a pull: two springs at once is the likeliest source of its jank.
      itemLayoutAnimation={refreshing ? undefined : ROW_LAYOUT}
      // No flexGrow: with the automatic insets (the large title above, the
      // tab bar below) a content box grown to the list's own height is that
      // height *plus* both insets, so a list with only the Chief scrolled a
      // screen's worth into nothing. The empty state keeps its own minHeight.
      contentContainerStyle={LIST_CONTENT}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
      ListHeaderComponent={
        <>
          <RefreshStatus outcome={outcome} onRetry={onRefresh} onDismiss={dismiss} />
          <DemoCard />
          <ConnectionNotice />
          <Refused />
          <ImportChoiceCard />
          {!removed && <QuotaLines lines={quota} style={styles.quota} />}
        </>
      }
      ListEmptyComponent={
        removed ? undefined : <Empty hasOverview={!!overview} macName={macName} />
      }
      renderItem={({ item, index }) =>
        item.kind === 'header' ? (
          <SectionHeader
            title={item.title}
            live={live}
            first={index === 0}
            action={item.team !== undefined ? <TeamLine working={item.team} /> : undefined}
          />
        ) : item.kind === 'team' ? (
          <View style={styles.team}>
            <TeamLine working={item.working} />
          </View>
        ) : item.kind === 'bar' ? (
          <AttentionBar
            bar={item.bar}
            onOpenChief={(id) =>
              split ? setSelected(id) : router.push({ pathname: '/chat/[id]', params: { id } })
            }
          />
        ) : item.kind === 'hidden' ? (
          <Pressable
            onPress={() => {
              tap();
              setShowHidden((v) => !v);
            }}
            android_ripple={ripple}
            accessibilityRole="button"
            accessibilityState={{ expanded: showHidden }}
            style={({ pressed }) => [styles.hiddenToggle, pressed && PRESSED]}
          >
            <Icon
              name={showHidden ? 'chevron.down' : 'chevron.right'}
              size={iconSize.inline}
              color={colors.textMuted}
            />
            <T variant="small" color={colors.textSecondary}>
              Hidden · {item.count}
            </T>
          </Pressable>
        ) : item.kind === 'room' ? (
          <RoomRow room={item.room} live={live} />
        ) : arrived.has(item.key) ? (
          <Arrive>
            <AgentRow
              agent={item.agent}
              quiet={item.quiet}
              caps={caps}
              live={live}
              selected={item.agent.id === shown}
              onPress={split ? () => setSelected(item.agent.id) : undefined}
              onAction={onAction}
            />
          </Arrive>
        ) : (
          <AgentRow
            agent={item.agent}
            quiet={item.quiet}
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
      <Stack.Screen options={screenOptions} />
      {split ? (
        <View style={styles.split}>
          <View style={[styles.splitList, { paddingLeft: insets.left, width: 360 + insets.left }]}>
            {list}
          </View>
          {/* Under the translucent bar (and iPad's tab bar in it): padded by the
              header's height, as the list is by its own inset (lib/navigation.ts). */}
          <View
            style={[styles.splitChat, { paddingRight: insets.right, paddingTop: headerHeight }]}
          >
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
 * "NEEDS YOU", or "AGENTS · AS OF 4 MIN AGO" when the Mac isn't answering,
 * with an optional text action at the right.
 */
function SectionHeader({
  title,
  live,
  first,
  action,
}: {
  title: string;
  live: boolean;
  first: boolean;
  action?: ReactNode;
}) {
  const colors = useColors();
  const styles = useStyles();
  useNow(30_000); // re-render to keep "as of" current
  const asOf = useApp((s) => (s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt));
  const label = live || !asOf ? title : `${title} · as of ${formatAgo(asOf)}`;
  return (
    // A label belongs to the rows under it: close below, a clear gap above.
    <View style={[styles.section, !first && styles.sectionNext]}>
      <T
        variant="caption"
        color={colors.textMuted}
        style={styles.sectionLabel}
        maxFontSizeMultiplier={chromeScale}
        accessibilityRole="header"
      >
        {label.toUpperCase()}
      </T>
      {action}
    </View>
  );
}

/**
 * "3 working", with a running dot (status, never the accent), or "All quiet".
 * Always there while connected, so the rows under it never move.
 */
function TeamLine({ working }: { working: number }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.teamLine} accessibilityRole="text">
      <Dot color={working > 0 ? colors.statusRunning : colors.textFaint} size={space.tight} />
      <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
        {teamLine(working)}
      </T>
    </View>
  );
}

/**
 * One calm row for everything waiting on you, under the Chief: "A few things
 * to finish setting up your team" (opens the Chief's chat, where the
 * checklist is) or "N agents need your OK" (opens them grouped in a sheet).
 * Never a section listing every agent.
 */
function AttentionBar({ bar, onOpenChief }: { bar: HomeBar; onOpenChief: (id: string) => void }) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const router = useRouter();
  const chief = useApp((s) => s.overview?.agents.find((a) => a.isMain) ?? null);
  const setup = useApp((s) => s.teamSetup);
  const [title, line] = barWords(
    bar,
    chief?.name ?? 'Chief of Staff',
    setup ? progress(setup) : undefined
  );
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        if (bar.kind === 'needs') router.push('/catch-up');
        else if (chief) onOpenChief(chief.id);
      }}
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${line}`}
      style={({ pressed }) => [styles.bar, pressed && PRESSED]}
    >
      <View style={styles.barText}>
        <T variant="headline" color={colors.textStrong} numberOfLines={2}>
          {title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {line}
        </T>
      </View>
      <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
    </Pressable>
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
        {/* The brand's key, blank and waiting: the first one is yours to make. */}
        <View style={styles.emptyMark}>
          <AgentAvatar
            name=""
            color={agentColorKeys.all[0]}
            look={CHIEF_LOOK}
            size={avatarSize.sheet}
          />
        </View>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionLabel: { flex: 1, letterSpacing: 0.4 },
  sectionNext: { paddingTop: space.xl },
  team: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs },
  teamLine: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  quota: { paddingHorizontal: space.lg, paddingTop: space.md },
  headerButtons: { flexDirection: 'row', alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 56,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    boxShadow: depthOf(colors).card,
    overflow: 'hidden',
  },
  barText: { flex: 1, gap: space.xs },
  hiddenToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.lg,
    minHeight: 48,
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
    overflow: 'hidden',
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
  emptyMark: { marginBottom: space.xs },
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

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../../components/ScreenError';
