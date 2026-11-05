/**
 * The persistent agents that work in a project, as rows for the workspace
 * sidebar. The sidebar's other section is the project's terminal sessions;
 * these are the teammates from Agents bound to this folder, so a person
 * dropping into the project sees who works here and can message them.
 *
 * Clicking a row switches to Agents with that agent's conversation open.
 *
 * @module components/workspace/useProjectAgents
 */

import { useMemo } from 'react';
import { needsYou, type Agent } from '../../lib/agents';
import { useAgentsList } from '../../lib/agentsStore';
import { requestAgentsIntent } from '../../commands/useAgentsCommands';

export interface ProjectAgentRow {
  key: string;
  label: string;
  dotState: 'idle' | 'thinking' | 'waiting';
  meta?: string;
  onSelect: () => void;
}

/** Trailing slashes aside, the same folder. Never a guess beyond that. */
function sameFolder(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export function projectAgentRows(
  agents: Agent[],
  projectPath: string | null,
  openAgent: (agentId: string) => void
): ProjectAgentRow[] {
  if (!projectPath) return [];
  return agents
    .filter((a) => !a.hidden && a.project && sameFolder(a.project, projectPath))
    .map((a) => ({
      key: `agent-${a.id}`,
      label: a.name,
      dotState: needsYou(a) ? 'waiting' : a.status.state === 'working' ? 'thinking' : 'idle',
      meta: needsYou(a) ? 'needs you' : a.status.state === 'working' ? 'working' : 'message',
      onSelect: () => openAgent(a.id),
    }));
}

/** Rows for the project open in this window; empty when no agent works here. */
export function useProjectAgents(
  projectPath: string | null,
  onGoAgents: (() => void) | undefined
): ProjectAgentRow[] {
  const agents = useAgentsList();
  return useMemo(
    () =>
      onGoAgents
        ? projectAgentRows(agents, projectPath, (agentId) => {
            requestAgentsIntent({ kind: 'open', agentId });
            onGoAgents();
          })
        : [],
    [agents, projectPath, onGoAgents]
  );
}
