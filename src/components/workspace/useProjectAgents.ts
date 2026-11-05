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

import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  AGENT_EVENTS,
  getAgentsWithProjects,
  needsYou,
  type Agent,
  type AgentStatus,
} from '../../lib/agents';
import { logger } from '../../lib/logger';
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
      // Only a state worth reading; an idle row says nothing (it's a link).
      meta: needsYou(a) ? 'needs you' : a.status.state === 'working' ? 'working' : undefined,
      onSelect: () => openAgent(a.id),
    }));
}

/**
 * The registry's project-bound agents, kept current from Agents' own events.
 * Deliberately not the Agents store: that one creates the Chief of Staff and
 * probes every engine, which a project window has no reason to do.
 */
function useAgentsWithProjects(enabled: boolean): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refetch = () =>
      getAgentsWithProjects()
        .then((list) => alive && setAgents(list))
        .catch((e) => logger.warn('[Agents] project agents failed', { error: String(e) }));
    void refetch();
    const unlistens: Promise<UnlistenFn>[] = [
      listen(AGENT_EVENTS.registry, () => void refetch()),
      listen<{ agentId: string; status: AgentStatus }>(AGENT_EVENTS.status, (e) => {
        const { agentId, status } = e.payload;
        setAgents((list) => list.map((a) => (a.id === agentId ? { ...a, status } : a)));
      }),
    ];
    return () => {
      alive = false;
      for (const u of unlistens) void u.then((off) => off()).catch(() => undefined);
    };
  }, [enabled]);
  return agents;
}

/** Rows for the project open in this window; empty when no agent works here. */
export function useProjectAgents(
  projectPath: string | null,
  onGoAgents: (() => void) | undefined
): ProjectAgentRow[] {
  const agents = useAgentsWithProjects(Boolean(onGoAgents && projectPath));
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
