/**
 * Usage awareness: Settings → Agents → Usage and What's in flight's line for a
 * reset near with capacity left. Shapes are `agents::inventory::Inventory`
 * as serde writes it (camelCase, absent optionals left out).
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, now, overview } from './agents';

const H = 3_600_000;

const estimate = (tokens: number, runs: number, days = 4) => ({
  estimate: true,
  tokens,
  low: Math.round(tokens * 0.4),
  high: Math.round(tokens * 2.1),
  runs,
  days,
});

/** Three Claude accounts and a Codex one, Use it all, a spare 5-hour window. */
export const FULL_INVENTORY = {
  mode: 'use_it_all',
  modeSetAt: now - 2 * 86_400_000,
  engines: [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      signedIn: true,
      agents: 5,
      nextAccount: 'This Mac',
      allOut: false,
      perTurn: estimate(48_000, 212, 7),
    },
    {
      id: 'codex',
      label: 'Codex',
      installed: true,
      signedIn: true,
      agents: 1,
      nextAccount: 'ChatGPT Plus',
      allOut: false,
    },
  ],
  accounts: [
    {
      engine: 'claude',
      id: 'default',
      name: 'This Mac',
      thisMac: true,
      signedIn: true,
      out: false,
      next: true,
      windows: [
        {
          kind: 'five_hour',
          usedPercent: 38,
          resetsAt: now + 40 * 60_000,
          limited: false,
          observedAt: now - 12 * 60_000,
        },
        {
          kind: 'seven_day',
          usedPercent: 61,
          resetsAt: now + 3 * 86_400_000,
          limited: false,
          observedAt: now - 12 * 60_000,
        },
      ],
      learned: ['five_hour'],
      // The Mac's estimate (`forecast::pace`): the weekly window runs out in
      // two days at the recent rate, a day before its reset.
      pace: [
        {
          estimate: true,
          kind: 'seven_day',
          resetsAt: now + 3 * 86_400_000,
          reachesAt: now + 2 * 86_400_000,
          readings: 14,
          spanMinutes: 1380,
        },
      ],
    },
    {
      engine: 'claude',
      id: 'a1work',
      name: 'Work',
      thisMac: false,
      signedIn: true,
      out: true,
      outUntil: now + 5 * H,
      next: false,
      windows: [
        {
          kind: 'seven_day',
          usedPercent: 100,
          resetsAt: now + 5 * H,
          limited: true,
          observedAt: now - 9 * H,
        },
      ],
      learned: [],
    },
    {
      engine: 'claude',
      id: 'a2personal',
      name: 'Personal',
      thisMac: false,
      signedIn: true,
      out: false,
      next: false,
      windows: [],
      learned: [],
      // A `claude setup-token` sign-in: refused for its scope (agents::usage_read).
      check: {
        at: now - 4 * 60_000,
        outcome: 'cant_read',
        why: 'Can’t read its limits between turns with the token it was added with. They show after a turn runs on it',
      },
    },
    {
      engine: 'codex',
      id: 'c1plus',
      name: 'ChatGPT Plus',
      thisMac: false,
      signedIn: true,
      out: false,
      next: true,
      plan: 'plus',
      windows: [
        {
          kind: 'primary',
          usedPercent: 92,
          resetsAt: now + 2 * H,
          windowMinutes: 300,
          limited: false,
          observedAt: now - 30 * 60_000,
        },
      ],
      learned: [],
    },
  ],
  local: [
    { name: 'Opencode', models: [] },
    { name: 'Ollama', running: true, models: ['llama3.2:3b', 'qwen2.5-coder:7b'] },
  ],
  spare: [
    {
      engine: 'claude',
      accountId: 'default',
      accountName: 'This Mac',
      next: true,
      kind: 'five_hour',
      usedPercent: 38,
      resetsAt: now + 40 * 60_000,
      observedAt: now - 12 * 60_000,
    },
  ],
  backlog: [
    {
      id: 's1',
      text: 'Read the three climate papers in Downloads and summarise what changed',
      agentId: 'research',
      addedBy: 'you',
      addedAt: now - 3 * 86_400_000,
      state: 'waiting',
    },
    {
      id: 's2',
      text: 'Tidy the invoice folder names to YYYY-MM client',
      addedBy: 'Finance',
      addedAt: now - 86_400_000,
      state: 'started',
      startedAt: now - 5 * 60_000,
    },
  ],
  agents: [
    {
      id: 'research',
      name: 'Research',
      engine: 'claude',
      isMain: false,
      perTurn: estimate(61_000, 40),
    },
  ],
  routines: [],
  // As agents::compute::totals works them out from the accounts above.
  totals: {
    accounts: 4,
    signedIn: 4,
    engines: [
      { engine: 'claude', accounts: 3, read: 2, room: 1 },
      { engine: 'codex', accounts: 1, read: 1, room: 1 },
    ],
    read: 3,
    room: 2,
    windows: [
      {
        family: 'session',
        read: 2,
        room: 2,
        soonestReset: {
          engine: 'claude',
          accountId: 'default',
          accountName: 'This Mac',
          at: now + 40 * 60_000,
        },
      },
      {
        family: 'weekly',
        read: 2,
        room: 1,
        soonestReset: {
          engine: 'claude',
          accountId: 'a1work',
          accountName: 'Work',
          at: now + 5 * H,
        },
      },
    ],
    nextRoom: { engine: 'claude', accountId: 'a1work', accountName: 'Work', at: now + 5 * H },
  },
  now,
};

const win = (kind: string, usedPercent: number, resetsIn: number, windowMinutes?: number) => ({
  kind,
  usedPercent,
  resetsAt: now + resetsIn,
  ...(windowMinutes ? { windowMinutes } : {}),
  limited: false,
  observedAt: now - 6 * 60_000,
});

/**
 * Two Claude accounts both running out before either resets, and Codex with
 * room: the Mac's run-out estimate across accounts (agents::compute).
 */
export const RUNOUT_INVENTORY = {
  ...FULL_INVENTORY,
  mode: 'normal',
  spare: [],
  backlog: [],
  accounts: [
    {
      engine: 'claude',
      id: 'default',
      name: 'This Mac',
      thisMac: true,
      signedIn: true,
      out: false,
      next: true,
      plan: 'max',
      windows: [win('five_hour', 72, 3 * H), win('seven_day', 58, 74 * H)],
      learned: ['five_hour'],
      pace: [
        {
          estimate: true,
          kind: 'five_hour',
          resetsAt: now + 3 * H,
          reachesAt: now + 2 * H,
          readings: 7,
          spanMinutes: 95,
        },
      ],
      check: { at: now - 6 * 60_000, outcome: 'read' },
    },
    {
      engine: 'claude',
      id: 'a1work',
      name: 'Work',
      thisMac: false,
      signedIn: true,
      out: false,
      next: false,
      windows: [win('five_hour', 81, 4 * H), win('seven_day', 44, 120 * H)],
      learned: [],
      pace: [
        {
          estimate: true,
          kind: 'five_hour',
          resetsAt: now + 4 * H,
          reachesAt: now + 2.75 * H,
          readings: 6,
          spanMinutes: 80,
        },
      ],
      check: { at: now - 6 * 60_000, outcome: 'read' },
    },
    {
      engine: 'codex',
      id: 'c1plus',
      name: 'ChatGPT Plus',
      thisMac: false,
      signedIn: true,
      out: false,
      next: true,
      plan: 'plus',
      windows: [win('primary', 30, 3 * H, 300), win('secondary', 12, 96 * H, 10080)],
      learned: [],
      check: { at: now - 6 * 60_000, outcome: 'read' },
    },
  ],
  totals: {
    accounts: 3,
    signedIn: 3,
    engines: [
      { engine: 'claude', accounts: 2, read: 2, room: 2 },
      { engine: 'codex', accounts: 1, read: 1, room: 1 },
    ],
    read: 3,
    room: 3,
    windows: [
      {
        family: 'session',
        read: 3,
        room: 3,
        soonestReset: {
          engine: 'claude',
          accountId: 'default',
          accountName: 'This Mac',
          at: now + 3 * H,
        },
      },
      {
        family: 'weekly',
        read: 3,
        room: 3,
        soonestReset: {
          engine: 'claude',
          accountId: 'default',
          accountName: 'This Mac',
          at: now + 74 * H,
        },
      },
    ],
    runOut: [
      { estimate: true, engine: 'claude', reachesAt: now + 2.75 * H, readings: 13, accounts: 2 },
    ],
  },
};

/**
 * Claude on this Mac (Max, its weekly limit running out before the reset, by
 * estimate), a second Claude account and Codex not signed in. `TWO_CLAUDE`:
 * the second read from its rate-limit headers, at its weekly limit;
 * `ONE_READ`: the second can't be read. Totals as agents::compute works them.
 */
const weekReset = now + 76 * H;
const personalReset = now + 52 * H;
const MAC_PACED = {
  engine: 'claude',
  id: 'default',
  name: 'This Mac',
  thisMac: true,
  signedIn: true,
  out: false,
  next: true,
  plan: 'max',
  windows: [win('five_hour', 7, 3 * H), win('seven_day', 71, 76 * H)],
  learned: ['five_hour', 'seven_day'],
  pace: [
    {
      estimate: true,
      kind: 'seven_day',
      resetsAt: weekReset,
      reachesAt: now + 34 * H,
      readings: 200,
      spanMinutes: 600,
    },
  ],
  check: { at: now - 4 * 60_000, outcome: 'read' },
};
const CODEX_SIGNED_OUT = {
  engine: 'codex',
  id: 'default',
  name: 'This Mac',
  thisMac: true,
  signedIn: false,
  out: false,
  next: true,
  windows: [],
  learned: [],
};
const at = (accountId: string, accountName: string, t: number) => ({
  engine: 'claude',
  accountId,
  accountName,
  at: t,
});

export const TWO_CLAUDE_INVENTORY = {
  ...RUNOUT_INVENTORY,
  accounts: [
    MAC_PACED,
    {
      engine: 'claude',
      id: 'p1',
      name: 'Personal',
      thisMac: false,
      signedIn: true,
      out: true,
      outUntil: personalReset,
      next: false,
      windows: [{ ...win('seven_day', 100, 52 * H), limited: true }],
      learned: [],
      check: { at: now - 4 * 60_000, outcome: 'read', via: 'headers' },
    },
    CODEX_SIGNED_OUT,
  ],
  totals: {
    accounts: 3,
    signedIn: 2,
    engines: [
      { engine: 'claude', accounts: 2, read: 2, room: 1 },
      { engine: 'codex', accounts: 1, read: 0, room: 0 },
    ],
    read: 2,
    room: 1,
    windows: [
      { family: 'session', read: 1, room: 1, soonestReset: at('default', 'This Mac', now + 3 * H) },
      { family: 'weekly', read: 2, room: 1, soonestReset: at('p1', 'Personal', personalReset) },
    ],
    nextRoom: at('p1', 'Personal', personalReset),
  },
};

export const ONE_READ_INVENTORY = {
  ...TWO_CLAUDE_INVENTORY,
  accounts: [
    MAC_PACED,
    {
      engine: 'claude',
      id: 'p1',
      name: 'Personal',
      thisMac: false,
      signedIn: true,
      out: false,
      next: false,
      windows: [],
      learned: [],
      check: {
        at: now - 4 * 60_000,
        outcome: 'cant_read',
        why: 'Can’t read its limits between turns with the token it was added with. They show after a turn runs on it',
      },
    },
    CODEX_SIGNED_OUT,
  ],
  totals: {
    accounts: 3,
    signedIn: 2,
    engines: [
      { engine: 'claude', accounts: 2, read: 1, room: 1 },
      { engine: 'codex', accounts: 1, read: 0, room: 0 },
    ],
    read: 1,
    room: 1,
    windows: [
      { family: 'session', read: 1, room: 1, soonestReset: at('default', 'This Mac', now + 3 * H) },
      { family: 'weekly', read: 1, room: 1, soonestReset: at('default', 'This Mac', weekReset) },
    ],
  },
};

/** Fresh: no reading from any engine, too little history to estimate. */
export const EMPTY_INVENTORY = {
  mode: 'normal',
  engines: [
    {
      id: 'claude',
      label: 'Claude Code',
      installed: true,
      signedIn: true,
      agents: 1,
      nextAccount: 'This Mac',
      allOut: false,
    },
    { id: 'codex', label: 'Codex', installed: false, signedIn: false, agents: 0, allOut: false },
  ],
  accounts: [
    {
      engine: 'claude',
      id: 'default',
      name: 'This Mac',
      thisMac: true,
      signedIn: true,
      out: false,
      next: true,
      windows: [],
      learned: [],
    },
  ],
  local: [],
  spare: [],
  backlog: [],
  agents: [],
  routines: [],
  totals: {
    accounts: 1,
    signedIn: 1,
    engines: [{ engine: 'claude', accounts: 1, read: 0, room: 0 }],
    read: 0,
    room: 0,
    windows: [],
  },
  now,
};

const DESKTOP_SETTINGS = {
  supported: true,
  menuBarIcon: true,
  quickEntry: true,
  shortcut: 'Alt+Space',
  shortcutLabel: '⌥Space',
};

/** The plan as `agents_quota` returns it: This Mac's windows, as in FULL_INVENTORY. */
const CHAT_QUOTA = [
  {
    engine: 'claude',
    windows: FULL_INVENTORY.accounts[0].windows,
  },
];

/** Finance with its context as Claude Code reported it. */
const TEAM_WITH_CONTEXT = TEAM.map((a) =>
  a.id === 'finance'
    ? { ...a, context: { used: 128_400, window: 200_000, at: now - 3 * 60_000 } }
    : a
);

const DISK_FLOOR = {
  freeBytes: 1_800_000_000,
  level: 'floor',
  lowBytes: 15_000_000_000,
  floorBytes: 5_000_000_000,
  homes: [
    {
      agentId: 'devops',
      name: 'Security & DevOps',
      bytes: 39_400_000_000,
      regenerableBytes: 37_200_000_000,
    },
    { agentId: 'research', name: 'Research', bytes: 1_400_000_000, regenerableBytes: 0 },
  ],
};

/**
 * The accounts list (`agents_accounts`) an inventory implies: Settings →
 * Accounts & usage is the Usage view's panel, which reads both.
 */
function accountsOf(inv: { accounts: Record<string, unknown>[] }) {
  return inv.accounts.map((a) => ({
    id: a.id,
    engine: a.engine,
    name: a.name,
    named: a.name !== 'This Mac',
    thisMac: a.thisMac,
    signedIn: a.signedIn,
    out: a.out,
    ...(a.plan ? { plan: a.plan } : {}),
  }));
}

/** What the Usage panel reads, for an inventory. */
export const usageCommands = (inv: { accounts: Record<string, unknown>[] }) => ({
  agents_usage_overview: inv,
  agents_accounts: accountsOf(inv),
  agents_crossover: { claude: 'ask', codex: 'ask', away: [] },
});

export const agentsUsageScenarios: Scenario[] = [
  {
    id: 'agents-chat-usage',
    title: 'Agents — the chat header’s usage ring and its popover',
    looksRightWhen:
      'Finance’s chat. In the header, left of the clock, a small ring about two-thirds filled (62% of the 5-hour window left), in the muted ink, not the accent. Its popover: “Usage”; Context — “Finance’s conversation” 64% used with a bar and “128.4K of 200K tokens”; Your accounts — the stack’s one line in ink, the segmented meter with each account named under its segment and what it has left (“62% left”, “No reading”, never a used figure, never “This Mac” as a name), the next reset, and a full-width “Usage and accounts” button. Readable in both themes.',
    openSelector: AGENTS_TAB,
    requires: '.agent-usage .usage-stack__labels',
    clipSelector: '.agent-usage',
    steps: [{ click: '[data-agent-id="finance"]' }, { click: '.agent-usage-ring' }],
    commands: {
      agents_overview: overview(TEAM_WITH_CONTEXT),
      agents_messages: messagesFor,
      agents_quota: CHAT_QUOTA,
      ...usageCommands(FULL_INVENTORY),
    },
  },
  {
    id: 'agents-chat-usage-ring',
    title: 'Agents — the usage ring in the chat header',
    looksRightWhen:
      'Finance’s chat header: the ring sits with the other header controls (left of the schedule clock and the ⋯ menu), the same size as their icons, about a third filled. Nothing else in the header moved.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__actions .agent-usage-ring',
    clipSelector: '.agent-chat__header',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(TEAM_WITH_CONTEXT),
      agents_messages: messagesFor,
      agents_quota: CHAT_QUOTA,
      agents_usage_overview: FULL_INVENTORY,
    },
  },
  {
    id: 'settings-agents-usage',
    title: 'Settings — Agents → Usage: modes, what you have, spare capacity',
    looksRightWhen:
      'Settings → Accounts & usage is the Usage view’s own panel, not a second sheet: the hero (“Your accounts, together”, the stack’s line, a segmented meter with each account named and “N% left” under it, the next reset), “Get the most from your limits” with the three-way mode control, then each engine’s accounts as key cards with grips (drag, or the grip with the keyboard; no ↑/↓ buttons), every limit said as “N% left”, pace lines in secondary ink (never amber). This Mac’s own sign-in is named by its email, plan or engine, never “This Mac”. Then adding an account, the crossover choice, the spare-capacity list with its two items, the engines’ average-turn estimates and other compute. Nothing accent-coloured.',
    // Settings → Accounts & usage: the Usage view's panel, mounted in Settings.
    command: 'settings.page.accounts',
    requires: '.usage-panel .usage-key',
    clipSelector: '.settings-window',
    viewport: { width: 1280, height: 2800 },
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      ...usageCommands(FULL_INVENTORY),
    },
  },
  {
    id: 'settings-agents-usage-runout',
    title: 'Settings — Agents → Usage: Claude runs out on every account at this pace',
    looksRightWhen:
      'The same panel with a run-out estimate: the hero headline “Runs out …” in ink, not amber, with “Estimate from 13 readings across 2 accounts. An estimate, not a reading.” under it; each Claude key’s 5-hour bar amber only where it is nearly out, its pace line secondary ink with what it rests on.',
    // Settings → Accounts & usage: the Usage view's panel, mounted in Settings.
    command: 'settings.page.accounts',
    requires: '.usage-panel .usage-key',
    clipSelector: '.settings-window',
    viewport: { width: 1280, height: 2800 },
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      ...usageCommands(RUNOUT_INVENTORY),
    },
  },
  {
    id: 'settings-agents-usage-two-claude',
    title: 'Settings — Agents → Usage: two Claude accounts read, Codex not signed in',
    looksRightWhen:
      'The same panel: Claude keys in order, the out one with a neutral “Out of usage until …” pill, Codex’s unsigned sign-in with “Not signed in” and its fix line. No account is named “This Mac”.',
    // Settings → Accounts & usage: the Usage view's panel, mounted in Settings.
    command: 'settings.page.accounts',
    requires: '.usage-panel .usage-key',
    clipSelector: '.settings-window',
    viewport: { width: 1280, height: 2800 },
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      ...usageCommands(TWO_CLAUDE_INVENTORY),
    },
  },
  {
    id: 'settings-agents-usage-one-read',
    title: 'Settings — Agents → Usage: one account read, one that can’t be',
    looksRightWhen:
      'The same panel: one key read with its 5-hour and Weekly “N% left” bars and one pace line in secondary ink under the Weekly bar; Personal says it has no reading yet; never a made-up figure.',
    // Settings → Accounts & usage: the Usage view's panel, mounted in Settings.
    command: 'settings.page.accounts',
    requires: '.usage-panel .usage-key',
    clipSelector: '.settings-window',
    viewport: { width: 1280, height: 2800 },
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      ...usageCommands(ONE_READ_INVENTORY),
    },
  },
  {
    id: 'settings-agents-usage-empty',
    title: 'Settings — Agents → Usage with no reading and no history',
    looksRightWhen:
      'The same panel with nothing read: “No usage reading yet”, an empty dashed segment, a key saying it has no reading yet; no bars, no estimate lines, never a made-up figure. The spare-capacity list shows only its sentence and the field.',
    // Settings → Accounts & usage: the Usage view's panel, mounted in Settings.
    command: 'settings.page.accounts',
    requires: '.usage-panel [data-testid="usage-hero"]',
    clipSelector: '.settings-window',
    viewport: { width: 1280, height: 2800 },
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      ...usageCommands(EMPTY_INVENTORY),
    },
  },
  {
    id: 'agents-team-spare-capacity',
    title: 'What’s in flight — a reset near with capacity left',
    looksRightWhen:
      'At the foot of What’s in flight, under any plan-usage line, one quiet muted line: “Claude 5-hour limit resets <time> · 62% left”. Hovering says when it was reported (never “On This Mac”), and that the Chief will use it on the spare-capacity list (1 waiting). Muted, never amber or accent.',
    command: 'agents.team',
    requires: '.agents-team__column > .agents-usage-spare',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_usage_overview: FULL_INVENTORY,
    },
  },
  {
    id: 'settings-agents-disk-floor',
    title: 'Settings — Agents → Disk space: nearly full, one agent home at 39 GB',
    looksRightWhen:
      'A “Disk space” group. “On this Mac”: “This Mac has 1.8 GB free. Agents ask before installing packages or cloning.” Then Security & DevOps: “Its folder uses 39 GB, 37 GB of it in dependency and build folders.” with a secondary “Free up space”; Research: “Its folder uses 1.4 GB.” with no button (nothing regenerable). Neutral buttons, nothing accent-coloured, readable in both themes.',
    command: 'agents.disk',
    requires: '.agents-disk [data-disk-home]',
    clipSelector: '.agents-disk',
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_disk_overview: DISK_FLOOR,
    },
  },
];
