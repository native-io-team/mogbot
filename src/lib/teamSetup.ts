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
import { AGENT_EVENTS, type AgentMessage } from './agents';

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

/** A row of the Logins step: one service the imported agents mentioned (`agents/access_check.rs`). */
export type SetupLaterState =
  | { state: 'open' }
  | { state: 'reachable'; via: string }
  | { state: 'not_needed' }
  | { state: 'asked'; agentId: string; requestId: string };

export type SetupLater = {
  key: string;
  /** The catalogue's id, or `other`. */
  service: string;
  title: string;
  agents: string[];
  agentIds: string[];
  /** The one button: "Connect Figma", "Use my browser", "Get your key". */
  action?: string;
  /** A key is the only way in. */
  keyOnly: boolean;
} & SetupLaterState;

/** "Checking what your team can already reach", live. */
export interface SetupCheck {
  running: boolean;
  total: number;
  checked: { title: string; reached: boolean }[];
  /** The browser was part of it. */
  browser: boolean;
  finishedAt?: number;
}

export interface SetupStep {
  id: SetupStepId;
  state: SetupStepState;
  logins?: SetupLogin[];
  later?: SetupLater[];
  check?: SetupCheck;
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
/** A row nothing reached: one sign-in card, started on this Mac, or put away. */
export const setupLater = (key: string, action: 'connect' | 'not_needed') =>
  invoke<{ agentId: string; requestId: string } | null>('agents_team_setup_later', { key, action });
/** Check again what the team can already reach (progress arrives on the checklist). */
export const checkTeamReach = () => invoke<number>('agents_access_check');

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

/* ------------------------------------------------------------- the words */

export const SETUP_TITLE = 'Setting up your team';
/** The bar above the Chief's composer while there's some left. */
export const SETUP_BAR_TITLE = 'A few things to finish setting up your team';

/** Bring the card into view (the bar's Continue). */
export function showTeamSetup() {
  document
    .querySelector('[data-testid="team-setup"]')
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** "2 of 4 done": steps, never requests. */
export function progressLine(view: TeamSetupView): string {
  return `${view.done} of ${view.total} done`;
}

/** The muted line under the title. */
export function sourceLine(view: TeamSetupView): string {
  return `A few things to finish for your agents from ${view.source}. They stay quiet until you say hi.`;
}

/** Each step's title, its line while open, and what it reads once done. */
export function stepWords(
  id: SetupStepId,
  chief: string
): { title: string; detail: string; done: string } {
  switch (id) {
    case 'logins':
      return {
        title: 'Logins',
        detail:
          'Checked against this Mac first: connected apps, its own sign-ins and your browser. Only what’s left is asked.',
        done: 'Logins sorted',
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

/** The progress line while the check runs: "Checking 14 services… Figma ✓ GitHub ✓". */
export function checkLine(check: SetupCheck): string {
  const n = check.total;
  const head = check.running
    ? `Checking ${n} service${n === 1 ? '' : 's'}…`
    : `Checked ${n} service${n === 1 ? '' : 's'}.`;
  const marks = check.checked.map((c) => `${c.title} ${c.reached ? '✓' : '–'}`);
  return marks.length ? `${head} ${marks.join(' ')}` : head;
}

/** Rows nothing reached and nobody decided: the residue. */
export function openLater(later: SetupLater[]): SetupLater[] {
  return later.filter((l) => l.state === 'open');
}

/** The Logins step's head once the check is done. */
export function residueLine(later: SetupLater[]): string {
  const n = openLater(later).length;
  if (n === 0) return 'Your team is ready. Everything it mentioned is reachable on this Mac.';
  return `Your team is ready. ${n} thing${n === 1 ? '' : 's'} I couldn’t reach on this Mac:`;
}

/** "Figma: your browser, signed in on www.figma.com". */
export function receiptLine(l: SetupLater): string | null {
  return l.state === 'reachable' ? `${l.title}: ${l.via}` : null;
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
