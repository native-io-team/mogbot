/**
 * Grouping the agent list, optional and off by default: by the project each
 * agent is bound to, or into groups you name yourself ("Acme", "Internal")
 * and drag agents into. Groups fold. The Chief stays first, outside any.
 *
 * A per-viewer convenience of this window's sidebar, so it lives in
 * localStorage (never the agents' registry, never the phone), and every read
 * survives storage being unavailable: grouping is simply off then.
 *
 * @module lib/agentGroups
 */

import { useSyncExternalStore } from 'react';
import type { Agent } from './agents';

export type GroupMode = 'off' | 'project' | 'custom';

export interface AgentGroup {
  id: string;
  name: string;
}

export interface GroupSettings {
  mode: GroupMode;
  /** Your own groups, in order. */
  groups: AgentGroup[];
  /** Which of your groups each agent is in, by agent id. */
  assign: Record<string, string>;
  /** Folded groups, by key. */
  collapsed: string[];
  /** "New group" is being named in the sidebar. Not saved. */
  naming?: boolean;
}

const KEY = 'shipstudio.agents.groups';
const EMPTY: GroupSettings = { mode: 'off', groups: [], assign: {}, collapsed: [] };

/** A stored value, read leniently: anything malformed reads as off. Pure. */
export function parseGroups(raw: string | null): GroupSettings {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<GroupSettings>;
    const mode: GroupMode = v.mode === 'project' || v.mode === 'custom' ? v.mode : 'off';
    const groups = Array.isArray(v.groups)
      ? v.groups.filter(
          (g): g is AgentGroup =>
            !!g && typeof g.id === 'string' && typeof g.name === 'string' && g.name.trim() !== ''
        )
      : [];
    const assign: Record<string, string> = {};
    if (v.assign && typeof v.assign === 'object') {
      for (const [agent, group] of Object.entries(v.assign)) {
        if (typeof group === 'string' && groups.some((g) => g.id === group)) assign[agent] = group;
      }
    }
    const collapsed = Array.isArray(v.collapsed)
      ? v.collapsed.filter((k): k is string => typeof k === 'string')
      : [];
    return { mode, groups, assign, collapsed };
  } catch {
    return EMPTY;
  }
}

let current: GroupSettings = (() => {
  try {
    return parseGroups(localStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
})();
const listeners = new Set<() => void>();

function set(next: GroupSettings) {
  current = next;
  try {
    const { naming: _naming, ...kept } = next;
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* a per-viewer convenience: it lasts this window */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentGroups(): GroupSettings {
  return useSyncExternalStore(subscribe, () => current);
}

export function getAgentGroups(): GroupSettings {
  return current;
}

export function setGroupMode(mode: GroupMode) {
  set({ ...current, mode, naming: mode === 'custom' ? current.naming : false });
}

/** "New group…": your own groups on, and its name field open. */
export function startNamingGroup() {
  set({ ...current, mode: 'custom', naming: true });
}

export function stopNamingGroup() {
  set({ ...current, naming: false });
}

/** Add a group by name; an existing name is that group. Returns its id. */
export function addGroup(name: string): string | null {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const same = current.groups.find((g) => g.name.toLowerCase() === clean.toLowerCase());
  if (same) {
    set({ ...current, mode: 'custom', naming: false });
    return same.id;
  }
  const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  set({ ...current, mode: 'custom', naming: false, groups: [...current.groups, { id, name: clean }] });
  return id;
}

/** Remove a group; its agents go back to Ungrouped. */
export function removeGroup(id: string) {
  const assign = Object.fromEntries(Object.entries(current.assign).filter(([, g]) => g !== id));
  set({
    ...current,
    groups: current.groups.filter((g) => g.id !== id),
    assign,
    collapsed: current.collapsed.filter((k) => k !== customKey(id)),
  });
}

/** Put an agent in one of your groups, or (null) back in Ungrouped. */
export function moveToGroup(agentId: string, groupId: string | null) {
  const assign = { ...current.assign };
  if (groupId && current.groups.some((g) => g.id === groupId)) assign[agentId] = groupId;
  else delete assign[agentId];
  set({ ...current, assign });
}

export function toggleCollapsed(key: string) {
  const folded = current.collapsed.includes(key);
  set({
    ...current,
    collapsed: folded ? current.collapsed.filter((k) => k !== key) : [...current.collapsed, key],
  });
}

const customKey = (id: string) => `group:${id}`;
const projectKey = (path: string) => `project:${path}`;
/** The section of agents in no group (Ungrouped, Not in a project). */
export const REST_KEY = 'rest';

export interface AgentSection {
  key: string;
  title: string;
  agents: Agent[];
  /** One of your groups: agents can be dropped into it, and it can be removed. */
  groupId?: string;
}

/**
 * The list in its sections, each keeping the order it was given. Off: one
 * section with no title. By project: one per bound project, by name, then
 * the rest. Your own groups: each in your order (empty ones too, so there is
 * somewhere to drop), then the rest. Pure.
 */
export function sectionAgents(
  agents: Agent[],
  settings: Pick<GroupSettings, 'mode' | 'groups' | 'assign'>,
  projectName: (path: string) => string
): AgentSection[] {
  if (settings.mode === 'project') {
    const byPath = new Map<string, Agent[]>();
    const rest: Agent[] = [];
    for (const agent of agents) {
      if (agent.project) {
        const list = byPath.get(agent.project) ?? [];
        list.push(agent);
        byPath.set(agent.project, list);
      } else rest.push(agent);
    }
    const sections = [...byPath.entries()]
      .map(([path, list]) => ({ key: projectKey(path), title: projectName(path), agents: list }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return rest.length > 0
      ? [...sections, { key: REST_KEY, title: 'Not in a project', agents: rest }]
      : sections;
  }
  if (settings.mode === 'custom') {
    const known = new Set(settings.groups.map((g) => g.id));
    const sections: AgentSection[] = settings.groups.map((g) => ({
      key: customKey(g.id),
      title: g.name,
      groupId: g.id,
      agents: agents.filter((a) => settings.assign[a.id] === g.id),
    }));
    const rest = agents.filter((a) => !known.has(settings.assign[a.id] ?? ''));
    return [...sections, { key: REST_KEY, title: 'Ungrouped', agents: rest }];
  }
  return [{ key: REST_KEY, title: '', agents }];
}
