/**
 * Which agent's conversation the workspace's Session panel shows, per
 * project, in place of a terminal. Clicking an agent in a project's sidebar
 * (one bound to it, or one at work in it) opens its chat right there, so
 * someone who works in a project only through agents never needs a terminal;
 * clicking a session or terminal row goes back to the terminals, which keep
 * running underneath.
 *
 * In memory only: a relaunch opens on the terminals, as before.
 *
 * @module lib/sessionAgentChat
 */

import { useSyncExternalStore } from 'react';

let shown = new Map<string, string>();
const listeners = new Set<() => void>();

/** Show `agentId`'s chat in `projectPath`'s Session panel, or the terminals again (null). */
export function showAgentInSession(projectPath: string, agentId: string | null) {
  if ((shown.get(projectPath) ?? null) === agentId) return;
  const next = new Map(shown);
  if (agentId) next.set(projectPath, agentId);
  else next.delete(projectPath);
  shown = next;
  for (const l of listeners) l();
}

/** The agent whose chat the Session panel shows for this project, if any. */
export function sessionAgentOf(projectPath: string | null | undefined): string | null {
  return projectPath ? (shown.get(projectPath) ?? null) : null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionAgent(projectPath: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => sessionAgentOf(projectPath),
    () => sessionAgentOf(projectPath)
  );
}

/** Tests only. */
export function __resetSessionAgents() {
  shown = new Map();
  for (const l of listeners) l();
}
