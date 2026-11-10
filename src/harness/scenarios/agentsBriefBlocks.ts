/**
 * Blocks in a real-length chat: the morning brief as `brief::compose_blocks`
 * builds it (the gist as the intro; Needs you and Usage as facts, Didn't work
 * as a warning callout, Today and Since yesterday as tables, the user's checks
 * as facts with outside text drawn literally), posted in the Chief's chat
 * under yesterday's conversation; and Finance's numbers between ordinary
 * bubbles, a reply with "What it did" and a result card. Each also narrow
 * (the chat column at its smallest). Fictional throughout. Capture with
 * `--theme light` too.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const at = (h: number, m = 0) => {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

const GIST =
  'Morning brief, Tuesday 10 November: 2 cards wait for you, 1 thing didn’t work, 4 routines today, 3 agents worked.';

/** The facts, exactly as `compose_blocks` shapes them after `blocks::parse`. */
const BRIEF_ITEMS = [
  {
    kind: 'facts',
    title: 'Needs you',
    summary:
      'Needs you: Lead Gen: Send the first of 12 lead emails; Finance: Pay the Figma invoice ($540)',
    items: [
      { label: 'Lead Gen', value: 'Send the first of 12 lead emails' },
      { label: 'Finance', value: 'Pay the Figma invoice ($540)' },
    ],
  },
  {
    kind: 'callout',
    tone: 'warning',
    title: 'Didn’t work',
    summary: 'Didn’t work: Finance’s routine “Sweep the invoices inbox” failed at 3:00 AM',
    text: 'Finance’s routine “Sweep the invoices inbox” failed at 3:00 AM: Gmail needs signing in again.',
  },
  {
    kind: 'table',
    title: 'Today',
    summary: 'Today: 4 rows',
    columns: [{ label: 'Time' }, { label: 'Agent' }, { label: 'What' }],
    rows: [
      [at(9), 'Finance', 'Sweep the invoices inbox (every 2 hours)'],
      [at(10, 30), 'Research', 'Read what’s new on AI agents and write up the three that matter'],
      [at(14), 'Acme Site', 'Check staging for broken links'],
      [at(17), 'Lead Gen', 'Find 10 new studios in Lisbon (weekdays)'],
    ],
  },
  {
    kind: 'table',
    title: 'Since yesterday',
    summary: 'Since yesterday: 3 rows',
    columns: [
      { label: 'Agent' },
      { label: 'Results', numeric: true },
      { label: 'Routines run', numeric: true },
      { label: 'Replies', numeric: true },
    ],
    rows: [
      ['Acme Site', 1, 0, 6],
      ['Research', 1, 1, 2],
      ['Finance', 0, 3, 4],
    ],
  },
  {
    kind: 'facts',
    title: 'Usage',
    summary: 'Usage: 2 of 3 accounts have room',
    items: [
      { label: 'Room', value: '2 of 3 accounts (1 not reported), by their own readings' },
      {
        label: 'Soonest reset',
        value: 'sam@acme.com (Claude Code), weekly limit, Thursday at 6:00 PM',
      },
    ],
  },
  {
    kind: 'facts',
    title: 'Your checks',
    summary: 'Your checks: events on my calendar today',
    items: [
      {
        label: 'Events on my calendar today (Google Calendar)',
        value: 'Standup 9:30; Lunch with Sam 12:30; Acme review 4:00',
      },
      {
        label: 'Unread from clients (Gmail, on Codex)',
        value: 'Couldn’t check. Gmail isn’t connected. Connect it in Apps.',
      },
    ],
  },
];

const BRIEF_TEXT = [
  GIST,
  '',
  '**Needs you**',
  '- Lead Gen: Send the first of 12 lead emails',
  '- Finance: Pay the Figma invoice ($540)',
].join('\n');

const BRIEF = msg('agent', BRIEF_TEXT, 4, {
  id: 'm-brief',
  blocks: { v: 1, intro: GIST, items: BRIEF_ITEMS },
});

const YESTERDAY = 20 * 60;
const CHIEF_WITH_BRIEF = [
  msg('user', 'Morning. What’s on fire?', YESTERDAY + 190),
  msg(
    'agent',
    'Nothing’s on fire. Three things need you today:\n\n1. **Finance** found two overdue invoices, $5,350 total.\n2. **Acme Site** is fixing the pricing table on mobile.\n3. **Lead Gen** wants your OK on the first of 12 emails.',
    YESTERDAY + 189
  ),
  msg('user', 'Get Acme Site to also check the footer links.', YESTERDAY + 70),
  msg('agent', 'On it. I’ve added the footer to Acme Site’s list.', YESTERDAY + 69),
  BRIEF,
];

/* -------------------------------------------- Finance, a real-length chat */

const fin = (o: Record<string, unknown>) => ({ agentId: 'finance', ...o });

const RAN = {
  startedAt: now - 40 * MIN,
  endedAt: now - 37 * MIN,
  stepCount: 3,
  fileCount: 1,
  files: ['october.csv'],
  engine: 'Claude Code',
  steps: [
    { at: now - 40 * MIN, kind: 'read', label: 'Read invoices/october.csv' },
    { at: now - 39 * MIN, kind: 'command', label: 'Ran a script' },
    { at: now - 38 * MIN, kind: 'edit', label: 'Wrote october-summary.md' },
  ],
};

const FIN_CHAT = [
  msg('user', 'Chase Northwind if they haven’t paid by tomorrow.', 70, fin({})),
  msg(
    'agent',
    'Will do. I’ll check back tomorrow at 9:00 and draft a firmer reminder if it’s still open.',
    69,
    fin({})
  ),
  msg('user', 'Write up October for Sam.', 41, fin({})),
  {
    ...msg('agent', 'October’s summary is ready for Sam.', 37, fin({})),
    id: 'fin-oct',
    work: RAN,
    result: {
      id: 'res-oct',
      version: 1,
      title: 'October summary for Sam',
      summary: 'Revenue, costs and the two overdue invoices, in the format Sam asked for in July.',
      checked: ['The totals match the bank export to the cent'],
      notVerified: ['Globex’s credit note isn’t in the export, so it isn’t counted'],
    },
  },
  msg('user', 'How did revenue do this year?', 30, fin({})),
  msg(
    'agent',
    'Revenue is up 38% since January.\n\n(plain-text version of 3 blocks)',
    29,
    fin({
      id: 'm-rev',
      blocks: {
        v: 1,
        intro: 'Revenue is up 38% since January. October was the best month yet.',
        items: [
          {
            kind: 'metrics',
            summary: '',
            items: [
              {
                label: 'Revenue, October',
                value: 48200,
                prefix: '$',
                delta: '+12.4%',
                vs: 'vs September',
                trend: [31, 33, 32, 36, 38, 37, 41, 42, 43, 48],
              },
              {
                label: 'Gross margin',
                value: 61.5,
                suffix: '%',
                delta: '-2.1 pts',
                vs: 'vs September',
              },
              {
                label: 'Refunds',
                value: 1240,
                prefix: '$',
                delta: -380,
                good: 'down',
                vs: 'vs September',
              },
            ],
          },
          {
            kind: 'chart',
            chart: 'line',
            title: 'Monthly revenue',
            summary: '',
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'],
            prefix: '$',
            series: [
              {
                name: 'Revenue',
                values: [34900, 33100, 36400, 37800, 39900, 38200, 41600, 43000, 42900, 48200],
              },
            ],
          },
          {
            kind: 'choices',
            summary: '',
            question: 'Want this as a monthly routine?',
            options: [
              { label: 'Yes, on the 1st', reply: 'Yes, send me this on the 1st of every month.' },
              { label: 'No thanks', reply: 'No thanks.' },
            ],
          },
        ],
      },
    })
  ),
  msg('user', 'Yes, send me this on the 1st of every month.', 20, fin({})),
  msg('agent', 'Done: a routine on the 1st at 9:00 sends you this.', 19, fin({})),
];

const team = () => overview(TEAM.map((a) => ({ ...a, status: status('idle') })));

const commands = {
  agents_overview: team(),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'chief'
      ? CHIEF_WITH_BRIEF
      : args.agentId === 'finance'
        ? FIN_CHAT
        : messagesFor(args),
  agents_turn_work: () => RAN,
  agents_send: () => null,
};

const BRIEF_LOOKS =
  'The Chief’s chat, yesterday’s exchange above, then the brief as one calm page under the gist line: “Needs you” label/value rows, an amber “Didn’t work” note with its icon, “Today” as a four-row table (time, agent, what), “Since yesterday” with right-aligned counts, “Usage” rows, and “Your checks” with the calendar items and a Couldn’t check line. Section titles read as one rhythm; nothing shouts; the spacing between sections is even and matches the chat’s own spacing.';

const NARROW = { width: 760, height: 1500 };
const TALL = { width: 1280, height: 1500 };

export const agentsBriefBlocksScenarios: Scenario[] = [
  {
    id: 'agents-blocks-brief',
    title: 'Agents — blocks: the morning brief in the Chief’s chat',
    looksRightWhen: BRIEF_LOOKS,
    requires: '.agent-blocks',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }],
    viewport: TALL,
    commands,
  },
  {
    id: 'agents-blocks-brief-narrow',
    title: 'Agents — blocks: the morning brief, narrow window',
    looksRightWhen: `${BRIEF_LOOKS} At 760px the tables keep their columns readable (What wraps rather than clipping) and nothing scrolls sideways.`,
    requires: '.agent-blocks',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="chief"]' }],
    viewport: NARROW,
    commands,
  },
  {
    id: 'agents-blocks-in-chat',
    title: 'Agents — blocks among bubbles, a result card and “What it did”',
    looksRightWhen:
      'Finance’s chat: ordinary bubbles, a reply with its “What it did” fold and the October result card, then the revenue answer as metric tiles, a line chart and a quick-reply question already answered, then the user’s yes and a short reply. The blocks sit on the same left edge and width as the result card, with the same gap above and below as between bubbles.',
    requires: '.agent-block-metrics',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    viewport: TALL,
    commands,
  },
  {
    id: 'agents-blocks-in-chat-narrow',
    title: 'Agents — blocks among bubbles, narrow window',
    looksRightWhen:
      'The same chat at 760px: metric tiles wrap two to a row rather than squeezing, the chart keeps legible axis labels, the result card and the blocks share one width.',
    requires: '.agent-block-metrics',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    viewport: NARROW,
    commands,
  },
];
