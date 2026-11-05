/**
 * "Setting up your team": the one checklist in the Chief's chat after an
 * import (`src-tauri/src/agents/team_setup.rs`). Types mirroring the Rust
 * view, the invoke wrappers, a shared store every surface reads (the card,
 * What's in flight, ⌘K), and the card's words.
 *
 * The checklist is read from the Mac every time: a login saved in an
 * agent's own chat ticks it off here, so there's no copy of it to drift.
 *
 * @module lib/teamSetup
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AGENT_EVENTS, type Agent, type AgentMessage } from './agents';

export type SetupStepId = 'logins' | 'routines' | 'missing' | 'hello';
export type SetupStepState = 'open' | 'done' | 'skipped';
export type HelloState = 'quiet' | 'working' | 'said_hi';

export interface SetupLogin {
  agentId: string;
  agentName: string;
  requestId: string;
  name: string;
  purpose: string;
}

export interface SetupRoutine {
  agentId: string;
  agentName: string;
  checkInId: string;
  /** "Every weekday at 09:00", as the schedule says it. */
  when: string;
  what: string;
  on: boolean;
}

export interface SetupGapGroup {
  agentId: string;
  agentName: string;
  lines: string[];
}

export interface SetupHello {
  agentId: string;
  agentName: string;
  color: string;
  state: HelloState;
}

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  logins?: SetupLogin[];
  routines?: SetupRoutine[];
  gaps?: SetupGapGroup[];
  agents?: SetupHello[];
}

export interface TeamSetupView {
  id: string;
  source: string;
  steps: SetupStep[];
  done: number;
  total: number;
  current?: SetupStepId;
  complete: boolean;
  agents: number;
  setAside?: number;
  /** Put away by the user (only from `getTeamSetup(true)`). */
  dismissed?: boolean;
}

export const TEAM_SETUP_EVENT = 'agents://team-setup';

export const getTeamSetup = (any = false) =>
  invoke<TeamSetupView | null>('agents_team_setup', { any });
export const setTeamSetupStep = (step: SetupStepId, state: SetupStepState) =>
  invoke<void>('agents_team_setup_step', { step, state });
export const setTeamSetupRoutine = (agentId: string, checkInId: string, on: boolean) =>
  invoke<void>('agents_team_setup_routine', { agentId, checkInId, on });
export const sayHiFromSetup = (agentId: string) =>
  invoke<AgentMessage>('agents_team_setup_hello', { agentId });
export const askChiefAboutMissing = () => invoke<AgentMessage>('agents_team_setup_missing');
export const dismissTeamSetup = () => invoke<void>('agents_team_setup_dismiss');
export const reopenTeamSetup = () => invoke<void>('agents_team_setup_reopen');

/* ------------------------------------------------------------- the store */

let current: TeamSetupView | null = null;
let loaded = false;
const subscribers = new Set<() => void>();
let stop: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function set(view: TeamSetupView | null) {
  current = view;
  loaded = true;
  subscribers.forEach((s) => s());
}

/** Read the checklist again. */
export async function refreshTeamSetup(): Promise<TeamSetupView | null> {
  try {
    const view = await getTeamSetup();
    set(view ?? null);
    return view ?? null;
  } catch {
    // An older Mac without the command: no checklist, never an error.
    set(null);
    return null;
  }
}

/** Registry and status changes (a login saved, an agent replying) move it on. */
function soon() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refreshTeamSetup();
  }, 250);
}

function start() {
  const unlisteners = [
    listen<TeamSetupView | null>(TEAM_SETUP_EVENT, (e) => set(e.payload ?? null)),
    listen(AGENT_EVENTS.registry, soon),
    listen(AGENT_EVENTS.status, soon),
  ];
  void refreshTeamSetup();
  stop = () => {
    for (const u of unlisteners) void u.then((f) => f()).catch(() => undefined);
    stop = null;
  };
}

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (!stop) start();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) stop?.();
  };
}

/** The checklist, live: `null` when there's none to show. */
export function useTeamSetup(): TeamSetupView | null {
  const view = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (!loaded) void refreshTeamSetup();
  }, []);
  return view;
}

/**
 * Whether there's a checklist to come back to, put away or not: what ⌘K and
 * What's in flight offer. `null` when there's none, or it's finished.
 */
export function useResumableTeamSetup(): TeamSetupView | null {
  const live = useTeamSetup();
  const [any, setAny] = useState<TeamSetupView | null>(null);
  useEffect(() => {
    let on = true;
    void getTeamSetup(true)
      .then((v) => on && setAny(v ?? null))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [live]);
  const view = live ?? any;
  return view && !view.complete ? view : null;
}

/** Bring the checklist back and show it (the Chief's chat opens on it). */
export async function resumeTeamSetup(): Promise<void> {
  await reopenTeamSetup();
  await refreshTeamSetup();
}

/** Tests: forget what was read. */
export function resetTeamSetupForTests() {
  stop?.();
  current = null;
  loaded = false;
}

/**
 * Logins the checklist holds, per agent. While a setup isn't finished they
 * live in its one card, so the sidebar, its "Needs your OK · N" row and the
 * dock badge leave them out: an import of sixteen agents should read as one
 * thing to finish, not sixteen amber rows.
 */
export function heldLogins(view: TeamSetupView | null): Map<string, number> {
  const held = new Map<string, number>();
  if (!view || view.complete) return held;
  for (const l of view.steps.flatMap((s) => s.logins ?? [])) {
    held.set(l.agentId, (held.get(l.agentId) ?? 0) + 1);
  }
  return held;
}

/** The agents as the sidebar counts them: without the logins the checklist holds. */
export function withoutHeldLogins(agents: Agent[], view: TeamSetupView | null): Agent[] {
  const held = heldLogins(view);
  if (held.size === 0) return agents;
  return agents.map((a) => {
    const n = held.get(a.id);
    if (!n || !a.pendingApprovals) return a;
    return { ...a, pendingApprovals: Math.max(0, a.pendingApprovals - n) };
  });
}

/* ------------------------------------------------------------- the words */

export const SETUP_TITLE = 'Setting up your team';
/** The bar above the Chief's composer while there's some left. */
export const SETUP_BAR_TITLE = 'Your team is almost ready';

/** Bring the card into view (the bar's Continue). */
export function showTeamSetup() {
  document
    .querySelector('[data-testid="team-setup"]')
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * "2 steps left": steps, never requests, and what's left rather than "0 of 4
 * done", which reads as homework not yet started.
 */
export function progressLine(view: Pick<TeamSetupView, 'done' | 'total'>): string {
  const left = Math.max(0, view.total - view.done);
  if (left === 0) return 'All done';
  return `${left} ${left === 1 ? 'step' : 'steps'} left`;
}

/** The muted line under the title. */
export function sourceLine(view: TeamSetupView): string {
  const who = view.agents > 1 ? `Your ${view.agents} agents` : 'Your agent';
  return `${who} from ${view.source} ${view.agents > 1 ? 'are' : 'is'} here, quiet until you say hi. These get them going.`;
}

/** Each step's title, its line while open, and what it reads once done. */
export function stepWords(
  id: SetupStepId,
  chief: string
): { title: string; detail: string; done: string } {
  switch (id) {
    case 'logins':
      return {
        title: 'Add logins',
        detail: 'Each one goes into this Mac’s Keychain, never the chat.',
        done: 'Logins added',
      };
    case 'routines':
      return {
        title: 'Switch on routines',
        detail: 'They came in paused. Switch on the ones you want; they run while the app is open.',
        done: 'Routines checked',
      };
    case 'missing':
      return {
        title: 'Fill in what’s missing',
        detail: `A few things didn’t come across. ${chief} can sort most of them and ask you the rest in one go.`,
        done: `Handed to ${chief}`,
      };
    case 'hello':
      return {
        title: 'Say hi to your team',
        detail:
          'Meet them one at a time. Each tells you what it’ll handle and anything it still needs.',
        done: 'Said hi',
      };
  }
}

/** What a step reads as in its row. */
export function stepStatus(step: SetupStep, chief: string): string {
  if (step.state === 'skipped') return 'Skipped';
  if (step.state === 'done') return stepWords(step.id, chief).done;
  return '';
}

/** Logins by service, whoever needs them: one row for a login several agents use. */
export function groupLogins(
  logins: SetupLogin[]
): { key: string; name: string; items: SetupLogin[] }[] {
  const groups = new Map<string, { key: string; name: string; items: SetupLogin[] }>();
  for (const l of logins) {
    const key = l.name.trim().toLowerCase();
    const g = groups.get(key) ?? { key, name: l.name, items: [] };
    g.items.push(l);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Whether someone is replying to their hello right now (Say hi waits). */
export function helloBusy(view: TeamSetupView): SetupHello | undefined {
  return view.steps.find((s) => s.id === 'hello')?.agents?.find((a) => a.state === 'working');
}

/** Agents the checklist covers that haven't been met: their requests fold into it. */
export function quietAgentIds(view: TeamSetupView | null): Set<string> {
  const ids = new Set<string>();
  if (!view || view.complete) return ids;
  for (const a of view.steps.find((s) => s.id === 'hello')?.agents ?? []) {
    if (a.state === 'quiet') ids.add(a.agentId);
  }
  return ids;
}
