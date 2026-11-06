/**
 * "N agents need you", from Home's bar: everyone waiting on you, one row
 * each, saying what for. Tap opens that chat at the card. Setting up your
 * team, when it's open, is one row at the top (the Chief's chat holds it);
 * the agents being set up aren't listed one by one (lib/home).
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AgentAvatar } from '../components/agent';
import { SheetTitle } from '../components/SheetTitle';
import { Icon, SheetPage, T, useRipple } from '../components/ui';
import { failedTurn, failureLine, needsLine, pendingApproval } from '../lib/agents';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { barWords, buildHome } from '../lib/home';
import { useApp } from '../lib/store';
import { progress } from '../lib/teamSetup';
import { avatarSize, iconSize, PRESSED, space } from '../lib/theme';

export default function NeedsYou() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const overview = useApp((s) => s.overview);
  const setup = useApp((s) => s.teamSetup);
  const home = useMemo(
    () => (overview ? buildHome(overview.agents, setup) : null),
    [overview, setup]
  );
  const waiting = home?.bar?.kind === 'needs' ? home.bar.agents : [];
  // The Chief waits on you too, sometimes: it heads Home, and it's listed here
  // first. The bar counts it (one rule for every count), so this lists it.
  const chief = home?.chief;
  const listed: Agent[] = [
    ...waiting.filter((a) => a === chief),
    ...waiting.filter((a) => a !== chief),
  ];
  const setupOpen = !!home?.bar && (home.bar.kind === 'setup' || home.bar.setup);

  const open = (agent: Agent) => {
    haptic.select();
    const card = pendingApproval(useApp.getState().chats[agent.id]?.messages);
    router.back();
    router.push({
      pathname: '/chat/[id]',
      params: { id: agent.id, ...(card ? { at: card.id } : {}) },
    });
  };

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <SheetTitle>Needs you</SheetTitle>
        {setupOpen && chief && (
          <Row
            agent={chief}
            title={barWords({ kind: 'setup' }, chief.name)[0]}
            line={`${setup ? `${progress(setup)} · ` : ''}in ${chief.name}’s chat`}
            onPress={() => {
              haptic.select();
              router.back();
              router.push({ pathname: '/chat/[id]', params: { id: chief.id } });
            }}
          />
        )}
        {listed.map((a) => (
          <WaitingRow key={a.id} agent={a} onPress={() => open(a)} />
        ))}
        {listed.length === 0 && !setupOpen && (
          <T color={colors.textSecondary}>Nothing is waiting on you.</T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

function WaitingRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  const line = useApp((s) => {
    const failure = failedTurn(agent);
    return failure && !(agent.pendingApprovals ?? 0)
      ? failureLine(failure, agent.preview, agent.engine)
      : needsLine(agent, s.chats[agent.id]?.messages);
  });
  return <Row agent={agent} title={agent.name} line={line} onPress={onPress} />;
}

function Row({
  agent,
  title,
  line,
  onPress,
}: {
  agent: Agent;
  title: string;
  line: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const ripple = useRipple();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={ripple}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${line}`}
      style={({ pressed }) => [styles.row, pressed && PRESSED]}
    >
      <AgentAvatar id={agent.id} name={agent.name} color={agent.color} size={avatarSize.list} />
      <View style={styles.text}>
        <T variant="headline" color={colors.textStrong} numberOfLines={1}>
          {title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={2}>
          {line}
        </T>
      </View>
      <Icon name="chevron.right" size={iconSize.inline} color={colors.textMuted} />
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { padding: space.lg, gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  text: { flex: 1, gap: space.xs },
}));
