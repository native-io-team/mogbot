/**
 * One request, in full: `/request?agent=<id>&id=<message>`. From a tapped
 * notification, a row of the Needs you feed, or Review on a Lock Screen.
 *
 * Everything the card asks is on screen with nothing capped: a long command
 * line by line, a plan's every step, an email's whole body, a settings
 * change, a routine's step. The page scrolls; Deny · Allow stay pinned at
 * the bottom under the thumb, inert for a beat as everywhere. A key, a
 * login or a question has its one action instead, which opens it in its
 * chat. Answered elsewhere while you read: it says so, and the answers go.
 */

import type { Agent, AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentAvatar, Spinner } from '../components/agent';
import { ApprovalCard, useArmed } from '../components/ApprovalCard';
import { Card, Line } from '../components/surfaces';
import { Button, IconButton, T } from '../components/ui';
import { AgentAccent } from '../lib/accent';
import { askingLine, formatAgo } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { askAction, askState, type CatchItem } from '../lib/catchUp';
import { haptic } from '../lib/haptics';
import { useInFlight } from '../lib/once';
import { answerApproval, describeError, loadLatest, setOpenChat } from '../lib/session';
import { useApp } from '../lib/store';
import { avatarSize, iconSize, space } from '../lib/theme';

/** The big answer buttons: taller than a large button, for the thumb. */
const BIG = space['2xl'] + space.xl;

/** What became of the card, in a line. */
const GONE_LINE = {
  answered: 'Already answered',
  expired: 'Not answered in time',
  gone: 'No longer waiting',
} as const;

export default function Request() {
  const params = useLocalSearchParams<{ agent?: string; id?: string }>();
  const agentId = typeof params.agent === 'string' ? params.agent : '';
  const messageId = typeof params.id === 'string' ? params.id : '';
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === agentId));
  const messages = useApp((s) => s.chats[agentId]?.messages);
  const card = messages?.find((m) => m.id === messageId);
  const connected = useApp((s) => s.link.kind === 'connected');
  const [looked, setLooked] = useState(false);

  // Opened from a notification, the chat may not be here yet.
  useEffect(() => {
    if (!agentId) return;
    if (card || !connected) return setLooked(true);
    let live = true;
    void loadLatest(agentId)
      .catch(() => {})
      .finally(() => live && setLooked(true));
    return () => {
      live = false;
    };
    // Once per card: a later answer arrives as an event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, messageId, connected]);

  // On screen, the agent counts as read, as an open chat does.
  useFocusEffect(
    useCallback(() => {
      if (!agentId) return;
      setOpenChat(agentId);
      return () => setOpenChat(null);
    }, [agentId])
  );

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/needs');
  }, [router]);

  if (!card && !looked) {
    return (
      <View style={[styles.page, styles.center, { paddingTop: insets.top }]}>
        <Spinner size={iconSize.button} label="Opening the request" />
      </View>
    );
  }

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {agent ? (
        <AgentAccent agentId={agent.id}>
          <Shown agent={agent} card={card} onClose={close} bottom={insets.bottom} />
        </AgentAccent>
      ) : (
        <Shown agent={null} card={card} onClose={close} bottom={insets.bottom} />
      )}
    </View>
  );
}

function Shown({
  agent,
  card,
  onClose,
  bottom,
}: {
  agent: Agent | null;
  card: AgentMessage | undefined;
  onClose: () => void;
  bottom: number;
}) {
  const styles = useStyles();
  const colors = useColors();
  const router = useRouter();
  const connected = useApp((s) => s.link.kind === 'connected');
  const approval = card?.approval;
  const item: CatchItem = {
    key: card?.id ?? '',
    kind: 'ask',
    agentId: agent?.id ?? '',
    messageId: card?.id,
    ts: card?.ts ?? 0,
  };
  const state = card ? askState(item, [card]) : 'gone';
  const pending = state === 'pending' && !!agent;
  const action = askAction(card);
  const armed = useArmed(pending, card?.id ?? '');
  const once = useInFlight();
  const [busy, setBusy] = useState<null | 'allow' | 'deny'>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = (allow: boolean) =>
    once(async () => {
      if (!armed || !approval || !agent) return;
      setBusy(allow ? 'allow' : 'deny');
      setError(null);
      try {
        await answerApproval(agent.id, approval.requestId, allow, false);
        if (allow) haptic.success();
        else haptic.warning();
        onClose();
      } catch (e) {
        haptic.error();
        setError(describeError(e));
      } finally {
        setBusy(null);
      }
    });

  const openChat = () =>
    agent &&
    router.push({
      pathname: '/chat/[id]',
      params: { id: agent.id, ...(card ? { at: card.id } : {}) },
    });

  return (
    <>
      <View style={styles.header}>
        <IconButton name="xmark" label="Close" onPress={onClose} />
        <T variant="headline" color={colors.textStrong} accessibilityRole="header">
          Request
        </T>
        <View style={styles.headerEnd} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {agent && (
          <View style={styles.who}>
            <AgentAvatar
              id={agent.id}
              name={agent.name}
              color={agent.color}
              look={agent.avatar}
              size={avatarSize.header}
            />
            <T variant="headline" color={colors.textStrong} numberOfLines={1} style={styles.name}>
              {agent.name}
            </T>
            {card && (
              <T variant="caption" color={colors.textSecondary} numberOfLines={1}>
                {formatAgo(card.ts)}
              </T>
            )}
          </View>
        )}
        {card && approval && agent ? (
          action.kind === 'answer' || !pending ? (
            <ApprovalCard
              message={card}
              approval={approval}
              agent={agent}
              onError={setError}
              answers={false}
              full
            />
          ) : (
            <Card icon={askIcon(approval)} title={approval.title}>
              <T variant="small" color={colors.textSecondary}>
                {askingLine(approval)}
              </T>
            </Card>
          )
        ) : null}
        {!pending && (
          <Animated.View entering={FadeIn.duration(150)}>
            <Line text={state === 'pending' ? GONE_LINE.gone : GONE_LINE[state]} />
          </Animated.View>
        )}
      </ScrollView>
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
              variant="answer"
              size="large"
              busy={busy === 'allow'}
              disabled={!!busy || !connected}
              onPress={() => void answer(true)}
              accessibilityHint={approval?.detail || undefined}
              style={styles.big}
            />
          </Animated.View>
        ) : pending && action.kind === 'open' ? (
          <Button
            title={action.label}
            variant="answer"
            size="large"
            onPress={openChat}
            style={styles.bigSingle}
          />
        ) : (
          <View style={styles.row}>
            {agent && (
              <Button
                title="Open chat"
                variant="outline"
                size="large"
                onPress={openChat}
                style={styles.big}
              />
            )}
            <Button
              title="Done"
              variant="answer"
              size="large"
              onPress={onClose}
              style={styles.big}
            />
          </View>
        )}
      </View>
    </>
  );
}

/** The icon its own card in the chat wears. */
const askIcon = (a: Approval) =>
  a.login || a.secret ? 'lock.fill' : a.connector ? 'square.and.arrow.down' : 'checkmark.shield';

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
  headerEnd: { width: avatarSize.list },
  scroll: { padding: space.lg, gap: space.lg },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flex: 1 },
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
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
