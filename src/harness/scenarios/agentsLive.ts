/**
 * What an agent is doing right now (`agents::work` live, `AgentLiveStep`):
 * the step it's on in plain words with a live timer, "Show output", the
 * quiet hint a slow tool gets, "No progress for 5 min" with Check on it, a
 * finished step's time and test counts, and the list rows that say the step
 * instead of "Working…". Fictional team and repos.
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview } from './agents';
import { browserFrame } from '../fixtures/browserFrame';
import { rememberLastFrame } from '../../lib/agentsOwnBrowser';

const SEC = 1000;
const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;

/** Cypress, 5 min 32 s in, through Codex (which streams what it prints). */
const CYPRESS = {
  kind: 'command',
  label: 'Running the Cypress tests',
  startedAt: now - 332 * SEC,
  slow: 'tests',
  streams: true,
  busy: true,
  canStop: true,
  output: [
    '  Running:  pages/pricing.cy.ts                                   (7 of 12)',
    '',
    '  Pricing page',
    '    ✓ shows three plans (812ms)',
    '    ✓ stacks the cards below 640px (1204ms)',
    '    ✓ keeps the “Most popular” badge off the price (433ms)',
    '    ✓ links each plan to checkout (2051ms)',
    '    1) applies the annual discount',
  ].filter(Boolean),
};

const step = (s: number, kind: string, label: string, extra = {}) => ({
  at: now - 6 * MIN + s * SEC,
  kind,
  label,
  ...extra,
});

const LIVE_TURN = {
  startedAt: now - 6 * MIN,
  stepCount: 5,
  fileCount: 1,
  doing: CYPRESS.label,
  current: CYPRESS,
  lastSignAt: now - 3 * SEC,
  steps: [
    step(4, 'read', 'Read cypress.config.ts'),
    step(11, 'command', 'Got the latest changes', { endedAt: now - 6 * MIN + 13 * SEC }),
    step(16, 'command', 'Installed packages', {
      endedAt: now - 6 * MIN + 24 * SEC,
    }),
    step(25, 'command', 'Looked up PR #248 on GitHub', { endedAt: now - 6 * MIN + 27 * SEC }),
    step(28, 'command', 'Ran the Cypress tests'),
  ],
};

/** Finance: a build that stopped making progress five minutes ago. */
const STALLED_TURN = {
  startedAt: now - 9 * MIN,
  stepCount: 2,
  fileCount: 0,
  doing: 'Building the project',
  current: {
    kind: 'command',
    label: 'Building the project',
    startedAt: now - 8 * MIN,
    slow: 'build',
    streams: false,
    busy: false,
    canStop: true,
  },
  lastSignAt: now - 4 * SEC,
  quietSince: now - 5 * MIN - 10 * SEC,
  steps: [
    { at: now - 9 * MIN + 5 * SEC, kind: 'read', label: 'Read package.json' },
    { at: now - 8 * MIN, kind: 'command', label: 'Built the project' },
  ],
};

/** Yesterday's run, finished: its time and what the runner said it came to. */
const FINISHED_TURN = {
  startedAt: now - 70 * MIN,
  endedAt: now - 63 * MIN,
  stepCount: 3,
  fileCount: 0,
  steps: [
    {
      at: now - 70 * MIN + 2 * SEC,
      kind: 'command',
      label: 'Pulled the latest changes',
      endedAt: now - 70 * MIN + 4 * SEC,
    },
    {
      at: now - 70 * MIN + 10 * SEC,
      kind: 'command',
      label: 'Tried to run the Cypress tests',
      outcome: 'failed',
      endedAt: now - 70 * MIN + 382 * SEC,
      summary: '42 passed, 3 failed',
      output: [
        '  (Run Finished)',
        '       Spec                          Tests  Passing  Failing',
        '  ✔  flows/checkout.cy.ts            12       12        -',
        '  ✖  pages/pricing.cy.ts             18       15        3',
        '  ✔  pages/home.cy.ts                15       15        -',
        '  ✖  3 of 12 failed (25%)   06:12   45   42   3   -   -',
      ],
    },
    {
      at: now - 70 * MIN + 390 * SEC,
      kind: 'command',
      label: 'Commented on PR #248 on GitHub',
      endedAt: now - 70 * MIN + 392 * SEC,
    },
  ],
};

const ACME_CHAT = [
  msg('user', 'Run the e2e suite against PR #248 and tell me what breaks.', 71, {
    agentId: 'acme',
  }),
  {
    ...msg(
      'agent',
      'Three pricing tests fail on PR #248: the annual discount isn’t applied. I left a comment on the PR with the failing specs.',
      63,
      { agentId: 'acme' }
    ),
    id: 'live-finished',
    work: FINISHED_TURN,
  },
  msg('user', 'I pushed a fix. Run them again.', 6, { agentId: 'acme' }),
];

/** Lead Gen, on a supplier directory in its own browser. */
const BROWSER_CALL = {
  kind: 'web',
  label: 'Using its own browser · northwind-supply.com',
  startedAt: now - 14 * SEC,
  streams: false,
  busy: false,
  canStop: false,
};

const BROWSER_TURN = {
  startedAt: now - 3 * MIN,
  stepCount: 7,
  fileCount: 0,
  doing: BROWSER_CALL.label,
  current: BROWSER_CALL,
  lastSignAt: now - 2 * SEC,
  ownBrowser: true,
  steps: [
    { at: now - 3 * MIN + 3 * SEC, kind: 'read', label: 'Read leads.csv' },
    {
      at: now - 3 * MIN + 9 * SEC,
      kind: 'web',
      label: 'Used its own browser · northwind-supply.com',
    },
    { at: now - 2 * MIN, kind: 'web', label: 'Used its own browser · northwind-supply.com' },
    {
      at: now - 2 * MIN + 20 * SEC,
      kind: 'screenshot',
      label: 'Took a screenshot of its own browser',
    },
    { at: now - 90 * SEC, kind: 'web', label: 'Used its own browser · northwind-supply.com' },
    { at: now - 60 * SEC, kind: 'web', label: 'Used its own browser · northwind-supply.com' },
    { at: now - 30 * SEC, kind: 'web', label: 'Used its own browser · northwind-supply.com' },
  ],
};

const LEADGEN_CHAT = [
  msg(
    'user',
    'Find ten packaging suppliers on Northwind’s directory that ship to Canada, with a contact for each.',
    3,
    { agentId: 'leadgen' }
  ),
];

/** The same job, finished: its reply keeps the last picture of the page. */
const BROWSER_DONE = {
  ...BROWSER_TURN,
  endedAt: now - 1 * MIN,
  current: undefined,
  doing: undefined,
  ownBrowser: undefined,
};

const LEADGEN_DONE_CHAT = [
  ...LEADGEN_CHAT,
  {
    ...msg(
      'agent',
      'Found ten that ship to Canada. Boreal Box Co. and Harbour Mailers have the lowest minimum orders; the full list with a contact for each is in suppliers.csv.',
      1,
      { agentId: 'leadgen' }
    ),
    id: 'browser-finished',
    work: BROWSER_DONE,
  },
];

const FINANCE_CHAT = [
  msg('user', 'Rebuild the invoice dashboard with the new totals.', 9, { agentId: 'finance' }),
];

const team = () =>
  overview(
    TEAM.map((a) => {
      if (a.id === 'acme') {
        return {
          ...a,
          project: ACME_PATH,
          engine: 'codex' as const,
          status: {
            state: 'working',
            activity: CYPRESS.label,
            since: LIVE_TURN.startedAt,
            work: LIVE_TURN,
          },
        };
      }
      if (a.id === 'leadgen') {
        return {
          ...a,
          status: {
            state: 'working',
            activity: BROWSER_CALL.label,
            since: BROWSER_TURN.startedAt,
            work: BROWSER_TURN,
          },
        };
      }
      if (a.id === 'finance') {
        return {
          ...a,
          status: {
            state: 'working',
            activity: 'Building the project',
            since: STALLED_TURN.startedAt,
            work: STALLED_TURN,
          },
        };
      }
      return a;
    })
  );

const commands = {
  agents_overview: team(),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme'
      ? ACME_CHAT
      : args.agentId === 'leadgen'
        ? LEADGEN_CHAT
        : args.agentId === 'finance'
          ? FINANCE_CHAT
          : messagesFor(args),
  agents_check_on: () =>
    'Its command is still running but isn’t using the CPU, and its last progress was 5 min ago. It may be waiting on something, like a server or the network.',
  agents_stop_step: () => 'Stopped that step. It carries on from there.',
  agents_show_agent_browser: () => null,
  // The first ask gets a picture; later ones nothing new (the hook then waits).
  agents_browser_live_frame: (args: Record<string, unknown>) =>
    args.after ? null : browserFrame(),
  agents_browser_live_stop: () => null,
};

const doneCommands = {
  ...commands,
  agents_overview: overview(TEAM),
  agents_messages: (args: Record<string, unknown>) => {
    if (args.agentId !== 'leadgen') return messagesFor(args);
    // What this session saw while it worked (kept in memory, as the live card does).
    rememberLastFrame('leadgen', BROWSER_TURN.startedAt, browserFrame());
    return LEADGEN_DONE_CHAT;
  },
};

const openAcme = { click: '[data-agent-id="acme"]' };
const openFinance = { click: '[data-agent-id="finance"]' };
const openLeadgen = { click: '[data-agent-id="leadgen"]' };

export const agentsLiveScenarios: Scenario[] = [
  {
    id: 'agents-live-step',
    title: 'Agents — the step it’s on right now, with its timer',
    looksRightWhen:
      'Acme Site’s chat. At the bottom, the working line: three dots, then “Running the Cypress tests · 5:32” (the time ticks), beside it a muted “5 steps” toggle and the ⋯. Under it, two quiet muted lines: “Test runs usually take a few minutes” and a chevron “Show output”. No accent colour. In the sidebar Acme Site’s row reads “Running the Cypress tests · 5m” (not “Working…”), its badge has a soft ring in its green.',
    requires: '.agent-live__timer',
    openSelector: AGENTS_TAB,
    steps: [openAcme],
    commands,
  },
  {
    id: 'agents-live-output',
    title: 'Agents — Show output on the running step',
    looksRightWhen:
      'As agents-live-step, with “Show output” open (chevron down): a recessed monospace box under it with the Cypress lines so far (“Running: pages/pricing.cy.ts (7 of 12)”, four ✓ lines, “1) applies the annual discount”). Clicking the step’s words also shows a muted “Last activity 3s ago · using the CPU” above the hint.',
    requires: '.agent-live__output',
    openSelector: AGENTS_TAB,
    steps: [openAcme, { click: '.agent-live__step' }, { click: '.agent-live__toggle' }],
    commands,
  },
  {
    id: 'agents-live-browser',
    title: 'Agents — an agent working in its own browser',
    looksRightWhen:
      'Lead Gen’s chat. Under the working bubble (“Using its own browser · northwind-supply.com · 0:14”, “7 steps”), a rounded card the bubble’s left edge: a header with a globe, “northwind-supply.com” and a breathing blue dot “Live”, then a 16:10 picture of the supplier directory’s top. No orphaned text button. Hovering shows a “Watch” pill in the corner.',
    requires: '.agent-browser-card .agent-browser-card__screen img',
    openSelector: AGENTS_TAB,
    steps: [openLeadgen],
    commands,
  },
  {
    id: 'agents-live-browser-pane',
    title: 'Agents — its browser, live, beside the chat',
    looksRightWhen:
      'The pane beside the chat: header “Packaging suppliers · Northwind Supply” over “Lead Gen’s browser”, “Open in Chrome” (quiet, with an arrow) and ×. A read-only address row with a lock and the full URL, “● Live” at its end. The page picture large, rounded, on the app surface, and under it “View only: Lead Gen won’t see clicks here.” In the chat, the card dims and says “Open beside”.',
    requires: '.agent-browser-pane .agent-browser-pane__screen img',
    openSelector: AGENTS_TAB,
    steps: [openLeadgen, { click: '.agent-browser-card' }],
    commands,
  },
  {
    id: 'agents-live-browser-still',
    title: 'Agents — a finished turn keeps the last picture of its page',
    looksRightWhen:
      'Lead Gen’s reply with “What it did” open: above the steps, a smaller still of the directory page with “northwind-supply.com” and “Last seen” (no dot), in the steps’ column.',
    requires: '.agent-browser-card--still img',
    openSelector: AGENTS_TAB,
    steps: [openLeadgen, { click: '[data-message-ids="browser-finished"] .agent-work__toggle' }],
    commands: doneCommands,
  },
  {
    id: 'agents-live-stalled',
    title: 'Agents — no progress for 5 min, checked on',
    looksRightWhen:
      'Finance’s chat. The working line reads, muted, “No progress for 5 min · Building the project” followed by two neutral text actions “Check on it” and “Stop” (not accent, not red). Under it “Last activity 4s ago · not using the CPU”, “Builds usually take a few minutes”, “Show output”, and — after Check on it — the line “Its command is still running but isn’t using the CPU, and its last progress was 5 min ago…” in secondary text. The sidebar’s Finance row says “No progress for 5 min”.',
    requires: '.agent-live__said',
    openSelector: AGENTS_TAB,
    steps: [openFinance, { click: '.agent-live__quiet .agent-live__action' }],
    commands,
  },
  {
    id: 'agents-live-finished',
    title: 'Agents — a finished step keeps its time and its counts',
    looksRightWhen:
      'Acme Site’s earlier reply with its timeline open: “Pulled the latest changes”, then “Tried to run the Cypress tests · 6m 12s · 42 passed, 3 failed” (quieter: it failed) with its own “Show output” open showing the Cypress run table in a recessed monospace box, then “Commented on PR #248 on GitHub”. Short steps show no duration.',
    requires: '.agent-work[data-open] .agent-work__output .agent-live__output',
    openSelector: AGENTS_TAB,
    steps: [
      openAcme,
      { click: '[data-message-ids="live-finished"] .agent-work__toggle' },
      { click: '[data-message-ids="live-finished"] .agent-live__toggle' },
    ],
    commands,
  },
  {
    id: 'agents-live-in-flight',
    title: 'Agents — What’s in flight says what each one is on',
    looksRightWhen:
      'What’s in flight. Under “Working now”, Acme Site reads “Running the Cypress tests · 5m” and Finance “No progress for 5 min”, each badge with a soft ring in its colour; no “Working…” anywhere.',
    requires: '.agents-team__row .agent-avatar--working',
    openSelector: AGENTS_TAB,
    steps: [{ click: '.agents-list__needs-you' }],
    commands,
  },
];
