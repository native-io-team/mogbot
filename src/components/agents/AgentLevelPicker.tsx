/**
 * One agent's own independence, in its editor: the same four-stop slider as
 * Settings → Independence and onboarding (one control everywhere), with
 * whether it follows the team's level beside the title. Moving the slider
 * gives it a level of its own; "Use the team's" puts it back. Saved at once,
 * like the Admin switch, because the user is the one choosing (from chat,
 * raising one goes through the Chief's card). The row label it leads to is
 * `AgentLevelBadge`.
 *
 * @module components/agents/AgentLevelPicker
 */

import { useState } from 'react';
import { TextButton } from '../primitives/TextButton';
import { IndependenceSlider } from './IndependenceSlider';
import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_SHORT,
  effectiveIndependence,
  independenceOf,
  independenceRowLabel,
  setAgentIndependence,
  type AgentIndependence,
} from '../../lib/agentIndependence';
import { refreshAgents, useAgentsSelector } from '../../lib/agentsStore';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { Agent } from '../../lib/agents';

export function AgentLevelPicker({ agent }: { agent: Agent }) {
  const live = useAgentsSelector((s) => s.agents?.find((a) => a.id === agent.id)) ?? agent;
  const team = useAgentsSelector((s) => s.independence);
  const { showToast } = useOptionalToast();
  // Shown at once on a pick; the overview confirms it.
  const [picked, setPicked] = useState<AgentIndependence | 'team' | null>(null);
  const own = picked === null ? (live.independence ?? null) : picked === 'team' ? null : picked;
  const effective = effectiveIndependence({ independence: own }, team);

  const choose = async (level: AgentIndependence | 'team') => {
    if ((level === 'team' && !own) || level === own) return;
    setPicked(level);
    try {
      await setAgentIndependence(live.id, level);
      await refreshAgents();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setPicked(null);
    }
  };

  return (
    <div
      className="agent-editor__label agent-level-picker"
      role="group"
      aria-label={AGENT_INDEPENDENCE_TITLE}
    >
      <span className="agent-level-picker__row">
        <span>{AGENT_INDEPENDENCE_TITLE}</span>
        {own ? (
          <TextButton tabIndex={0} disabled={picked !== null} onClick={() => void choose('team')}>
            Use the team’s ({INDEPENDENCE_SHORT[independenceOf(team)]})
          </TextButton>
        ) : (
          <span className="agent-level-picker__follows">Same as team</span>
        )}
      </span>
      <IndependenceSlider
        value={effective}
        onChange={(level) => void choose(level)}
        disabled={picked !== null}
        showTitle={false}
      />
    </div>
  );
}

/** The row's tiny label: only when its level differs from the team's. */
export function AgentLevelBadge({ agent }: { agent: Pick<Agent, 'independence'> }) {
  const team = useAgentsSelector((s) => s.independence);
  const label = independenceRowLabel(agent, team);
  if (!label) return null;
  return (
    <span className="agent-engine-badge agent-level-badge" title={`Its own level: ${label}`}>
      {label}
    </span>
  );
}
