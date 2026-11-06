/**
 * One agent's own independence level, in its editor: "Same as team (Go
 * hard)" first, then the four levels. Saved at once, like the Admin switch,
 * because the user is the one choosing (from chat, raising one goes through
 * the Chief's card). The row label it leads to is `AgentLevelBadge`.
 *
 * @module components/agents/AgentLevelPicker
 */

import { useState } from 'react';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import {
  AGENT_INDEPENDENCE_TITLE,
  INDEPENDENCE_DETAIL,
  INDEPENDENCE_LABEL,
  INDEPENDENCE_LEVELS,
  INDEPENDENCE_STILL_ASKS,
  effectiveIndependence,
  independenceRowLabel,
  sameAsTeamLabel,
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
        {/* Opens upward: the row sits low in a long dialog, and a menu cut off by the window is no menu. */}
        <Dropdown
          align="right"
          side="top"
          portal
          menuClassName="agent-level-menu"
          trigger={(p) => (
            <MenuButton
              {...p}
              expanded={p['aria-expanded']}
              variant="secondary"
              size="compact"
              disabled={picked !== null}
            >
              {own ? INDEPENDENCE_LABEL[own] : sameAsTeamLabel(team)}
            </MenuButton>
          )}
        >
          <DropdownItem active={!own} onSelect={() => void choose('team')}>
            {sameAsTeamLabel(team)}
          </DropdownItem>
          <DropdownDivider />
          {INDEPENDENCE_LEVELS.map((level) => (
            <DropdownItem key={level} active={own === level} onSelect={() => void choose(level)}>
              {INDEPENDENCE_LABEL[level]}
            </DropdownItem>
          ))}
        </Dropdown>
      </span>
      <p className="agent-editor__hint">
        {INDEPENDENCE_DETAIL[effective]} {INDEPENDENCE_STILL_ASKS[effective]}
      </p>
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
