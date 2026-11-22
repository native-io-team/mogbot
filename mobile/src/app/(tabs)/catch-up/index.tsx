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

import type { Agent } from '@shipstudio/companion-protocol';
import { failurePill, previewText, type AgentMessage } from '@shipstudio/companion-protocol';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { AgentKey } from '../../../components/AgentKey';
import { ConnectionBar } from '../../../components/ConnectionPill';
import { DemoCard } from '../../../components/DemoCard';
import { RefreshStatus } from '../../../components/RefreshStatus';
import { Button, Icon, T, useRipple } from '../../../components/ui';
import {
  agentKeyState,
  askingLine,
  engineName,
  failedTurn,
  failureLine,
  formatAgo,
  formatClock,
} from '../../../lib/agents';
import { makeStyles, useColors } from '../../../lib/appearance';
import {
  collapseRepeats,
  endRun,
  heroWords,
  keysThatFit,
  staleLine,
  startRun,
  useRun,
  type HeroWords,
} from '../../../lib/catchUpEntry';
import {
  groupByAgent,
  FIRST_LOOK_MS,
  sinceItems,
  sinceTitle,
} from '../../../lib/catchUpTab';
import { haptic } from '../../../lib/haptics';
import { SETUP_TITLE } from '../../../lib/home';
import { loadSeen, markSeen } from '../../../lib/landing';
import { largeTitle } from '../../../lib/navigation';
import { feedItems, waitingCount, type FeedItem } from '../../../lib/needsYou';
import { useRefresh } from '../../../lib/refresh';
import { AHEAD, canCall, loadLatest } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { progress as setupProgress } from '../../../lib/teamSetup';
import {
  catchUp as catchUpSizes,
  chromeScale,
  fonts,
  heroMark,
  iconSize,
  keySize,
  lineHeight,
  PRESSED,
  radius,
  space,
} from '../../../lib/theme';
import { pairedComputer } from '../../../lib/computer';

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
    for (const id of missingKey ? missingKey.split(',') : [])
      void loadLatest(id, AHEAD).catch(() => {});
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
    // eslint-disable-next-line react-hooks/purity -- the clock is read in render on purpose; it only feeds a label that is re-read on the next render
    const day = sinceItems(overview.agents, chats, Date.now() - FIRST_LOOK_MS, waiting);
    return { happened: day.slice(0, RECENT_MAX), recent: true };
  }, [overview, chats, since, groups]);

  // One at a time is the way to catch up: the hero card below, no header pill.
  const screenOptions = useMemo(() => largeTitle(colors, 'Catch up'), [colors]);

  const waiting = waitingCount(items);
  const run = useRun();
  // All caught up: the next Start is a new run.
  useEffect(() => {
    if (waiting === 0) endRun();
  }, [waiting]);
  const lastSeen = useApp((s) =>
    s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt || 0
  );
  const single = items.length === 1 ? items[0] : null;
  const singleAgent = single ? overview?.agents.find((a) => a.id === single.agentId) : undefined;
  const singleCard = useApp((s) =>
    single?.messageId
      ? s.chats[single.agentId]?.messages.find((m) => m.id === single.messageId)
      : undefined
  );
  const hero = heroWords(
    waiting,
    groups.length,
    single && singleAgent
      ? `${singleAgent.name} · ${rowWords(single, singleAgent, singleCard, setup ? setupProgress(setup) : null)[0]}`
      : null,
    run
  );
  const open = (at?: FeedItem) => {
    haptic.select();
    if (run === null || run < waiting) startRun(waiting);
    router.push(
      at
        ? {
            pathname: '/one-at-a-time',
            params: { agent: at.agentId, ...(at.messageId ? { message: at.messageId } : {}) },
          }
        : '/one-at-a-time'
    );
  };
  // One callback for every row, always the newest `open`.
  const opening = useRef(open);
  useEffect(() => {
    opening.current = open;
  });
  const onOpen = useCallback((at: FeedItem) => opening.current(at), []);
  // eslint-disable-next-line react-hooks/purity -- the clock is read in render on purpose; it only feeds labels
  const now = Date.now();
  // Identical rows (same agent, same words) are one row, "×3" in its line.
  const pickRows = useMemo(
    () =>
      collapseRepeats(items, (i) => {
        const card = i.messageId
          ? chats[i.agentId]?.messages.find((m) => m.id === i.messageId)
          : undefined;
        const agent = overview?.agents.find((a) => a.id === i.agentId);
        const [title] = agent ? rowWords(i, agent, card, null) : [i.key];
        return `${i.agentId}\n${title}`;
      }),
    [items, overview, chats]
  );
  const keys = useMemo(
    () =>
      groups
        .map((g) => overview?.agents.find((a) => a.id === g.agentId))
        .filter((a): a is Agent => !!a),
    [groups, overview]
  );
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
          {items.length === 0 || !hero ? (
            <AllClear loading={missing.length > 0} compact={happened.length > 0} />
          ) : (
            <Animated.View entering={ENTER} layout={MOVE} style={styles.full}>
              <Hero
                words={hero}
                keys={keys}
                live={live}
                stale={live ? null : staleLine(lastSeen, pairedComputer().your, formatClock)}
                onStart={() => open()}
              />
            </Animated.View>
          )}
          {items.length > 1 && (
            <Animated.View entering={ENTER} layout={MOVE} style={[styles.since, styles.full]}>
              <T
                variant="caption"
                color={colors.textMuted}
                style={styles.sinceTitle}
                accessibilityRole="header"
              >
                Or pick one
              </T>
              <View style={[styles.sinceList, !live && styles.dim]}>
                {pickRows.map(({ row: item, count }, i) => {
                  const agent = overview?.agents.find((a) => a.id === item.agentId);
                  return agent ? (
                    <Animated.View
                      key={item.key}
                      entering={ENTER}
                      exiting={LEAVE}
                      layout={MOVE}
                      style={styles.full}
                    >
                      <PickRow
                        item={item}
                        agent={agent}
                        count={count}
                        first={i === 0}
                        when={formatAgo(item.ts, now)}
                        onOpen={onOpen}
                      />
                    </Animated.View>
                  ) : null;
                })}
              </View>
            </Animated.View>
          )}
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
                    <SinceRow
                      key={h.key}
                      id={agent.id}
                      name={agent.name}
                      color={agent.color}
                      messageId={h.messageId}
                      title={h.title}
                      line={h.line ?? ''}
                      when={formatAgo(h.ts, now)}
                      first={i === 0}
                    />
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

/** The entry (spec-catchup-entry A): how much, from whom, and one way in. */
function Hero({
  words,
  keys,
  live,
  stale,
  onStart,
}: {
  words: HeroWords;
  keys: Agent[];
  live: boolean;
  stale: string | null;
  onStart: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.hero} accessibilityRole="summary">
      <View style={styles.heroText}>
        <T style={styles.heroTitle} color={colors.textStrong} accessibilityRole="header">
          {words.title}
        </T>
        {!!words.sub && (
          <T style={styles.heroSub} color={colors.textSecondary}>
            {words.sub}
          </T>
        )}
      </View>
      {words.progress !== null && (
        <View style={styles.heroBar}>
          <View
            style={[
              styles.heroBarFill,
              { width: `${Math.round(words.progress * 100)}%`, backgroundColor: colors.textStrong },
            ]}
          />
        </View>
      )}
      <KeysRow keys={keys} />
      <Button
        title={words.button}
        variant="answer"
        size="large"
        disabled={!live}
        onPress={onStart}
      />
      {stale && (
        <View style={styles.staleLine}>
          <View style={[styles.staleDot, { backgroundColor: colors.textMuted }]} />
          <T variant="small" color={colors.textSecondary}>
            {stale}
          </T>
        </View>
      )}
    </View>
  );
}

/** The waiting keys on one line: as many as fit, the last one a "+N" chip. Never wraps or scrolls. */
function KeysRow({ keys }: { keys: Agent[] }) {
  const colors = useColors();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const size = catchUpSizes.heroKey;
  const gap = catchUpSizes.heroKeyGap;
  const fit = keysThatFit(width, size, gap);
  const shown = keys.length > fit ? keys.slice(0, fit - 1) : keys;
  const more = keys.length - shown.length;
  return (
    <View
      style={styles.heroKeys}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {shown.map((a) => (
        <AgentKey
          key={a.id}
          id={a.id}
          name={a.name}
          color={a.color}
          state={agentKeyState(a)}
          size={size}
        />
      ))}
      {more > 0 && (
        <View
          style={[
            styles.moreKey,
            { width: size, height: size, backgroundColor: colors.surfaceControl },
          ]}
        >
          <T variant="caption" color={colors.textSecondary}>
            {`+${more}`}
          </T>
        </View>
      )}
    </View>
  );
}

/** The same waiting thing: the list builds its items anew on every change. */
function samePick(
  a: { item: FeedItem; agent: Agent; count: number; when: string; first: boolean },
  b: { item: FeedItem; agent: Agent; count: number; when: string; first: boolean }
) {
  return (
    a.agent === b.agent &&
    a.count === b.count &&
    a.when === b.when &&
    a.first === b.first &&
    a.item.key === b.item.key &&
    a.item.kind === b.item.kind &&
    a.item.ts === b.item.ts
  );
}

/** One thing waiting, quietly: its key, what it wants, who and when. No buttons. */
const PickRow = memo(function PickRow({
  item,
  agent,
  count,
  when,
  first,
  onOpen,
}: {
  item: FeedItem;
  agent: Agent;
  /** Identical rows this one stands for ("×3"). */
  count: number;
  /** How long ago, worked out by the list, so the words move with its clock. */
  when: string;
  first: boolean;
  onOpen: (item: FeedItem) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  const setup = useApp((s) => s.teamSetup);
  const card = useApp((s) =>
    item.messageId
      ? s.chats[item.agentId]?.messages.find((m) => m.id === item.messageId)
      : undefined
  );
  const [title] = rowWords(item, agent, card, setup ? setupProgress(setup) : null);
  return (
    <>
      {!first && <View style={styles.divider} />}
      <Pressable
        onPress={() => onOpen(item)}
        android_ripple={ripple}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${agent.name}, ${when}`}
        accessibilityHint="Opens it one at a time"
        style={({ pressed }) => [styles.sinceRow, pressed && PRESSED]}
      >
        <AgentKey
          id={agent.id}
          name={agent.name}
          color={agent.color}
          state={agentKeyState(agent)}
          size={keySize.md}
        />
        <View style={styles.grow}>
          <T color={colors.textStrong} numberOfLines={1}>
            {title}
          </T>
          <T variant="small" color={colors.textMuted} numberOfLines={1}>
            {count > 1 ? `${agent.name} · ${when} · ×${count}` : `${agent.name} · ${when}`}
          </T>
        </View>
        <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
      </Pressable>
    </>
  );
}, samePick);

/** What a row is about: its one line of what's asked, and the agent's one line of why. */
/** "a Stripe key", "an API key": the article a noun phrase takes. */
function withArticle(noun: string): string {
  const n = noun.trim();
  return /^[aeiou]/i.test(n) ? `an ${n}` : `a ${n}`;
}

function rowWords(
  item: FeedItem,
  agent: Agent,
  card: AgentMessage | undefined,
  setupLine: string | null
): [string, string] {
  switch (item.kind) {
    case 'ask':
    case 'mac':
      // A key the agent asked for reads as a sentence, like the other rows:
      // "Finance needs a Stripe key" (the Mac's "Secure input · …" is its card title).
      if (card?.approval?.secret && item.kind === 'ask') {
        return [
          `${agent.name} needs ${withArticle(card.approval.secret.name)}`,
          askingLine(card.approval),
        ];
      }
      return card?.approval
        ? [
            card.approval.title,
            item.kind === 'mac'
              ? `Review it on ${pairedComputer().your}`
              : askingLine(card.approval),
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

/** One thing that happened: a result, a routine, a turn that didn't finish, new replies. */
const SinceRow = memo(function SinceRow({
  id,
  name,
  color,
  messageId,
  title,
  line,
  when,
  first,
}: {
  id: string;
  name: string;
  color: string;
  messageId?: string;
  title: string;
  line: string;
  when: string;
  first: boolean;
}) {
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
            params: { id, ...(messageId ? { at: messageId } : {}) },
          });
        }}
        android_ripple={ripple}
        accessibilityRole="button"
        accessibilityLabel={[name, title, line, when].filter(Boolean).join('. ')}
        style={({ pressed }) => [styles.sinceRow, pressed && PRESSED]}
      >
        <View style={styles.sinceKey}>
          <AgentKey id={id} name={name} color={color} size={keySize.sm} />
        </View>
        <View style={styles.grow}>
          <View style={styles.rowTitle}>
            <T variant="small" color={colors.textPrimary} numberOfLines={1} style={styles.grow}>
              <T variant="small" color={colors.textStrong}>
                {name}
              </T>
              {` · ${title}`}
            </T>
            <T variant="caption" color={colors.textMuted} maxFontSizeMultiplier={chromeScale}>
              {when}
            </T>
          </View>
          {!!line && (
            <T variant="small" color={colors.textSecondary} numberOfLines={1}>
              {line}
            </T>
          )}
        </View>
      </Pressable>
    </>
  );
});

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingBottom: space['2xl'] },
  // The one rhythm: 16 between the header, each agent's card and Since.
  body: { gap: space.lg },
  // A notice above it keeps the same 16 to what follows.
  top: { marginBottom: space.lg },
  summary: { gap: space['2xs'], paddingHorizontal: space.xs },
  grow: { flex: 1, minWidth: 0 },
  // A wrapper takes the column's width; its content never sets it.
  full: { alignSelf: 'stretch', minWidth: 0 },
  moreKey: {
    borderRadius: radius.inner,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  rowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: space.sm },
  stackedAction: { alignSelf: 'flex-end' },
  rowTextStacked: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
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
  hero: {
    gap: space.lg,
    padding: catchUpSizes.heroPad,
    borderRadius: radius.hero,
    backgroundColor: colors.surfacePanel,
  },
  heroText: { gap: space.xs },
  // Line height at least 1.2x the size, or the glyph tops are cut flat (Julian, 21 Nov).
  heroTitle: {
    fontFamily: fonts.semibold,
    fontSize: catchUpSizes.heroTitle,
    lineHeight: lineHeight(catchUpSizes.heroTitle, 1.25),
  },
  heroSub: { fontSize: catchUpSizes.heroSub, lineHeight: lineHeight(catchUpSizes.heroSub, 1.4) },
  heroKeys: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: catchUpSizes.heroKeyGap,
    alignSelf: 'stretch',
    // No overflow clip: a key's cap and shadow would be cut flat at the row's edge.
    paddingVertical: 2,
  },
  heroBar: {
    height: catchUpSizes.heroBar,
    borderRadius: radius.pill,
    backgroundColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  heroBarFill: { height: catchUpSizes.heroBar, borderRadius: radius.pill },
  staleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  staleDot: { width: space.tight, height: space.tight, borderRadius: radius.pill },
  dim: { opacity: catchUpSizes.staleDim },
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
