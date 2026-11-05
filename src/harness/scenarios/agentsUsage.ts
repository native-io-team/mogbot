/**
 * Usage awareness: Settings → Agents → Usage and What's in flight's line for a
 * reset near with capacity left. Shapes are `agents::inventory::Inventory`
 * as serde writes it (camelCase, absent optionals left out).
 */

import type { Scenario } from '../types';
import { messagesFor, now, overview } from './agents';

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
  now,
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
  now,
};

const DESKTOP_SETTINGS = {
  supported: true,
  menuBarIcon: true,
  quickEntry: true,
  shortcut: 'Alt+Space',
  shortcutLabel: '⌥Space',
};

export const agentsUsageScenarios: Scenario[] = [
  {
    id: 'settings-agents-usage',
    title: 'Settings — Agents → Usage: modes, what you have, spare capacity',
    looksRightWhen:
      'A “Usage” group. “How agents use your limits” with a three-way control (Normal | Save my limits | Use it all before reset), the last pressed, neutral not accent, and one muted line under it saying Allow cards still apply. “What you have”: Claude Code’s list — This Mac “5-hour 38% · resets <time> · Weekly 61% · resets <weekday>” and “Next turns run here”; Work in amber “Out of usage until …”; Personal “No reading yet”; then a muted “About 48k tokens a turn · estimate from 212 past runs”. Codex’s list: ChatGPT Plus “Primary 92% …” in amber, tagged “Plus plan · Next turns run here”, and no estimate line. A muted line “Claude 5-hour limit resets <time> · 62% unused”. “Other compute on this Mac”: Opencode installed; Ollama running with two models. “Spare-capacity list”: two lines (one “Added by you · for Research”, one “Added by Finance · Started”), each with a remove ×, and a field with a secondary Add. Readable in both themes; nothing is accent-coloured.',
    command: 'agents.usage',
    requires: '.agents-usage .agents-usage__line',
    clipSelector: '.agents-usage',
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_usage_overview: FULL_INVENTORY,
    },
  },
  {
    id: 'settings-agents-usage-empty',
    title: 'Settings — Agents → Usage with no reading and no history',
    looksRightWhen:
      'The Usage group with Normal pressed and its line (“Agents never slow down for limits…”). “What you have” lists only Claude Code (Codex isn’t installed): This Mac “No reading yet”, “Next turns run here”, and no estimate line at all — never a made-up figure. No “Other compute” group. The spare-capacity list shows only its sentence and the field.',
    command: 'agents.usage',
    requires: '.agents-usage .agents-usage__line',
    clipSelector: '.agents-usage',
    commands: {
      agents_overview: overview(),
      agents_desktop_settings: DESKTOP_SETTINGS,
      agents_usage_overview: EMPTY_INVENTORY,
    },
  },
  {
    id: 'agents-team-spare-capacity',
    title: 'What’s in flight — a reset near with capacity left',
    looksRightWhen:
      'At the foot of What’s in flight, under any plan-usage line, one quiet muted line: “Claude 5-hour limit resets <time> · 62% unused”. Hovering says it’s on This Mac as reported at a time, and that the Chief will use it on the spare-capacity list (1 waiting). Muted, never amber or accent.',
    command: 'agents.team',
    requires: '.agents-team__column > .agents-usage-spare',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_usage_overview: FULL_INVENTORY,
    },
  },
];
