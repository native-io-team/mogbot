/**
 * Catch up: the phone's inbox for its agents. Everything waiting on you,
 * across every agent, grouped by agent (`lib/needsYou.ts`,
 * `lib/catchUpTab.ts`), then what happened since you last caught up. The
 * tab's badge counts the waiting rows; a pushed "needs you" opens here; the
 * app opens here when anything waits (lib/landing.ts).
 *
 * Each row is one line of what's asked and the agent's one line of why. A
 * short plain request the Mac marked low-risk is answered on its row
 * (Deny · Allow, inert for a beat as on every card); anything risky (the
 * danger icon), unclassified or longer has Review, which opens it in full.
 * A key, a login, a question or a turn that didn't finish opens where it is
 * answered; changes in a copy are kept or discarded right here. Swipe a row
 * left for its chat (also in the VoiceOver actions). Answered rows leave by
 * themselves, here or at the desk. "One at a time" goes through them full
 * screen.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import { failurePill, previewText } from '@shipstudio/companion-protocol';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { AgentKey } from '../../../components/AgentKey';
import { useArmed } from '../../../components/ApprovalCard';
import { ConnectionBar } from '../../../components/ConnectionPill';
import { useCopyParts } from '../../../components/copy';
import { DemoCard } from '../../../components/DemoCard';
import { RefreshStatus } from '../../../components/RefreshStatus';
import { Button, Icon, T, useRipple } from '../../../components/ui';
import { AgentAccent } from '../../../lib/accent';
import {
  agentKeyState,
  askingLine,
  engineName,
  failedTurn,
  failureLine,
  formatAgo,
} from '../../../lib/agents';
import { makeStyles, useColors } from '../../../lib/appearance';
import {
  fromLine,
  groupByAgent,
  headline,
  FIRST_LOOK_MS,
  sinceItems,
  sinceTitle,
  type SinceItem,
} from '../../../lib/catchUpTab';
import { haptic } from '../../../lib/haptics';
import { SETUP_TITLE } from '../../../lib/home';
import { loadSeen, markSeen } from '../../../lib/landing';
import { largeTitle } from '../../../lib/navigation';
import {
  answersInPlace,
  feedItems,
  highRisk,
  rowAction,
  type FeedItem,
} from '../../../lib/needsYou';
import { useInFlight } from '../../../lib/once';
import { useRefresh } from '../../../lib/refresh';
import { answerApproval, canCall, describeError, loadLatest } from '../../../lib/session';
import { announce } from '../../../lib/a11y';
import { useApp } from '../../../lib/store';
import { progress as setupProgress } from '../../../lib/teamSetup';
import {
  chromeScale,
  fonts,
  heroMark,
  iconSize,
  keySize,
  PRESSED,
  radius,
  space,
} from '../../../lib/theme';

/** Every row comes and goes on these: still under Reduce Motion. */
const ENTER = FadeIn.duration(200).reduceMotion(ReduceMotion.System);
const LEAVE = FadeOut.duration(180).reduceMotion(ReduceMotion.System);
const MOVE = LinearTransition.duration(220).reduceMotion(ReduceMotion.System);
/** The swipe's one action ("Chat"). */
const SWIPE_W = 84;

/** Agents whose chat the tab needs and this phone hasn't loaded. */
function toLoad(agents: Agent[], chats: Record<string, { loaded?: boolean } | undefined>) {
  return agents
    .filter(
      (a) =>
        !a.hidden &&
        ((a.pendingApprovals ?? 0) > 0 ||
          a.status.state === 'waiting' ||
          !!a.copy ||
          a.unread > 0) &&
        !chats[a.id]?.loaded
    )
    .map((a) => a.id);
}

/**
 * When "since" is measured from: frozen for the visit, so what's listed
 * doesn't vanish while you read it; the visit ends (and is saved) when the
 * tab is left or the app goes to the background.
 */
const RECENT_MAX = 8;

function useSince(): { since: number | null; lastVisit: number | null } {
  const [state, setState] = useState<{ since: number | null; lastVisit: number | null }>({
    since: null,
    lastVisit: null,
  });
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void loadSeen().then((seen) => {
        if (live) setState({ since: seen ?? Date.now() - FIRST_LOOK_MS, lastVisit: seen });
      });
      return () => {
        live = false;
        markSeen();
      };
    }, [])
  );
  return state;
}

export default function CatchUp() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const overview = useApp((s) => s.overview);
  const chats = useApp((s) => s.chats);
  const setup = useApp((s) => s.teamSetup);
  const live = useApp((s) => s.link.kind === 'connected');
  const reviewHere = useApp((s) => canCall('agents.import.review', s.welcome));

  // The cards live in each agent's chat: load the ones this phone hasn't.
  const missing = useMemo(
    () => (overview && live ? toLoad(overview.agents, chats) : []),
    [overview, chats, live]
  );
  const missingKey = missing.join(',');
  useEffect(() => {
    for (const id of missingKey ? missingKey.split(',') : []) void loadLatest(id).catch(() => {});
  }, [missingKey]);

  const { refreshing, onRefresh, outcome, dismiss } = useRefresh(() => {
    const ids = (overview?.agents ?? [])
      .filter(
        (a) =>
          !a.hidden &&
          ((a.pendingApprovals ?? 0) > 0 || !!a.copy || !!failedTurn(a) || a.unread > 0)
      )
      .map((a) => a.id);
    return Promise.all(ids.map((id) => loadLatest(id)));
  });

  const items = useMemo(
    () => (overview ? feedItems(overview.agents, chats, setup, reviewHere) : []),
    [overview, chats, setup, reviewHere]
  );
  const groups = useMemo(() => groupByAgent(items), [items]);
  const { since, lastVisit } = useSince();
  // What happened since the last visit; with nothing new, the last day's activity
  // under "Recently", so the screen never goes blank after one look.
  const { happened, recent } = useMemo(() => {
    if (!overview || since === null) return { happened: [], recent: false };
    const waiting = new Set(groups.map((g) => g.agentId));
    const fresh = sinceItems(overview.agents, chats, since, waiting);
    if (fresh.length > 0) return { happened: fresh, recent: false };
    const day = sinceItems(overview.agents, chats, Date.now() - FIRST_LOOK_MS, waiting);
    return { happened: day.slice(0, RECENT_MAX), recent: true };
  }, [overview, chats, since, groups]);

  const screenOptions = useMemo(
    () =>
      largeTitle(colors, 'Catch up', {
        headerRight:
          items.length > 1
            ? () => (
                <Button
                  title="One at a time"
                  variant="ghost"
                  size="compact"
                  onPress={() => router.push('/one-at-a-time')}
                />
              )
            : undefined,
      }),
    [colors, items.length, router]
  );

  const sub = fromLine(groups.length);
  return (
    <>
      <Stack.Screen options={screenOptions} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          items.length === 0 && !happened.length && styles.grow,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textSecondary}
            onRefresh={onRefresh}
          />
        }
      >
        {/* Above the rhythm below: each adds its own space only when it shows. */}
        <RefreshStatus outcome={outcome} onRetry={() => void onRefresh()} onDismiss={dismiss} />
        <DemoCard style={styles.top} />
        <ConnectionBar style={styles.top} />
        <View style={[styles.body, items.length === 0 && !happened.length && styles.grow]}>
          {items.length === 0 ? (
            <AllClear loading={missing.length > 0} compact={happened.length > 0} />
          ) : (
            <View style={styles.summary} accessibilityRole="header">
              <T variant="title" color={colors.textStrong}>
                {headline(items.length)}
              </T>
              {/* Offline, the connection bar above says when it last heard: not again here. */}
              {!!sub && (
                <T variant="small" color={colors.textSecondary}>
                  {sub}
                </T>
              )}
            </View>
          )}
          {groups.map((g) => {
            const agent = overview?.agents.find((a) => a.id === g.agentId);
            if (!agent) return null;
            return (
              <Animated.View key={g.agentId} entering={ENTER} exiting={LEAVE} layout={MOVE}>
                <AgentAccent agentId={agent.id}>
                  <Group agent={agent} items={g.items} />
                </AgentAccent>
              </Animated.View>
            );
          })}
          {happened.length > 0 && (
            <Animated.View entering={ENTER} layout={MOVE} style={styles.since}>
              <T
                variant="caption"
                color={colors.textMuted}
                style={styles.sinceTitle}
                accessibilityRole="header"
              >
                {sinceTitle(recent ? null : lastVisit)}
              </T>
              <View style={styles.sinceList}>
                {happened.map((h, i) => {
                  const agent = overview?.agents.find((a) => a.id === h.agentId);
                  return agent ? (
                    <SinceRow key={h.key} item={h} agent={agent} first={i === 0} />
                  ) : null;
                })}
              </View>
            </Animated.View>
          )}
        </View>
      </ScrollView>
    </>
  );
}

/** Nothing waiting: said once, calmly, with the way to your agents. */
function AllClear({ loading, compact }: { loading: boolean; compact: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  // With a "since you last caught up" list below, the all-clear is a header like the
  // waiting state's, so the screen reads top to bottom with one rhythm; the centred
  // hero is only for a screen with nothing else on it.
  if (compact && !loading) {
    return (
      <Animated.View entering={ENTER} style={styles.summary} accessibilityRole="header">
        <T variant="title" color={colors.textStrong}>
          All caught up
        </T>
        <T variant="small" color={colors.textSecondary}>
          Nothing needs you right now.
        </T>
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={ENTER} style={styles.empty}>
      <View style={styles.check}>
        <Icon name="checkmark" size={iconSize.hero} color={colors.textSecondary} />
      </View>
      <T variant="title" color={colors.textStrong} accessibilityRole="header">
        {loading ? 'Looking…' : 'All caught up'}
      </T>
      {!loading && (
        <>
          <T color={colors.textSecondary} style={styles.emptyText}>
            Nothing needs you right now. When an agent asks for your OK, a key or a look at its
            work, it shows here.
          </T>
          <Button
            title="Go to Agents"
            variant="secondary"
            onPress={() => {
              haptic.select();
              router.navigate('/agents');
            }}
          />
        </>
      )}
    </Animated.View>
  );
}

/** One agent's waiting rows, under its key and name. */
function Group({ agent, items }: { agent: Agent; items: FeedItem[] }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const ripple = useRipple();
  const n = items.length;
  return (
    <View style={styles.group}>
      <Pressable
        onPress={() => {
          haptic.select();
          router.push({ pathname: '/chat/[id]', params: { id: agent.id } });
        }}
        android_ripple={ripple}
        accessibilityRole="button"
        accessibilityLabel={`${agent.name}, ${n} waiting`}
        accessibilityHint="Opens its chat"
        style={({ pressed }) => [styles.groupHead, pressed && PRESSED]}
      >
        <AgentKey
          id={agent.id}
          name={agent.name}
          color={agent.color}
          state={agentKeyState(agent)}
          size={keySize.sm}
        />
        <T
          variant="subhead"
          color={colors.textStrong}
          numberOfLines={1}
          maxFontSizeMultiplier={chromeScale}
          style={styles.grow}
        >
          {agent.name}
        </T>
        {n > 1 && (
          <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
            {String(n)}
          </T>
        )}
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      </Pressable>
      {items.map((item) => (
        <Animated.View key={item.key} entering={ENTER} exiting={LEAVE} layout={MOVE}>
          <View style={styles.divider} />
          <Row item={item} agent={agent} />
        </Animated.View>
      ))}
    </View>
  );
}

/** What a row is about: its one line of what's asked, and the agent's one line of why. */
function rowWords(
  item: FeedItem,
  agent: Agent,
  card: AgentMessage | undefined,
  setupLine: string | null
): [string, string] {
  switch (item.kind) {
    case 'ask':
    case 'mac':
      return card?.approval
        ? [
            card.approval.title,
            item.kind === 'mac' ? 'Review it on your Mac' : askingLine(card.approval),
          ]
        : ['Needs your OK', ''];
    case 'keep': {
      const c = card?.changes;
      const files = c ? `${c.fileCount} file${c.fileCount === 1 ? '' : 's'}` : 'Changes';
      const where = c?.project.split('/').pop();
      return ['Keep these changes?', where ? `${files} in a copy of ${where}` : files];
    }
    case 'setup':
      return [SETUP_TITLE, setupLine ?? `In ${agent.name}’s chat`];
    case 'stuck': {
      const failure = failedTurn(agent);
      if (!failure) return ['Needs your OK', 'Open its chat to see what it’s asking'];
      // The state as the title ("Signed out", "Didn't finish"), the reason
      // under it: said once, as the desk's pill says it.
      const pill = failurePill(failure, previewText(agent.preview), engineName(agent));
      return [
        pill.label,
        pill.rest || failureLine(failure, previewText(agent.preview), engineName(agent)),
      ];
    }
  }
}

function Row({ item, agent }: { item: FeedItem; agent: Agent }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const ripple = useRipple();
  const swipe = useRef<SwipeableMethods>(null);
  const card = useApp((s) =>
    item.messageId
      ? s.chats[item.agentId]?.messages.find((m) => m.id === item.messageId)
      : undefined
  );
  const setup = useApp((s) => s.teamSetup);
  const connected = useApp((s) => s.link.kind === 'connected');
  const action = rowAction(item, card);
  // Answered on the row only when the Mac called it low-risk and the whole
  // of it is on the row.
  const inline = item.kind === 'ask' && action.kind === 'answer' && answersInPlace(card);
  const risky = item.kind === 'ask' && highRisk(card?.approval);
  const armed = useArmed(inline, item.key);
  const once = useInFlight();
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, said] = rowWords(item, agent, card, setup ? setupProgress(setup) : null);
  // Answered on the row: the row shows all of what it asks (its plain line,
  // else the exact command), never a paraphrase. Otherwise its short line,
  // said once when it repeats the title.
  const whole = inline ? card?.approval?.summary?.trim() || card?.approval?.detail?.trim() : '';
  const line = whole || (said === title ? '' : said);
  const copy = useCopyParts(
    item.kind === 'keep' && card?.changes?.copy
      ? {
          agent,
          copy: card.changes.copy,
          project: card.changes.project,
          leftOut: card.changes.leftOut,
          warning: card.changes.warning,
          size: 'compact',
          onError: setError,
        }
      : null
  );

  const chat = () => {
    swipe.current?.close();
    haptic.select();
    router.push({
      pathname: '/chat/[id]',
      params: { id: agent.id, ...(card ? { at: card.id } : {}) },
    });
  };
  const open = () => {
    if (item.kind === 'ask' && card) {
      haptic.select();
      router.push({ pathname: '/request', params: { agent: agent.id, id: card.id } });
      return;
    }
    chat();
  };

  const answer = (allow: boolean) =>
    once(async () => {
      if (!armed || !card?.approval) return;
      setBusy(allow ? 'allow' : 'deny');
      setError(null);
      try {
        await answerApproval(agent.id, card.approval.requestId, allow, false);
        if (allow) haptic.success();
        else haptic.warning();
      } catch (e) {
        haptic.error();
        const said = describeError(e);
        setError(said);
        // iOS has no live regions: say the failure, or it lands in silence.
        announce(said);
      } finally {
        setBusy(null);
      }
    });

  const when = card?.ts ?? item.ts;
  const ago = when > 0 ? formatAgo(when) : '';
  // Shown whole on the row and no plain line from the Mac: it's the command itself.
  const command = !!whole && !card?.approval?.summary?.trim();
  // One action: beside the words. Two (Deny · Allow, Discard · Keep): under them.
  const single = !(inline && action.kind === 'answer') && !copy;
  const openLabel =
    item.kind === 'ask' && action.kind === 'answer'
      ? 'Review'
      : action.kind === 'open'
        ? action.label
        : 'Open';

  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      overshootRight={false}
      rightThreshold={SWIPE_W / 2}
      onSwipeableWillOpen={() => haptic.select()}
      renderRightActions={(progress) => <SwipeChat progress={progress} onPress={chat} />}
    >
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Pressable
            onPress={open}
            android_ripple={ripple}
            accessibilityRole="button"
            accessibilityLabel={`${risky ? 'Risky. ' : ''}${title}. ${line}${ago ? `. ${ago}` : ''}`}
            accessibilityHint={item.kind === 'ask' ? 'Opens the whole request' : 'Opens its chat'}
            accessibilityActions={[{ name: 'chat', label: 'Open chat' }]}
            onAccessibilityAction={(e) => e.nativeEvent.actionName === 'chat' && chat()}
            style={({ pressed }) => [styles.rowText, pressed && PRESSED]}
          >
            <View style={styles.rowTitle}>
              {risky && (
                <View style={styles.danger} testID="catch-up-risky">
                  <Icon
                    name="exclamationmark.triangle"
                    size={iconSize.body}
                    color={colors.accentWarning}
                  />
                </View>
              )}
              <T color={colors.textStrong} numberOfLines={2} style={styles.grow}>
                {title}
              </T>
            </View>
            {/* The exact command, as it will run, when that's all there is to show. */}
            {!!line && (
              <T
                variant="small"
                color={colors.textSecondary}
                numberOfLines={inline ? 4 : 2}
                style={command ? styles.command : undefined}
              >
                {line}
              </T>
            )}
            {!!ago && (
              <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
                {ago}
              </T>
            )}
          </Pressable>
          {single && <Button title={openLabel} variant="secondary" size="compact" onPress={open} />}
        </View>
        {!!error && (
          <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        {single ? null : inline && action.kind === 'answer' ? (
          <Animated.View
            entering={FadeIn.duration(400).reduceMotion(ReduceMotion.System)}
            pointerEvents={armed ? 'auto' : 'none'}
            style={styles.answers}
          >
            <Button
              title={action.deny}
              variant="outline"
              size="compact"
              busy={busy === 'deny'}
              disabled={!!busy || !connected}
              onPress={() => void answer(false)}
            />
            <Button
              title={action.allow}
              variant="answer"
              size="compact"
              busy={busy === 'allow'}
              disabled={!!busy || !connected}
              onPress={() => void answer(true)}
              accessibilityHint={card?.approval?.detail || undefined}
            />
          </Animated.View>
        ) : (
          <View style={styles.answers}>{copy?.actions}</View>
        )}
      </View>
    </ReanimatedSwipeable>
  );
}

/** Behind a row swiped left: its chat, at the card. */
function SwipeChat({ progress, onPress }: { progress: SharedValue<number>; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const shown = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.6, 1], [0, 0.6, 1], 'clamp'),
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open chat"
      onPress={onPress}
      style={styles.swipe}
    >
      <Animated.View style={[styles.swipeInner, shown]}>
        <Icon name="bubble.left" size={iconSize.button} color={colors.textStrong} />
        <T variant="caption" color={colors.textStrong} maxFontSizeMultiplier={chromeScale}>
          Chat
        </T>
      </Animated.View>
    </Pressable>
  );
}

/** One thing that happened: a result, a routine, a turn that didn't finish, new replies. */
function SinceRow({ item, agent, first }: { item: SinceItem; agent: Agent; first: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const ripple = useRipple();
  return (
    <>
      {!first && <View style={styles.divider} />}
      <Pressable
        onPress={() => {
          haptic.select();
          router.push({
            pathname: '/chat/[id]',
            params: { id: agent.id, ...(item.messageId ? { at: item.messageId } : {}) },
          });
        }}
        android_ripple={ripple}
        accessibilityRole="button"
        accessibilityLabel={`${agent.name}. ${item.title}. ${item.line ?? ''}. ${formatAgo(item.ts)}`}
        style={({ pressed }) => [styles.sinceRow, pressed && PRESSED]}
      >
        <View style={styles.sinceKey}>
          <AgentKey id={agent.id} name={agent.name} color={agent.color} size={keySize.sm} />
        </View>
        <View style={styles.grow}>
          <View style={styles.rowTitle}>
            <T variant="small" color={colors.textPrimary} numberOfLines={1} style={styles.grow}>
              <T variant="small" color={colors.textStrong}>
                {agent.name}
              </T>
              {` · ${item.title}`}
            </T>
            <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
              {formatAgo(item.ts)}
            </T>
          </View>
          {!!item.line && (
            <T variant="small" color={colors.textSecondary} numberOfLines={1}>
              {item.line}
            </T>
          )}
        </View>
      </Pressable>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingBottom: space['2xl'] },
  // The one rhythm: 16 between the header, each agent's card and Since.
  body: { gap: space.lg },
  // A notice above it keeps the same 16 to what follows.
  top: { marginBottom: space.lg },
  summary: { gap: space['2xs'], paddingHorizontal: space.xs },
  grow: { flex: 1 },
  group: {
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    overflow: 'hidden',
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: space.lg,
    backgroundColor: colors.borderSubtle,
  },
  row: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.surfacePanel,
  },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowText: { flex: 1, gap: space['2xs'] },
  command: { fontFamily: fonts.mono },
  rowTitle: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  danger: { paddingTop: space['2xs'] },
  answers: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  swipe: { width: SWIPE_W, backgroundColor: colors.surfaceSelected },
  swipeInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space['2xs'] },
  empty: { alignItems: 'center', gap: space.md, paddingTop: space['2xl'] },
  emptyText: { textAlign: 'center', paddingHorizontal: space.xl },
  check: {
    width: heroMark,
    height: heroMark,
    borderRadius: heroMark / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  since: { gap: space.sm },
  sinceTitle: { paddingHorizontal: space.xs },
  sinceList: {
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    overflow: 'hidden',
  },
  sinceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  sinceKey: { width: keySize.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../../components/ScreenError';
