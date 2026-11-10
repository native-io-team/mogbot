/**
 * The persistent agents that work in a project, for the workspace sidebar.
 * The sidebar's other section is the project's terminal sessions; these are
 * the teammates from Agents: the ones bound to this folder, and any agent
 * whose turn is working in it right now (by its own commands or a session;
 * the Mac reports the folder, `TurnWork.project`). A person dropping into the
 * project sees who works here and what they're doing, and can open the chat.
 *
 * Every project row in the sidebar also gets its agents at work
 * (`useAgentsAtWork`), so a project an agent is busy in shows it on the
 * Projects side without opening it.
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
  plainActivity,
  type Agent,
  type AgentStatus,
} from '../../lib/agents';
import { logger } from '../../lib/logger';
import { requestAgentsIntent } from '../../commands/useAgentsCommands';
import {
  agentsAtWork,
  atWorkText,
  sameFolder,
} from '../../../packages/companion-protocol/src/work';

export interface ProjectAgentRow {
  key: string;
  /** The agent, for its key in the row (as agents at work show theirs). */
  agentId: string;
  color: string;
  working: boolean;
  label: string;
  dotState: 'idle' | 'thinking' | 'waiting';
  meta?: string;
  onSelect: () => void;
}

/** "Juno · Running the build": an agent at work in a project, in its row. */
export interface AtWorkLine {
  agentId: string;
  name: string;
  color: string;
  text: string;
  waiting: boolean;
}

export function atWorkLines(agents: Agent[], projectPath: string, now: number): AtWorkLine[] {
  return agentsAtWork(agents, projectPath).map((a) => ({
    agentId: a.id,
    name: a.name,
    color: a.color,
    text: atWorkText(a, plainActivity(a.status.activity), now),
    waiting: needsYou(a),
  }));
}

export function projectAgentRows(
  agents: Agent[],
  projectPath: string | null,
  openAgent: (agentId: string) => void,
  now: number = Date.now()
): ProjectAgentRow[] {
  if (!projectPath) return [];
  const atWork = atWorkLines(agents, projectPath, now);
  const bound = agents.filter(
    (a) =>
      !a.hidden &&
      a.project &&
      sameFolder(a.project, projectPath) &&
      !atWork.some((w) => w.agentId === a.id)
  );
  // Agents at work here are rows among the Sessions, not here (`agentWorkItems`).
  return bound.map((a) => ({
    key: `agent-${a.id}`,
    agentId: a.id,
    color: a.color,
    working: a.status.state === 'working',
    label: a.name,
    dotState: needsYou(a) ? 'waiting' : a.status.state === 'working' ? 'thinking' : 'idle',
    meta: needsYou(a) ? 'needs you' : a.status.state === 'working' ? 'working' : undefined,
    onSelect: () => openAgent(a.id),
  }));
}

/**
 * The agents the sidebar can show at work: bound ones and any whose turn is
 * in a project, kept current from Agents' own events. Deliberately not the
 * Agents store: that one creates the Chief of Staff and probes every engine,
 * which a project window has no reason to do.
 */
export function useAgentsAtWork(enabled: boolean): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let known = new Set<string>();
    const refetch = () =>
      getAgentsWithProjects()
        .then((list) => {
          if (!alive) return;
          known = new Set(list.map((a) => a.id));
          setAgents(list);
        })
        .catch((e) => logger.warn('[Agents] project agents failed', { error: String(e) }));
    void refetch();
    const unlistens: Promise<UnlistenFn>[] = [];
    const on: typeof listen = (event, handler) => {
      try {
        const p = listen(event, handler);
        unlistens.push(p.catch(() => () => undefined));
        return p;
      } catch {
        // No Tauri event bridge (tests, the harness): nothing to listen to.
        return Promise.resolve(() => undefined);
      }
    };
    void on(AGENT_EVENTS.registry, () => void refetch());
    void on<{ agentId: string; status: AgentStatus }>(AGENT_EVENTS.status, (e) => {
      const { agentId, status } = e.payload;
      if (!known.has(agentId)) {
        // An agent this list doesn't have yet just started working in a
        // project: read the list again to get it.
        if (status.work?.project) void refetch();
        return;
      }
      setAgents((list) => list.map((a) => (a.id === agentId ? { ...a, status } : a)));
    });
    return () => {
      alive = false;
      for (const u of unlistens) void u.then((off) => off()).catch(() => undefined);
    };
  }, [enabled]);
  return agents;
}

/** Opens an agent's chat in Agents. */
export function openAgentChat(onGoAgents: () => void, agentId: string) {
  requestAgentsIntent({ kind: 'open', agentId });
  onGoAgents();
}

/** Rows for the project open in this window; empty when no agent works here. */
export function useProjectAgents(
  agents: Agent[],
  projectPath: string | null,
  onGoAgents: (() => void) | undefined,
  now: number
): ProjectAgentRow[] {
  return useMemo(
    () =>
      onGoAgents
        ? projectAgentRows(agents, projectPath, (id) => openAgentChat(onGoAgents, id), now)
        : [],
    [agents, projectPath, onGoAgents, now]
  );
}
