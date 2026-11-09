/**
 * Settings → Independence: the same four-stop slider as the desk's Settings →
 * Independence (Careful, Steady, Bold, Unleashed), worded by the protocol's
 * `independence.ts`. One control for it everywhere: an agent's own level on
 * its sheet is the same slider (`AgentLevelRow`). Read
 * from the overview (`independence`), written with `agents.setIndependence`,
 * which the Mac audits. A Mac that doesn't send it shows nothing; one that
 * doesn't serve the write shows the choice, not offered.
 */

import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_SHORT,
  INDEPENDENCE_TITLE,
  effectiveIndependence,
  independenceOf,
  independenceRowLabel,
  ownIndependenceCount,
  ownIndependenceLine,
  sameAsTeamLabel,
  type Agent,
  type AgentIndependence,
} from '@shipstudio/companion-protocol';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { IndependenceSlider } from './IndependenceSlider';
import { Row, Section, tap } from './ui';
import { makeStyles } from '../lib/appearance';
import { space } from '../lib/theme';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { useApp, useServed } from '../lib/store';

export function IndependenceSetting() {
  const level = useApp((s) => s.overview?.independence ?? null);
  const canSet = useServed('agents.setIndependence');
  // Agents with a level of their own (their sheet, the desk, the Chief).
  const own = useApp((s) => ownIndependenceCount(s.overview?.agents ?? []));
  const [busy, setBusy] = useState(false);
  // The stop just chosen, shown (and read out by VoiceOver) at once, until
  // the Mac's overview says what is set; a refusal puts it back.
  const [asked, setAsked] = useState<AgentIndependence | null>(null);
  useEffect(() => setAsked(null), [level]);
  if (!level) return null;

  const change = async (next: AgentIndependence) => {
    if (busy || !canSet) return;
    tap();
    setBusy(true);
    setAsked(next);
    try {
      // The overview follows as an event; nothing to merge here.
      await call('agents.setIndependence', { level: next });
    } catch (e) {
      setAsked(null);
      haptic.error();
      Alert.alert('Couldn’t change it', describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={INDEPENDENCE_TITLE}
      footer={
        own > 0
          ? `${INDEPENDENCE_ALWAYS_ASKS} ${ownIndependenceLine(own)}.`
          : INDEPENDENCE_ALWAYS_ASKS
      }
    >
      <IndependenceSlider
        value={asked ?? independenceOf(level)}
        onChange={(l) => void change(l)}
        disabled={!canSet || busy}
      />
    </Section>
  );
}

/**
 * The agent sheet's Independence: the same slider, for this agent, with
 * whether it follows the team ("Same as team (Bold)") beside the title.
 * Moving it gives the agent a level of its own; "Use the team's" puts it
 * back. Written with `agents.setAgentIndependence` (audited on the Mac); a
 * Mac that doesn't serve it shows nothing. The user choosing it here applies
 * at once.
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
  const styles = useStyles();
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
    <View>
      <Row
        label={AGENT_INDEPENDENCE_TITLE}
        value={own ? INDEPENDENCE_SHORT[own] : sameAsTeamLabel(team)}
        disabled={!enabled}
        last
      />
      <View style={[styles.slider, last && !own && styles.sliderLast]}>
        <IndependenceSlider value={effective} onChange={(l) => pick(l)} disabled={!enabled} />
      </View>
      {own && (
        <Row
          label={`Use the team’s (${INDEPENDENCE_SHORT[independenceOf(team)]})`}
          onPress={() => pick('team')}
          disabled={!enabled}
          last={last}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  slider: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  sliderLast: { paddingBottom: space.lg },
}));

/** The tiny label on an agent's row, only when it differs from the team's. */
export function useAgentLevelLabel(agent: Pick<Agent, 'independence'>): string | null {
  const team = useApp((s) => s.overview?.independence ?? null);
  return independenceRowLabel(agent, team);
}
