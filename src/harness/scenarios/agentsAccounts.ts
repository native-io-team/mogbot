/**
 * Accounts, from the sidebar's foot to each agent: usage at a glance (the
 * row), every account in the Usage view (swap, reorder, add), "Runs on"
 * in an agent's … menu, and the chip in its header naming the account its
 * last turn ran on. Built on the Agents team fixture (`./agents`); every
 * name and address is fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, now, overview } from './agents';

const H = 3_600_000;

/** This Mac's own Claude sign-in, unnamed, so shown as who it is; Work added; Codex here too. */
export const ACCOUNTS = [
  {
    id: 'default',
    engine: 'claude',
    name: 'sam@example.com',
    named: false,
    thisMac: true,
    signedIn: true,
    email: 'sam@example.com',
    plan: 'Max',
    out: false,
  },
  {
    id: 'a1work',
    engine: 'claude',
    name: 'Work',
    named: true,
    thisMac: false,
    signedIn: true,
    email: 'sam@northwind.example',
    plan: 'Team',
    out: false,
  },
  {
    id: 'a2old',
    engine: 'claude',
    name: 'Side project',
    named: true,
    thisMac: false,
    signedIn: true,
    email: 'sam.side@example.net',
    limit: { at: now - 40 * 60_000, resetsAt: now + 3 * H },
    out: true,
  },
  {
    id: 'default',
    engine: 'codex',
    name: 'Signed in on this Mac',
    named: false,
    thisMac: true,
    signedIn: false,
    out: false,
  },
];

const win = (kind: string, used: number, resetsIn: number) => ({
  kind,
  usedPercent: used,
  resetsAt: now + resetsIn,
  limited: false,
  observedAt: now - 8 * 60_000,
});

const line = (
  id: string,
  name: string,
  windows: unknown[],
  extra: Record<string, unknown> = {}
) => ({
  engine: 'claude',
  id,
  name,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  next: id === 'default',
  windows,
  learned: [],
  ...extra,
});

export const ACCOUNTS_INVENTORY = {
  mode: 'normal',
  engines: [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      signedIn: true,
      agents: TEAM.length,
      nextAccount: 'sam@example.com',
      allOut: false,
    },
    {
      id: 'codex',
      label: 'Codex',
      installed: true,
      signedIn: false,
      agents: 0,
      allOut: false,
    },
  ],
  accounts: [
    line('default', 'sam@example.com', [win('five_hour', 38, 2 * H), win('seven_day', 61, 50 * H)]),
    line('a1work', 'Work', [win('five_hour', 12, 4 * H), win('seven_day', 22, 80 * H)]),
    line('a2old', 'Side project', [], { out: true, outUntil: now + 3 * H }),
  ],
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  now,
};

/** Finance is set to run only on Work, and its last turn ran there. */
const TEAM_ON_ACCOUNTS = overview(
  TEAM.map((a) =>
    a.id === 'chief'
      ? { ...a, ranOn: { id: 'default', name: 'sam@example.com' } }
      : a.id === 'finance'
        ? { ...a, account: 'a1work', ranOn: { id: 'a1work', name: 'Work' } }
        : a
  )
);

const commands = {
  agents_overview: TEAM_ON_ACCOUNTS,
  agents_messages: messagesFor,
  agents_accounts: ACCOUNTS,
  agents_usage_overview: ACCOUNTS_INVENTORY,
  agents_account_use: ACCOUNTS,
  agents_account_reorder: ACCOUNTS,
  agents_account_rename: null,
  agents_account_remove: null,
  agents_account_add: null,
  agents_crossover: { claude: 'ask', codex: 'ask', away: [] },
};

export const agentsAccountsScenarios: Scenario[] = [
  {
    id: 'agents-account-row',
    title: 'Agents — which account is working, at the sidebar’s foot',
    looksRightWhen:
      'At the foot of the Agents sidebar, above Phone and Settings: the Claude icon with a green dot, “Room to work”, the stack as three thin segments (sam@example.com 39% in ink, Work 78% quieter, Side project empty: out of usage) and, muted, “2 accounts · resets …”. It never shows “This Mac”. Nothing wraps; nothing accent-coloured.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="account-switcher"]',
    clipSelector: '.workspace-sidebar-footer',
    commands,
  },
  {
    id: 'agents-account-switcher',
    title: 'Agents — Switch account… (opens Usage)',
    looksRightWhen:
      'The Usage view, from ⌘K: the hero with the stack (sam@example.com in use, Work next, Side project out of usage), then each account as a key card in order with “Use this one now” on Work and none on the one out.',
    openSelector: AGENTS_TAB,
    command: 'agents.switchAccount',
    requires: '[data-testid="usage-hero"]',
    viewport: { width: 1280, height: 900 },
    commands,
  },
  {
    id: 'agents-runs-on',
    title: 'Agents — Runs on, in an agent’s … menu, and the chip in its header',
    looksRightWhen:
      'The open conversation’s header has, beside the name, a quiet chip with the Claude icon “Work · only”. The … menu, under Model and Effort, has “Runs on · Work”: Any account (“In order, carrying on with the next when one runs out”), then each account with “Only this one, never another”, Work ticked, Side project “…· out of usage now” (the phone’s words). No accent.',
    openSelector: AGENTS_TAB,
    steps: [{ click: `[data-agent-id="finance"]` }, { click: '.agent-chat__menu button' }],
    requires: '.agent-model-menu .agent-model-menu__heading',
    commands,
  },
];
