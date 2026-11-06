/**
 * What a turn did (`agents::work`): the folded line under a reply, the steps
 * it opens into (with a screenshot), and the live timeline above the working
 * line. Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;
const SEC = 1000;

/** A step `s` seconds into a turn that started `startMin` minutes ago. */
const at = (startMin: number, s: number) => now - startMin * MIN + s * SEC;

const step = (startMin: number, s: number, kind: string, label: string, extra = {}) => ({
  at: at(startMin, s),
  kind,
  label,
  ...extra,
});

const SHOT = {
  name: 'acme-marketing-phone.jpg',
  path: 'attachments/m-att1/Pricing on mobile.jpg',
  mime: 'image/jpeg',
  size: 31_020,
};

/**
 * Fix the pricing cards: 30 minutes ago, for 6 minutes. Every label is one
 * `agents::work` can produce: a command is its program and subcommand, a
 * page its host, a connector a verb and the service. One edit failed (it
 * doesn't count toward the files) and one command was declined.
 */
const PRICING_TURN = {
  startedAt: at(30, 0),
  endedAt: at(30, 6 * 60 + 4),
  stepCount: 14,
  fileCount: 2,
  files: ['PricingTable.tsx', 'pricing.css'],
  steps: [
    step(30, 3, 'plan', 'Updated its plan'),
    step(30, 9, 'search', 'Searched for “PricingTable”'),
    step(30, 14, 'read', 'Read PricingTable.tsx'),
    step(30, 22, 'read', 'Read pricing.css'),
    step(30, 51, 'web', 'Searched the web for “css grid auto-fit minmax cards”'),
    step(30, 98, 'edit', 'Edited pricing.css'),
    step(30, 120, 'edit', 'Tried to edit PricingTable.tsx', { outcome: 'failed' }),
    step(30, 131, 'edit', 'Edited PricingTable.tsx'),
    step(30, 150, 'approval', 'You declined: Run a command', { outcome: 'declined' }),
    step(30, 151, 'command', 'Asked to run rm — you declined', { outcome: 'declined' }),
    step(30, 160, 'approval', 'You allowed: Run a command'),
    step(30, 214, 'command', 'Ran npm test'),
    step(30, 290, 'screenshot', 'Took a screenshot of acme-marketing', { image: SHOT }),
    step(30, 331, 'message', 'Messaged Chief of Staff'),
    step(30, 360, 'command', 'Ran npm run lint'),
  ],
};

/** The footer year: a quick one. */
const FOOTER_TURN = {
  startedAt: at(6, 0),
  endedAt: at(6, 41),
  stepCount: 3,
  fileCount: 1,
  files: ['Footer.tsx'],
  steps: [
    step(6, 4, 'search', 'Searched for “2024”'),
    step(6, 11, 'read', 'Read Footer.tsx'),
    step(6, 30, 'edit', 'Edited Footer.tsx'),
  ],
};

const ACME_CHAT = [
  msg('user', 'The pricing cards overlap on mobile. Can you fix it and show me?', 31, {
    agentId: 'acme',
  }),
  {
    ...msg(
      'agent',
      'Fixed. The cards now stack below 640px and the “Most popular” badge no longer covers the price. The tests and lint pass; the screenshot is from the phone preview.',
      24,
      { agentId: 'acme' }
    ),
    id: 'work-pricing',
    work: PRICING_TURN,
  },
  msg('user', 'And the footer year is still 2024.', 7, { agentId: 'acme' }),
  {
    ...msg('agent', 'Updated to 2026.', 5, { agentId: 'acme' }),
    id: 'work-footer',
    work: FOOTER_TURN,
  },
];

/**
 * Acme Site, eight steps into checking the footer links; its npm test is
 * still running, so the working line is that step. Live, the status carries
 * counts and the newest steps, never the file names.
 */
const LIVE_TURN = {
  startedAt: at(3, 0),
  stepCount: 8,
  fileCount: 1,
  doing: 'Running npm test',
  steps: [
    step(3, 2, 'read', 'Read Footer.tsx'),
    step(3, 9, 'search', 'Searched for “href=”'),
    step(3, 21, 'web', 'Browsed acme.com'),
    step(3, 40, 'web', 'Browsed staging.acme.com'),
    step(3, 58, 'web', 'Worked in Chrome'),
    step(3, 96, 'edit', 'Edited Footer.tsx'),
    step(3, 131, 'screenshot', 'Took a screenshot of acme-marketing', {
      image: { ...SHOT, path: 'attachments/m-att1/Footer links.jpg', name: 'footer.jpg' },
    }),
    step(3, 170, 'command', 'Ran npm test'),
  ],
};

const LIVE_CHAT = [
  ...ACME_CHAT,
  msg('user', 'Now check every footer link on staging and fix what’s broken.', 3, {
    agentId: 'acme',
  }),
];

const team = (working: boolean) =>
  overview(
    TEAM.map((a) =>
      a.id === 'acme'
        ? {
            ...a,
            project: ACME_PATH,
            status: working
              ? { ...status('working', 'Running npm test'), since: now - 3 * MIN, work: LIVE_TURN }
              : status('idle'),
          }
        : a
    )
  );

export const workCommands = (working: boolean) => ({
  agents_overview: team(working),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme' ? (working ? LIVE_CHAT : ACME_CHAT) : messagesFor(args),
});

const openAcme = { click: '[data-agent-id="acme"]' };

export const agentsWorkScenarios: Scenario[] = [
  {
    id: 'agents-work-folded',
    title: 'Agents — what a turn did, folded under each reply',
    looksRightWhen:
      'Acme Site’s chat. Under each reply, one quiet muted line with a small chevron: “Worked 6 min · 14 steps · edited 2 files” under the pricing reply and “Worked 41s · 3 steps · edited 1 file” under the footer one. It sits at the reply’s left edge, smaller than the prose, with no box or colour. Nothing else changed in the chat.',
    requires: '.agent-work__toggle',
    openSelector: AGENTS_TAB,
    steps: [openAcme],
    commands: workCommands(false),
  },
  {
    id: 'agents-work-expanded',
    title: 'Agents — a turn’s steps, opened',
    looksRightWhen:
      'The pricing reply’s line is open (chevron turned down). Below it, fourteen rows in order, each a small monochrome icon (a pencil for edits), a plain-words past-tense label and a muted time into the turn on the right (0:03 … 6:00): Updated its plan, Searched for “PricingTable”, Read PricingTable.tsx … “Tried to edit PricingTable.tsx”, “You declined: Run a command” and “Asked to run rm — you declined” drawn quieter (muted) than the rest, “You allowed: Run a command”, Ran npm test, Took a screenshot of acme-marketing with the phone screenshot as a small thumbnail under its label, Messaged Chief of Staff, Ran npm run lint. Then a muted “Edited PricingTable.tsx, pricing.css”. No raw tool names, server ids or command arguments anywhere.',
    requires: '.agent-work[data-open] .agent-work__step',
    openSelector: AGENTS_TAB,
    steps: [openAcme, { click: '[data-message-ids="work-pricing"] .agent-work__toggle' }],
    commands: workCommands(false),
  },
  {
    id: 'agents-work-live',
    title: 'Agents — the working line with its steps so far, folded',
    looksRightWhen:
      'At the bottom of Acme Site’s chat, one working line: Acme’s small key cap, “Running npm test” with a soft shimmer, then muted “· 8 steps · 3:00”. The line itself is the toggle; no chevron, no pill, no second control beside it. The steps are not shown and nothing is duplicated.',
    requires: '.agent-chat__row--working .agent-working__toggle',
    openSelector: AGENTS_TAB,
    steps: [openAcme],
    commands: workCommands(true),
  },
  {
    id: 'agents-work-live-open',
    title: 'Agents — the live timeline, opened under the working line',
    looksRightWhen:
      'The working line (“Running npm test · 8 steps · 3:00”, its meta a shade brighter now it’s open), and under it the steps already done (Read Footer.tsx, Searched for “href=”, Browsed acme.com, Browsed staging.acme.com, Worked in Chrome, Edited Footer.tsx, Took a screenshot of acme-marketing with its thumbnail), each with its time; the icons sit in the key cap’s column and the words on the line’s edge, exactly as a finished reply’s list. The last row is the step it’s on now, in full text, with its own ticking time and “Show output” under its words.',
    requires: '.agent-chat__row--working .agent-work[data-open] .agent-work__step',
    openSelector: AGENTS_TAB,
    steps: [openAcme, { click: '.agent-chat__row--working .agent-working__toggle' }],
    commands: workCommands(true),
  },
];
