/**
 * Needs you: every card waiting on you, across every agent, in one list
 * (`lib/needsYou.ts`). The phone's one place for it; Home's bar, a pushed
 * "needs you" and the tab's count all lead here.
 *
 * Each row is the agent, what it asks and when. A short plain request is
 * answered right on its row (Deny · Allow, inert for a beat as on every
 * card); anything longer opens in full first (Review), and a key, a login,
 * a question, changes to keep or a turn that didn't finish opens where it
 * is answered. Answered cards leave the list by themselves, here or at the
 * desk. "One at a time" goes through them full screen (Catch up).
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { AgentAvatar } from '../../../components/agent';
import { useArmed } from '../../../components/ApprovalCard';
import { ConnectionNotice, useNow } from '../../../components/ConnectionPill';
import { DemoCard } from '../../../components/DemoCard';
import { RefreshStatus } from '../../../components/RefreshStatus';
import { Button, Icon, T, useRipple } from '../../../components/ui';
import { AgentAccent } from '../../../lib/accent';
import { askingLine, failedTurn, failureLine, engineName, formatAgo } from '../../../lib/agents';
import { makeStyles, useColors } from '../../../lib/appearance';
import { haptic } from '../../../lib/haptics';
import { largeTitle } from '../../../lib/navigation';
import { feedItems, fitsWhole, rowAction, type FeedItem } from '../../../lib/needsYou';
import { useInFlight } from '../../../lib/once';
import { useRefresh } from '../../../lib/refresh';
import { answerApproval, canCall, describeError, loadLatest } from '../../../lib/session';
import { useApp } from '../../../lib/store';
import { progress as setupProgress } from '../../../lib/teamSetup';
import { avatarSize, iconSize, PRESSED, radius, space } from '../../../lib/theme';
import { previewText } from '@shipstudio/companion-protocol';

/** Agents whose chat the feed needs and this phone hasn't loaded. */
function toLoad(agents: Agent[], chats: Record<string, { loaded?: boolean } | undefined>) {
  return agents
    .filter(
      (a) =>
        !a.hidden &&
        ((a.pendingApprovals ?? 0) > 0 || a.status.state === 'waiting' || !!a.copy) &&
        !chats[a.id]?.loaded
    )
    .map((a) => a.id);
}

export default function NeedsYou() {
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
      .filter((a) => !a.hidden && ((a.pendingApprovals ?? 0) > 0 || !!a.copy || !!failedTurn(a)))
      .map((a) => a.id);
    return Promise.all(ids.map((id) => loadLatest(id)));
  });

  const items = useMemo(
    () => (overview ? feedItems(overview.agents, chats, setup, reviewHere) : []),
    [overview, chats, setup, reviewHere]
  );
  const answerable = items.filter((i) => i.kind === 'ask').length;
  const screenOptions = useMemo(
    () =>
      largeTitle(colors, 'Needs you', {
        headerRight:
          answerable > 1
            ? () => (
                <Button
                  title="One at a time"
                  variant="ghost"
                  size="compact"
                  onPress={() => router.push('/catch-up')}
                />
              )
            : undefined,
      }),
    [colors, answerable, router]
  );

  return (
    <>
      <Stack.Screen options={screenOptions} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.textSecondary}
            onRefresh={onRefresh}
          />
        }
      >
        <RefreshStatus outcome={outcome} onRetry={() => void onRefresh()} onDismiss={dismiss} />
        <DemoCard />
        <ConnectionNotice />
        {!live && items.length > 0 && <AsOf />}
        {items.length === 0 ? (
          <Nothing loading={missing.length > 0} />
        ) : (
          items.map((item) => {
            const agent = overview?.agents.find((a) => a.id === item.agentId);
            if (!agent) return null;
            return (
              <Animated.View
                key={item.key}
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(160)}
                layout={LinearTransition.duration(200)}
              >
                <AgentAccent agentId={agent.id}>
                  <Row item={item} agent={agent} />
                </AgentAccent>
              </Animated.View>
            );
          })
        )}
      </ScrollView>
    </>
  );
}

/** "AS OF 4 MIN AGO": what's listed is the saved copy, not live news. */
function AsOf() {
  const colors = useColors();
  const styles = useStyles();
  useNow(30_000);
  const asOf = useApp((s) => (s.link.kind === 'reconnecting' ? s.link.lastSeenAt : s.syncedAt));
  if (!asOf) return null;
  return (
    <T variant="caption" color={colors.textMuted} style={styles.asOf} accessibilityRole="header">
      {`As of ${formatAgo(asOf)}`.toUpperCase()}
    </T>
  );
}

function Nothing({ loading }: { loading: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.empty}>
      <View style={styles.check}>
        <Icon name="checkmark" size={iconSize.hero} color={colors.textSecondary} />
      </View>
      <T variant="headline" color={colors.textStrong}>
        {loading ? 'Looking…' : 'Nothing needs you'}
      </T>
      {!loading && (
        <T color={colors.textSecondary} style={styles.emptyText}>
          When an agent asks for your OK, a key or a look at its work, it shows here.
        </T>
      )}
    </Animated.View>
  );
}

/** What a row is about, in its strong line and its quiet one. */
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
      return ['Keep these changes?', c ? `${files} in ${c.project}` : files];
    }
    case 'setup':
      return ['Finish setting up your team', setupLine ?? `In ${agent.name}’s chat`];
    case 'stuck': {
      const failure = failedTurn(agent);
      return failure
        ? ['Didn’t finish', failureLine(failure, previewText(agent.preview), engineName(agent))]
        : ['Needs your OK', 'Open its chat to see what it’s asking'];
    }
  }
}

function Row({ item, agent }: { item: FeedItem; agent: Agent }) {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const ripple = useRipple();
  const card = useApp((s) =>
    item.messageId
      ? s.chats[item.agentId]?.messages.find((m) => m.id === item.messageId)
      : undefined
  );
  const setup = useApp((s) => s.teamSetup);
  const connected = useApp((s) => s.link.kind === 'connected');
  const action = rowAction(item, card);
  // Answered on the row only when the whole of it is on the row.
  const inline = item.kind === 'ask' && action.kind === 'answer' && fitsWhole(card);
  const armed = useArmed(inline, item.key);
  const once = useInFlight();
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, line] = rowWords(item, agent, card, setup ? setupProgress(setup) : null);

  const open = () => {
    haptic.select();
    if (item.kind === 'ask' && card) {
      router.push({ pathname: '/request', params: { agent: agent.id, id: card.id } });
      return;
    }
    router.push({
      pathname: '/chat/[id]',
      params: { id: agent.id, ...(card ? { at: card.id } : {}) },
    });
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
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    });

  const when = card?.ts ?? item.ts;
  return (
    <View style={styles.row}>
      <Pressable
        onPress={open}
        android_ripple={ripple}
        accessibilityRole="button"
        accessibilityLabel={`${agent.name}. ${title}. ${line}`}
        accessibilityHint={item.kind === 'ask' ? 'Opens the whole request' : undefined}
        style={({ pressed }) => [styles.rowMain, pressed && PRESSED]}
      >
        <AgentAvatar
          id={agent.id}
          name={agent.name}
          color={agent.color}
          look={agent.avatar}
          size={avatarSize.group}
        />
        <View style={styles.rowText}>
          <View style={styles.rowHead}>
            <T variant="caption" color={colors.textSecondary} numberOfLines={1} style={styles.grow}>
              {agent.name}
            </T>
            {when > 0 && (
              <T variant="caption" color={colors.textMuted}>
                {formatAgo(when)}
              </T>
            )}
          </View>
          <T color={colors.textStrong} numberOfLines={2}>
            {title}
          </T>
          {!!line && (
            <T variant="small" color={colors.textSecondary} numberOfLines={inline ? 4 : 2}>
              {line}
            </T>
          )}
        </View>
      </Pressable>
      {!!error && (
        <T variant="small" color={colors.accentErrorLight} accessibilityLiveRegion="polite">
          {error}
        </T>
      )}
      {inline && action.kind === 'answer' ? (
        <Animated.View
          entering={FadeIn.duration(400)}
          pointerEvents={armed ? 'auto' : 'none'}
          style={styles.answers}
        >
          <Button
            title={action.deny}
            variant="outline"
            busy={busy === 'deny'}
            disabled={!!busy || !connected}
            onPress={() => void answer(false)}
            style={styles.answer}
          />
          <Button
            title={action.allow}
            variant="answer"
            busy={busy === 'allow'}
            disabled={!!busy || !connected}
            onPress={() => void answer(true)}
            accessibilityHint={card?.approval?.detail || undefined}
            style={styles.answer}
          />
        </Animated.View>
      ) : (
        <View style={styles.answers}>
          <Button
            title={
              item.kind === 'ask' && action.kind === 'answer'
                ? 'Review'
                : action.kind === 'open'
                  ? action.label
                  : 'Open'
            }
            variant="secondary"
            onPress={open}
            style={styles.answer}
          />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, gap: space.md, paddingBottom: space['2xl'] },
  asOf: { paddingHorizontal: space.xs },
  row: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
  },
  rowMain: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  rowText: { flex: 1, gap: space['2xs'] },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1 },
  answers: { flexDirection: 'row', gap: space.sm },
  answer: { flex: 1 },
  empty: { alignItems: 'center', gap: space.md, paddingTop: space['2xl'] * 2 },
  emptyText: { textAlign: 'center', paddingHorizontal: space.xl },
  check: {
    width: avatarSize.sheet,
    height: avatarSize.sheet,
    borderRadius: avatarSize.sheet / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../../components/ScreenError';
