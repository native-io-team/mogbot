/**
 * Under the hood, desk only (`lib/agentDesk.ts`): which account and model ran
 * a turn, a step's exact command, what a turn was told, every routine in one
 * list with Pause all, the agent list grouped by project, and A / D on a
 * focused approval card. Built on the Agents team fixture (`./agents`) and
 * the "What it did" fixture (`./agentsWork`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview } from './agents';
import { workCommands } from './agentsWork';

const SEC = 1000;
const at = (startMin: number, s: number) => now - startMin * MIN + s * SEC;

/** A turn whose engine said its model, with one command kept exactly. */
const RAN_TURN = {
  startedAt: at(30, 0),
  endedAt: at(30, 6 * 60 + 4),
  stepCount: 4,
  fileCount: 1,
  files: ['pricing.css'],
  engine: 'Claude Code',
  account: 'sam@acme.com',
  model: 'claude-opus-4-6',
  steps: [
    { at: at(30, 14), kind: 'read', label: 'Read PricingTable.tsx', hasExact: true },
    { at: at(30, 98), kind: 'edit', label: 'Edited pricing.css', hasExact: true },
    { at: at(30, 214), kind: 'command', label: 'Ran npm test', hasExact: true },
    { at: at(30, 360), kind: 'command', label: 'Ran npm run lint', hasExact: true },
  ],
};

const RAN_CHAT = [
  msg('user', 'The pricing cards overlap on mobile. Can you fix it?', 31, { agentId: 'acme' }),
  {
    ...msg('agent', 'Fixed: the cards stack below 640px. Tests and lint pass.', 24, {
      agentId: 'acme',
    }),
    id: 'desk-pricing',
    work: RAN_TURN,
  },
];

const BRIEFING = {
  at: at(30, 0),
  sections: [
    {
      title: 'Who it is',
      body: 'You are Acme Site, one of the user’s agents. Your role: Owns the Acme marketing site rebuild.',
    },
    { title: 'How you talk', body: 'Plainly, in short sentences. Lead with the answer.' },
    {
      title: 'How much to do on your own',
      body: 'Steady: reads, local edits and builds go ahead; anything that sends, publishes or spends asks first.',
    },
    {
      title: 'Secrets',
      body: '### Secrets you have\n\nIn your environment this turn:\n\n- STRIPE_KEY ([secret:STRIPE_KEY])',
    },
  ],
  instructions:
    '# Acme Site\n\n## Memory\n\n- Deploys go through Sam.\n- The brand blue is #1d4ed8.',
};

const deskCommands = {
  ...workCommands(false),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme' ? RAN_CHAT : messagesFor(args),
  agents_turn_work: () => RAN_TURN,
  agents_step_exact: (args: Record<string, unknown>) =>
    args.step === 2 ? 'npm test -- --watch=false' : 'npm run lint -- --max-warnings=0',
  agents_turn_briefing: () => BRIEFING,
};

const openAcme = { click: '[data-agent-id="acme"]' };
const openSteps = { click: '[data-message-ids="desk-pricing"] .agent-work__toggle' };

/** A focused approval card (leadgen's, in the team fixture). */
const approvalCommands = {
  agents_overview: overview(),
  agents_messages: messagesFor,
};

const routinesCommands = {
  agents_overview: overview(
    TEAM.map((a) =>
      a.id === 'leadgen'
        ? {
            ...a,
            checkIns: [
              {
                id: 'lg1',
                note: 'Find ten new agencies hiring designers and add them to the sheet.',
                repeat: { kind: 'days', days: [1, 3, 5], hour: 8, minute: 30 },
                nextAt: now + 20 * 60 * MIN,
                createdAt: now - 14 * 24 * 60 * MIN,
                paused: false,
                runs: [{ at: now - 2 * 24 * 60 * MIN, outcome: 'ran', attempt: 1 }],
              },
              {
                id: 'lg2',
                note: 'Follow up on anyone who opened the pitch but didn’t reply.',
                repeat: { kind: 'every', minutes: 240 },
                nextAt: now + 3 * 60 * MIN,
                createdAt: now - 3 * 24 * 60 * MIN,
                paused: true,
                runs: [{ at: now - 26 * 60 * MIN, outcome: 'failed', attempt: 2 }],
              },
            ],
          }
        : a
    )
  ),
  agents_messages: messagesFor,
  agents_routines_pause_all: () => 2,
  agents_routines_resume_all: () => 0,
};

const groupedCommands = {
  agents_overview: overview(
    TEAM.map((a) =>
      a.id === 'acme'
        ? { ...a, project: `${HARNESS_ROOT}/acme-marketing` }
        : a.id === 'leadgen'
          ? { ...a, project: `${HARNESS_ROOT}/northwind-crm` }
          : a
    )
  ),
  agents_messages: messagesFor,
};

export const agentsDeskScenarios: Scenario[] = [
  {
    id: 'agents-desk-ran-on',
    title: 'Agents — which account and model ran a turn, and a step’s exact command',
    looksRightWhen:
      'Acme Site’s chat. Beside the folded “Worked 6 min · 4 steps · edited 1 file” line, in quieter muted text: “Claude Code · sam@acme.com · claude-opus-4-6”. The line is open: four steps, each with a quiet disclosure under its label (“Show details” under the read and the edit, “Show exact command” under the two commands); under “Ran npm test” it is open, showing “npm test -- --watch=false” in a small recessed monospace box with Copy under it. At the end, a quiet “What it was told” link.',
    requires: '.agent-work__exact-text',
    openSelector: AGENTS_TAB,
    steps: [
      openAcme,
      openSteps,
      {
        click:
          '[data-message-ids="desk-pricing"] .agent-work__step:nth-child(3) .agent-work__exact button',
      },
    ],
    commands: deskCommands,
  },
  {
    id: 'agents-desk-briefing',
    title: 'Agents — what a turn was told, read-only',
    looksRightWhen:
      'A dialog titled “What it was told” with Copy all and a close button in its header. A muted line says when it was given, that the app wrote it on top of the agent’s own instructions, that it is read-only and secrets are blanked. Then folding sections: “Who it is” open with its text in a recessed box in the reading face, the body inset on the header’s edges; “How you talk”, “How much to do on your own”, “Secrets” (whose text shows [secret:STRIPE_KEY], never a value) and “Its instructions and memory” folded. Nothing is editable.',
    requires: '.agent-briefing__section',
    openSelector: AGENTS_TAB,
    steps: [openAcme, openSteps, { click: '.agent-work .text-button', text: 'What it was told' }],
    commands: deskCommands,
  },
  {
    id: 'agents-desk-routines',
    title: 'Agents — every routine in one list, with Pause all asking first',
    looksRightWhen:
      'The main pane is “Routines”. A muted count (“… on · 1 paused, across … agents”), then the confirm panel: “Pause all … running routines? Nothing runs until you resume them.” with Cancel and a neutral (not accent) Pause all at the card’s trailing edge, 8px apart. Below, one row per routine on hairlines: the agent’s small key, its name as a link and the routine’s note cut to one line, then a muted line in words (“Every weekday at 9:00 AM · next tomorrow at 9:00 AM”, “Every 4 hours · paused · last: didn’t run after 2 tries”: lower case after the first word) and an on/off switch on the right; the paused one is off and quieter. The sidebar’s Routines row wears the selected fill.',
    requires: '.agents-routines__confirm',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '.agents-list__routines' },
      { click: '.agents-routines__bulk button', text: 'Pause all' },
    ],
    commands: routinesCommands,
  },
  {
    id: 'agents-desk-routines-compact',
    title: 'Agents — Routines in a compact window (no sidebar)',
    looksRightWhen:
      'No sidebar below 750px, so the header carries the way out: the folder | agents mode toggle at the leading edge, then “Routines” with its putty key as the agent switcher (chevron; opening it lists the agents and Home). The count and the rows follow as at full width.',
    viewport: { width: 700, height: 800 },
    command: 'agents.routines',
    requires: '.agents-routines .agent-chat__switcher',
    commands: routinesCommands,
  },
  {
    id: 'agents-desk-groups',
    title: 'Agents — the agent list grouped by project',
    looksRightWhen:
      'The sidebar: the Chief of Staff first and ungrouped, then folding group headers in the Hidden toggle’s quiet style, each with a chevron turned down and a count on the right: “acme-marketing 1” over Acme Site, “northwind-crm 1” over Lead Gen, then “Not in a project” over the rest. Rows look exactly as they do ungrouped.',
    requires: '.agents-list__group-toggle',
    openSelector: AGENTS_TAB,
    storage: {
      'shipstudio.agents.groups': JSON.stringify({
        mode: 'project',
        groups: [],
        assign: {},
        collapsed: [],
      }),
    },
    commands: groupedCommands,
  },
  {
    id: 'agents-desk-approval-keys',
    title: 'Agents — A and D on a focused approval card',
    looksRightWhen:
      'Lead Gen’s Allow / Deny card has focus (a neutral focus ring round the card): small key hints sit inside the buttons, “Deny D” and “Allow A”, in a muted outlined key style. Nothing else on screen shows a key hint.',
    requires: '.agent-chat__row--card[data-keys]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }, { focus: '.agent-chat__row--card[data-keys]' }],
    commands: approvalCommands,
  },
];
