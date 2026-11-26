/**
 * Arranging the agent list: optional folders you name ("Website", "SEO",
 * "Outreach") and file agents in, or grouping by the project each agent is
 * bound to. Folders fold. The Chief stays first, outside any.
 *
 * Folders live on the Mac (`agents::folders`), beside the agents, so the
 * desk, the phone and the Chief see the same ones: they arrive with the
 * overview (`syncFolders`) and every change goes to the Mac, drawn at once
 * and confirmed when the overview comes back. Nothing shows until the first
 * folder is made. Where pinned agents sit (at the top, or in their folder) is
 * the Mac's too.
 *
 * What stays with this window, in localStorage: grouping by project or
 * showing one list instead, which sections are folded, and the order (by
 * recent activity, the default, or your own, set by dragging a row; agents
 * new since then go at the end). Every read survives storage being
 * unavailable. A window's own groups from before folders lived on the Mac
 * are brought there once (`agents_folders_bring_in`).
 *
 * @module lib/agentGroups
 */

import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Agent, AgentFolder, AgentFolders, PinnedPlacement } from './agents';
import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';

export type GroupMode = 'off' | 'project' | 'custom';

/** The list's order: by recent activity (attention), or yours, set by dragging. */
export type SortMode = 'activity' | 'yours';

export type AgentGroup = AgentFolder;

export interface GroupSettings {
  /** As shown: by project, in folders (whenever there are any, unless you chose one list), or off. */
  mode: GroupMode;
  /** The folders, in order (the Mac's). */
  groups: AgentGroup[];
  /** Which folder each agent is in, by agent id (the Mac's). */
  assign: Record<string, string>;
  /** Where pinned agents sit when there are folders (the Mac's). */
  pinned: PinnedPlacement;
  /** Folded sections, by key. */
  collapsed: string[];
  /** The order the list is in. */
  sort: SortMode;
  /** Your order, by agent id, once you've dragged one. */
  order: string[];
  /** "New folder" is being named in the sidebar; with an agent id, for that agent. Not saved. */
  naming?: boolean | string;
}

/** What this window keeps for itself. */
interface Local {
  /** `project`, or `off` once you chose one list; `custom` otherwise. */
  mode: GroupMode;
  /** You chose one list ("Show agents in one list"), so folders don't show here. */
  chosenOff: boolean;
  collapsed: string[];
  sort: SortMode;
  order: string[];
  /** Groups kept here before folders lived on the Mac, until brought there. */
  legacyGroups: AgentGroup[];
  legacyAssign: Record<string, string>;
}

const KEY = 'shipstudio.agents.groups';
const EMPTY_LOCAL: Local = {
  mode: 'off',
  chosenOff: false,
  collapsed: [],
  sort: 'activity',
  order: [],
  legacyGroups: [],
  legacyAssign: {},
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];

/** A stored value, read leniently: anything malformed reads as nothing chosen. Pure. */
export function parseLocal(raw: string | null): Local {
  if (!raw) return EMPTY_LOCAL;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const mode: GroupMode = v.mode === 'project' || v.mode === 'custom' ? v.mode : 'off';
    const legacyGroups = Array.isArray(v.groups)
      ? (v.groups as unknown[]).filter(
          (g): g is AgentGroup =>
            !!g &&
            typeof (g as AgentGroup).id === 'string' &&
            typeof (g as AgentGroup).name === 'string' &&
            (g as AgentGroup).name.trim() !== ''
        )
      : [];
    const legacyAssign: Record<string, string> = {};
    if (v.assign && typeof v.assign === 'object') {
      for (const [agent, group] of Object.entries(v.assign as Record<string, unknown>)) {
        if (typeof group === 'string' && legacyGroups.some((g) => g.id === group))
          legacyAssign[agent] = group;
      }
    }
    const order = strings(v.order);
    return {
      mode,
      chosenOff: mode === 'off' && v.chosenOff === true,
      collapsed: strings(v.collapsed),
      sort: v.sort === 'yours' && order.length > 0 ? 'yours' : 'activity',
      order,
      legacyGroups,
      legacyAssign,
    };
  } catch {
    return EMPTY_LOCAL;
  }
}

/** What the list shows, from this window's choice and the Mac's folders. Pure. */
export function shownMode(
  local: Pick<Local, 'mode' | 'chosenOff'>,
  folders: number,
  naming: boolean
): GroupMode {
  if (local.mode === 'project') return 'project';
  if (local.mode === 'off' && local.chosenOff) return 'off';
  return folders > 0 || naming ? 'custom' : 'off';
}

let local: Local = (() => {
  try {
    return parseLocal(localStorage.getItem(KEY));
  } catch {
    return EMPTY_LOCAL;
  }
})();
let mac: { groups: AgentGroup[]; assign: Record<string, string>; pinned: PinnedPlacement } = {
  groups: [],
  assign: {},
  pinned: 'top',
};
let naming: boolean | string = false;
let current: GroupSettings = compose();
const listeners = new Set<() => void>();

function compose(): GroupSettings {
  return {
    mode: shownMode(local, mac.groups.length, naming !== false),
    groups: mac.groups,
    assign: mac.assign,
    pinned: mac.pinned,
    collapsed: local.collapsed,
    sort: local.sort,
    order: local.order,
    naming: naming || undefined,
  };
}

function publish() {
  current = compose();
  listeners.forEach((l) => l());
}

function saveLocal(next: Local) {
  local = next;
  try {
    const { legacyGroups, legacyAssign, ...kept } = next;
    const stored =
      legacyGroups.length > 0 ? { ...kept, groups: legacyGroups, assign: legacyAssign } : kept;
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* a per-viewer convenience: it lasts this window */
  }
  publish();
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

/** Something sent to the Mac failed: say so in the log, and let the next overview put it right. */
function failed(what: string) {
  return (error: unknown) => {
    logger.warn(`[Agents] ${what} failed`, { error: formatCommandError(asCommandError(error)) });
    void import('./agentsStore').then((s) => s.refreshAgents());
    throw error;
  };
}

let bringingIn = false;

/** The overview's folders and agents: what the list arranges by. */
export function syncFolders(view: AgentFolders | undefined, agents: readonly Agent[]) {
  const assign: Record<string, string> = {};
  for (const agent of agents) if (agent.folder) assign[agent.id] = agent.folder;
  const groups = view?.folders ?? [];
  mac = { groups, assign, pinned: view?.pinned ?? 'top' };
  publish();
  if (!view || bringingIn || local.legacyGroups.length === 0) return;
  if (view.broughtIn) {
    // Another window brought its groups first: the Mac's folders are the list now.
    saveLocal({ ...local, legacyGroups: [], legacyAssign: {} });
    return;
  }
  bringingIn = true;
  invoke('agents_folders_bring_in', { groups: local.legacyGroups, assign: local.legacyAssign })
    .then(() => saveLocal({ ...local, legacyGroups: [], legacyAssign: {} }))
    .catch((error) =>
      logger.warn('[Agents] bringing groups to the Mac failed', { error: String(error) })
    )
    .finally(() => {
      bringingIn = false;
      void import('./agentsStore').then((s) => s.refreshAgents());
    });
}

export function setGroupMode(mode: GroupMode) {
  if (mode !== 'custom') naming = false;
  saveLocal({ ...local, mode, chosenOff: mode === 'off' });
}

/** "New folder…": its name field open in the sidebar (for one agent, when given). */
export function startNamingGroup(agentId?: string) {
  naming = agentId ?? true;
  saveLocal({ ...local, mode: local.mode === 'project' ? 'custom' : local.mode, chosenOff: false });
}

export function stopNamingGroup() {
  naming = false;
  publish();
}

/** Make a folder (a name already used is that folder), filing the agent being named for. */
export async function addGroup(name: string): Promise<AgentGroup | null> {
  const clean = name.trim();
  const agent = typeof naming === 'string' ? naming : undefined;
  naming = false;
  if (!clean) {
    publish();
    return null;
  }
  const folder = await invoke<AgentGroup>('agents_folder_create', { name: clean, agent }).catch(
    failed('making a folder')
  );
  if (!mac.groups.some((g) => g.id === folder.id))
    mac = { ...mac, groups: [...mac.groups, folder] };
  if (agent) mac = { ...mac, assign: { ...mac.assign, [agent]: folder.id } };
  publish();
  return folder;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const folder = await invoke<AgentGroup>('agents_folder_rename', { id, name }).catch(
    failed('renaming a folder')
  );
  mac = { ...mac, groups: mac.groups.map((g) => (g.id === id ? folder : g)) };
  publish();
}

/** Remove a folder; its agents stay, in no folder. */
export async function removeGroup(id: string): Promise<void> {
  mac = {
    ...mac,
    groups: mac.groups.filter((g) => g.id !== id),
    assign: Object.fromEntries(Object.entries(mac.assign).filter(([, g]) => g !== id)),
  };
  saveLocal({ ...local, collapsed: local.collapsed.filter((k) => k !== customKey(id)) });
  await invoke('agents_folder_delete', { id }).catch(failed('removing a folder'));
}

/** Put an agent in a folder, or (null) in none. */
export async function moveToGroup(agentId: string, groupId: string | null): Promise<void> {
  const assign = { ...mac.assign };
  if (groupId) assign[agentId] = groupId;
  else delete assign[agentId];
  mac = { ...mac, assign };
  publish();
  await invoke('agents_set_folder', { agentId, folder: groupId }).catch(failed('filing an agent'));
}

/** A folder dragged before or after another: the Mac keeps the new order. */
export async function moveGroup(moved: string, target: string, after: boolean): Promise<void> {
  const ids = reorder(
    mac.groups.map((g) => g.id),
    moved,
    target,
    after
  );
  const byId = new Map(mac.groups.map((g) => [g.id, g]));
  mac = { ...mac, groups: ids.flatMap((id) => byId.get(id) ?? []) };
  publish();
  await invoke('agents_folders_reorder', { ids }).catch(failed('reordering folders'));
}

export async function setPinnedPlacement(pinned: PinnedPlacement): Promise<void> {
  mac = { ...mac, pinned };
  publish();
  await invoke('agents_folders_set_pinned', { pinned }).catch(failed('placing pinned agents'));
}

export function setSortMode(sort: SortMode) {
  saveLocal({ ...local, sort });
}

/**
 * `ids` in your order: the ones you placed as you placed them, then any new
 * since, in the order given (newest last when given by creation). Pure.
 */
export function inYourOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[]
): T[] {
  const place = new Map(order.map((id, i) => [id, i]));
  const placed = items.filter((a) => place.has(a.id));
  placed.sort((a, b) => place.get(a.id)! - place.get(b.id)!);
  return [...placed, ...items.filter((a) => !place.has(a.id))];
}

/**
 * `shown` (the ids as the list shows them now) with `moved` put just before
 * `target`, or at the end when `target` is null. Pure.
 */
export function reorder(
  shown: readonly string[],
  moved: string,
  target: string | null,
  after = false
): string[] {
  if (moved === target) return [...shown];
  const rest = shown.filter((id) => id !== moved);
  if (target == null) return [...rest, moved];
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, moved];
  rest.splice(after ? at + 1 : at, 0, moved);
  return rest;
}

/** A row dragged onto another: the list takes your order from now on. */
export function moveAgent(
  shown: readonly string[],
  moved: string,
  target: string | null,
  after = false
) {
  saveLocal({ ...local, sort: 'yours', order: reorder(shown, moved, target, after) });
}

export function toggleCollapsed(key: string) {
  const folded = local.collapsed.includes(key);
  saveLocal({
    ...local,
    collapsed: folded ? local.collapsed.filter((k) => k !== key) : [...local.collapsed, key],
  });
}

const customKey = (id: string) => `group:${id}`;
const projectKey = (path: string) => `project:${path}`;
/** The section of agents in no folder (Not in a folder, Not in a project). */
export const REST_KEY = 'rest';
/** Pinned agents above the folders. */
export const PINNED_KEY = 'pinned';

export interface AgentSection {
  key: string;
  title: string;
  agents: Agent[];
  /** A folder: agents can be dropped into it, and it can be renamed or removed. */
  groupId?: string;
}

/** Pinned first, each part keeping the order it was given. Pure. */
const pinnedFirst = (agents: Agent[]) => [
  ...agents.filter((a) => a.pinned),
  ...agents.filter((a) => !a.pinned),
];

/**
 * The list in its sections, each keeping the order it was given. Off: one
 * section with no title. By project: one per bound project, by name, then
 * the rest. Folders: pinned agents first in a section of their own when
 * they sit at the top (else first in their folder), then each folder in your
 * order (empty ones too, so there is somewhere to drop), then the rest. Pure.
 */
export function sectionAgents(
  agents: Agent[],
  settings: Pick<GroupSettings, 'mode' | 'groups' | 'assign'> & { pinned?: PinnedPlacement },
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
    const atTop = (settings.pinned ?? 'top') === 'top';
    const top = atTop ? agents.filter((a) => a.pinned) : [];
    const filed = atTop ? agents.filter((a) => !a.pinned) : pinnedFirst(agents);
    const known = new Set(settings.groups.map((g) => g.id));
    const sections: AgentSection[] = settings.groups.map((g) => ({
      key: customKey(g.id),
      title: g.name,
      groupId: g.id,
      agents: filed.filter((a) => settings.assign[a.id] === g.id),
    }));
    const rest = filed.filter((a) => !known.has(settings.assign[a.id] ?? ''));
    return [
      ...(top.length > 0 ? [{ key: PINNED_KEY, title: 'Pinned', agents: top }] : []),
      ...sections,
      { key: REST_KEY, title: 'Not in a folder', agents: rest },
    ];
  }
  return [{ key: REST_KEY, title: '', agents }];
}
