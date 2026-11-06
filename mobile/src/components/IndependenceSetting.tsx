/**
 * Settings → How much agents do on their own: the same four choices as the
 * desk's Settings → Agents, worded by the protocol's `independence.ts`. Read
 * from the overview (`independence`), written with `agents.setIndependence`,
 * which the Mac audits. A Mac that doesn't send it shows nothing; one that
 * doesn't serve the write shows the choice, not offered.
 */

import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_QUESTION,
  INDEPENDENCE_SHORT,
  INDEPENDENCE_STILL_ASKS,
  effectiveIndependence,
  independenceRowLabel,
  ownIndependenceCount,
  ownIndependenceLine,
  sameAsTeamLabel,
  type Agent,
  type AgentIndependence,
} from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { choose } from './menu';
import { Icon, Row, Section, tap } from './ui';
import { useAccent } from '../lib/accent';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize } from '../lib/theme';

export function IndependenceSetting() {
  const accent = useAccent();
  const level = useApp((s) => s.overview?.independence ?? null);
  const canSet = useServed('agents.setIndependence');
  // Agents with a level of their own (their sheet, the desk, the Chief).
  const own = useApp((s) => ownIndependenceCount(s.overview?.agents ?? []));
  const [busy, setBusy] = useState(false);
  if (!level) return null;

  const change = async (next: AgentIndependence) => {
    if (busy) return;
    tap();
    setBusy(true);
    try {
      // The overview follows as an event; nothing to merge here.
      await call('agents.setIndependence', { level: next });
    } catch (e) {
      haptic.error();
      Alert.alert('Couldn’t change it', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={INDEPENDENCE_QUESTION}
      footer={
        own > 0
          ? `${INDEPENDENCE_STILL_ASKS[level]} ${ownIndependenceLine(own)}.`
          : INDEPENDENCE_STILL_ASKS[level]
      }
    >
      {INDEPENDENCE_LEVELS.map((l, i) => {
        const on = l === level;
        return (
          <Row
            key={l}
            label={INDEPENDENCE_LABEL[l]}
            detail={INDEPENDENCE_DETAIL[l]}
            selected={on}
            onPress={canSet && !on ? () => void change(l) : undefined}
            trailing={
              on ? (
                <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
              ) : (
                <View style={styles.check} />
              )
            }
            last={i === INDEPENDENCE_LEVELS.length - 1}
          />
        );
      })}
    </Section>
  );
}

/**
 * The agent sheet's "How much it does on its own": "Same as team (Go hard)"
 * first, then the four levels, in one sheet. Written with
 * `agents.setAgentIndependence` (audited on the Mac); a Mac that doesn't
 * serve it shows nothing. The user choosing it here applies at once.
 */
export function AgentLevelRow({
  agent,
  enabled,
  onError,
  last,
}: {
  agent: Pick<Agent, 'id' | 'name' | 'independence'>;
  enabled: boolean;
  onError: (text: string | null) => void;
  last?: boolean;
}) {
  const team = useApp((s) => s.overview?.independence ?? null);
  const canSet = useServed('agents.setAgentIndependence');
  if (!canSet) return null;
  const own = agent.independence ?? null;
  const effective = effectiveIndependence(agent, team);

  const pick = (level: AgentIndependence | 'team') => {
    if ((level === 'team' && !own) || level === own) return;
    haptic.select();
    onError(null);
    call('agents.setAgentIndependence', { agentId: agent.id, level }).catch((e: unknown) =>
      onError(describeError(e))
    );
  };

  return (
    <Row
      label={AGENT_INDEPENDENCE_TITLE}
      value={own ? INDEPENDENCE_SHORT[own] : sameAsTeamLabel(team)}
      detail={INDEPENDENCE_DETAIL[effective]}
      disabled={!enabled}
      last={last}
      onPress={() =>
        choose(AGENT_INDEPENDENCE_TITLE, [
          { label: sameAsTeamLabel(team), run: () => pick('team') },
          ...INDEPENDENCE_LEVELS.map((l) => ({ label: INDEPENDENCE_LABEL[l], run: () => pick(l) })),
        ], `What ${agent.name} does without asking you.`)
      }
    />
  );
}

/** The tiny label on an agent's row, only when it differs from the team's. */
export function useAgentLevelLabel(agent: Pick<Agent, 'independence'>): string | null {
  const team = useApp((s) => s.overview?.independence ?? null);
  return independenceRowLabel(agent, team);
}

const styles = StyleSheet.create({
  check: { width: iconSize.body },
});
