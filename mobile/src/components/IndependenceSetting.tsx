/**
 * Settings → How much it does on its own: the same four-stop slider as the
 * desk's Settings → Agents (Careful, Steady, Bold, Unleashed), worded by the
 * protocol's `independence.ts`. Read
 * from the overview (`independence`), written with `agents.setIndependence`,
 * which the Mac audits. A Mac that doesn't send it shows nothing; one that
 * doesn't serve the write shows the choice, not offered.
 */

import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_ALWAYS_ASKS,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
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
import { Alert } from 'react-native';
import { IndependenceSlider } from './IndependenceSlider';
import { choose } from './menu';
import { Row, Section, tap } from './ui';
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
 * The agent sheet's "How much it does on its own": "Same as team (Bold)"
 * first, then the four levels (Careful to Unleashed), in one sheet. Written with
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
