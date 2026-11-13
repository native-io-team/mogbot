/**
 * "Tables" (hidden, `/chat/tables`): a six-column table with long cells,
 * wider than a phone, three ways: in a plain reply (markdown), as a `table`
 * block and in a result card's summary. Each must scroll sideways in its own
 * well while the words around it stay put (qa:web `tables-*`).
 */

import type { AgentMessage, Block } from '@shipstudio/companion-protocol';

const ID = 'tables';

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

const money = (c: string | number) =>
  typeof c === 'number' ? `$${c.toLocaleString('en-US')}` : c;

export const WIDE_TABLE_MARKDOWN = [
  'Here are the three vendors renewing next year, with what each costs and what to watch.',
  '',
  `| ${HEAD.join(' | ')} |`,
  `| ${HEAD.map((_, i) => (i === 4 ? '---:' : '---')).join(' | ')} |`,
  ...ROWS.map((r) => `| ${r.map(money).join(' | ')} |`),
  '',
  'Northwind is the one to decide on first: its notice period ends in January.',
].join('\n');

const TABLE: Block = {
  kind: 'table',
  title: 'Renewals next year',
  summary: 'Renewals next year (3 rows)',
  columns: HEAD.map((label, i) => (i === 4 ? { label, numeric: true, prefix: '$' } : { label })),
  rows: ROWS,
};

export function tablesMessages(now: number): AgentMessage[] {
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  return [
    {
      id: `${ID}_0`,
      agentId: ID,
      ts: at(30),
      kind: 'user',
      text: 'Which vendors renew next year, and what do they cost?',
    },
    { id: `${ID}_1`, agentId: ID, ts: at(29), kind: 'agent', text: WIDE_TABLE_MARKDOWN },
    {
      id: `${ID}_2`,
      agentId: ID,
      ts: at(20),
      kind: 'agent',
      text: 'The same three as a table you can sort.\n\n(plain-text version of 1 block)',
      blocks: { v: 1, intro: 'The same three as a table you can sort.', items: [TABLE] },
    },
    {
      id: `${ID}_3`,
      agentId: ID,
      ts: at(10),
      kind: 'agent',
      text: WIDE_TABLE_MARKDOWN,
      result: {
        id: 'res_renewals',
        version: 1,
        title: 'Vendor renewals for 2027',
        summary: WIDE_TABLE_MARKDOWN,
        items: [],
        checked: ['Costs match the last twelve months of invoices'],
      },
    },
  ];
}
