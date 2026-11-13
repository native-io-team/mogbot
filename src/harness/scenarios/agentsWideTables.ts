/**
 * Wide tables: six columns with long cells, wider than the chat, in a plain
 * reply (markdown), a `table` block and a result card's summary. Each must
 * scroll sideways in its own frame while the rest of the message stays put,
 * so the right-hand columns can be read. Captured in a narrow window, where
 * they overflow.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, msg, overview, status } from './agents';

const fin = (o: Record<string, unknown>) => ({ agentId: 'finance', ...o });

const HEAD = ['Vendor', 'Contact', 'What they do for us', 'Renewal', 'Annual cost', 'Notes'];
const ROWS: (string | number)[][] = [
  [
    'Northwind Hosting',
    'dana.ruiz@northwind.example.com',
    'Production hosting, the CDN and nightly database backups',
    'March 14, 2027',
    48200,
    'Price goes up 8% at renewal unless we sign for two years',
  ],
  [
    'Globex Analytics',
    'billing@globex.example.com',
    'Product analytics and the weekly board dashboard',
    'January 2, 2027',
    12900,
    'Seats unused since August; could drop to the Team plan',
  ],
  [
    'Initech Payroll',
    'support@initech.example.com',
    'Payroll for the contractors in three countries',
    'June 30, 2027',
    9800,
    'Asked for an invoice in EUR; still waiting on a reply',
  ],
];

const MARKDOWN_TABLE = [
  'Here are the three vendors renewing next year, with what each costs and what to watch.',
  '',
  `| ${HEAD.join(' | ')} |`,
  `| ${HEAD.map((_, i) => (i === 4 ? '---:' : '---')).join(' | ')} |`,
  ...ROWS.map(
    (r) =>
      `| ${r.map((c) => (typeof c === 'number' ? `$${c.toLocaleString('en-US')}` : c)).join(' | ')} |`
  ),
  '',
  'Northwind is the one to decide on first: its notice period ends in January.',
].join('\n');

const TABLE_BLOCK = {
  kind: 'table',
  title: 'Renewals next year',
  summary: '',
  columns: HEAD.map((label, i) => (i === 4 ? { label, numeric: true, prefix: '$' } : { label })),
  rows: ROWS,
};

const RESULT = {
  id: 'res-renewals',
  version: 1,
  title: 'Vendor renewals for 2027',
  summary: MARKDOWN_TABLE,
  items: [],
  checked: ['Costs match the last twelve months of invoices'],
};

const CHAT = [
  msg('user', 'Which vendors renew next year, and what do they cost?', 30, fin({})),
  msg('agent', MARKDOWN_TABLE, 29, fin({ id: 'm-wide-md' })),
  msg(
    'agent',
    'The same three as a table you can sort.\n\n(plain-text version of 1 block)',
    20,
    fin({
      id: 'm-wide-block',
      blocks: { v: 1, intro: 'The same three as a table you can sort.', items: [TABLE_BLOCK] },
    })
  ),
  msg('agent', RESULT.summary, 10, fin({ id: 'm-wide-result', result: RESULT })),
];

const commands = {
  agents_overview: () =>
    overview(TEAM.map((a) => (a.id === 'finance' ? { ...a, status: status('idle') } : a))),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'finance' ? CHAT : messagesFor(args),
  agents_send: () => null,
};

export const agentsWideTablesScenarios: Scenario[] = [
  {
    id: 'agents-wide-tables',
    title: 'Agents — wide tables scroll sideways in a reply, a table block and a result card',
    looksRightWhen:
      'In a narrow window, Finance’s three answers each hold a six-column vendor table wider than the chat: the markdown reply’s table, the “Renewals next year” block and the table in the “Vendor renewals for 2027” result card. Each table is cut at its frame’s right edge with a thin horizontal scrollbar, and scrolls sideways on its own (to Annual cost and Notes) while the sentences above and below it, the card’s header and its checks stay where they are. Columns keep readable widths: no cell squeezed to a letter or two. Nothing in the chat scrolls the chat sideways.',
    requires: '.agent-result .agent-markdown table',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    viewport: { width: 900, height: 1500 },
    commands,
  },
];
