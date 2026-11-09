/**
 * Accounts, from the sidebar's foot to each agent: which account is working
 * (the row), every account in one popover (swap, reorder, add), "Runs on"
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
};

export const agentsAccountsScenarios: Scenario[] = [
  {
    id: 'agents-account-row',
    title: 'Agents — which account is working, at the sidebar’s foot',
    looksRightWhen:
      'At the foot of the Agents sidebar, above Phone and Settings, one row in the Phone row’s shape: the Claude icon with a green dot, “sam@example.com” and, muted, “39% left” (the tighter of 62% of the 5-hour and 39% of the week). It never shows “This Mac”. The text truncates before it ever wraps; nothing accent-coloured.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="account-switcher"]',
    clipSelector: '.workspace-sidebar-footer',
    commands,
  },
  {
    id: 'agents-account-switcher',
    title: 'Agents — Switch account… (every account in one popover)',
    looksRightWhen:
      'A popover opening upward from the account row: “Accounts”, one muted line on the order. Claude Code: “sam@example.com” with a neutral check and “In use”, “Max plan · this Mac’s own sign-in”, “5-hour 62% left · resets …” over a slim bar and “Weekly 39% left”; then “Work” “Ready” with its email and plan, its two limits, “Finance runs only on this one”, and a secondary “Use this one now”; then “Side project” in amber “Out of usage until …” and no Use button.. Each row has the up/down pair (first up, last down disabled) and a … menu. At the bottom a quiet “+ Add account”. No accent anywhere; the in-use mark is the text colour.',
    openSelector: AGENTS_TAB,
    command: 'agents.switchAccount',
    requires: '.account-switcher .account-switcher__account[data-in-use]',
    clipSelector: '.ss-dropdown__menu.account-switcher',
    viewport: { width: 1280, height: 900 },
    commands,
  },
  {
    id: 'agents-account-add',
    title: 'Agents — Add an account… (from ⌘K, both engines here)',
    looksRightWhen:
      'The same popover, its foot asking which engine: the muted line “When one account runs out of usage, agents carry on with the next, so nothing stops.” and two secondary buttons, Claude Code and Codex, with a quiet Cancel.',
    openSelector: AGENTS_TAB,
    command: 'agents.addAccount',
    requires: '.account-switcher .account-switcher__new',
    clipSelector: '.ss-dropdown__menu.account-switcher',
    viewport: { width: 1280, height: 900 },
    commands,
  },
  {
    id: 'agents-runs-on',
    title: 'Agents — Runs on, in an agent’s … menu, and the chip in its header',
    looksRightWhen:
      'The open conversation’s header has, beside the name, a quiet chip with the Claude icon “Work · only”. The … menu, under Model and Effort, has “Runs on · Work”: Any account (“Carries on when one runs out”), sam@example.com, Work ticked, Side project (“Out of usage now”). No accent.',
    openSelector: AGENTS_TAB,
    steps: [{ click: `[data-agent-id="finance"]` }, { click: '.agent-chat__menu button' }],
    requires: '.agent-model-menu .agent-model-menu__heading',
    commands,
  },
];
