/**
 * A conversation's living page (`agents/page.rs`): Finance keeps a running
 * budget pinned above its chat. The page as it is (v4, changed by a routine
 * 3 minutes ago), its history open, an older version opened from it, the
 * page folded, and unpinned (the header's Pin page). Fictional throughout.
 * Capture each with `--theme light` too.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const fin = (o: Record<string, unknown>) => ({ agentId: 'finance', ...o });

const metrics = (spent: number, left: number) => ({
  id: 'month',
  kind: 'metrics',
  summary: `Spent $${spent}, $${left} left`,
  items: [
    { label: 'Spent in November', value: spent, prefix: '$', delta: '+$310', vs: 'this week' },
    { label: 'Left to spend', value: left, prefix: '$', good: 'up' },
    { label: 'Days left', value: 20 },
  ],
});

const bills = (paid: boolean) => ({
  id: 'bills',
  kind: 'checklist',
  title: 'Bills this month',
  summary: 'Bills this month',
  items: [
    { text: 'Rent', done: true },
    { text: 'Electricity', done: paid, note: paid ? undefined : 'Due Friday' },
    { text: 'Phone', done: false, note: 'Due the 28th' },
  ],
});

const spending = {
  id: 'categories',
  kind: 'table',
  title: 'Where it went',
  summary: 'Where it went',
  columns: ['Category', { label: 'Spent', prefix: '$' }, { label: 'Budget', prefix: '$' }],
  rows: [
    ['Groceries', 412, 500],
    ['Eating out', 268, 200],
    ['Transport', 96, 150],
    ['Subscriptions', 74, 80],
  ],
};

const note = {
  id: 'heads-up',
  kind: 'callout',
  tone: 'warning',
  summary: 'Eating out is over budget',
  text: 'Eating out is $68 over budget with 20 days to go.',
};

const set = (items: unknown[]) => ({ v: 1, items });

const HISTORY = [
  {
    version: 4,
    at: now - 3 * MIN,
    title: 'November budget',
    note: 'Logged Tuesday’s card spend',
    changes: { added: ['heads-up'], changed: ['month', 'categories'], removed: [] },
    byRoutine: true,
  },
  {
    version: 3,
    at: now - 26 * 60 * MIN,
    title: 'November budget',
    note: 'Electricity is due Friday',
    changes: { added: [], changed: ['bills'], removed: [] },
  },
  {
    version: 2,
    at: now - 2 * 24 * 60 * MIN,
    title: 'November budget',
    changes: { added: ['categories'], changed: ['month'], removed: [] },
    byRoutine: true,
  },
  {
    version: 1,
    at: now - 4 * 24 * 60 * MIN,
    title: 'Budget',
    note: 'Started the month',
    changes: { added: ['month', 'bills'], changed: [], removed: [] },
  },
];

const page = (pinned: boolean) => ({
  agentId: 'finance',
  conversation: 'first',
  pinned,
  version: 4,
  at: now - 3 * MIN,
  title: 'November budget',
  note: 'Logged Tuesday’s card spend',
  changes: HISTORY[0].changes,
  byRoutine: true,
  blocks: set([metrics(1150, 850), note, spending, bills(false)]),
  history: HISTORY,
});

const V1 = {
  version: 1,
  at: now - 4 * 24 * 60 * MIN,
  title: 'Budget',
  note: 'Started the month',
  changes: HISTORY[3].changes,
  blocks: set([metrics(220, 1780), bills(false)]),
};

const CHAT = [
  msg(
    'user',
    'Keep a running budget for November, and update it when I send receipts.',
    4 * 24 * 60,
    fin({})
  ),
  msg(
    'agent',
    'Done: it’s pinned above this chat. I’ll update it every evening from your card.',
    4 * 24 * 60 - 1,
    fin({})
  ),
  msg('user', 'How am I doing on eating out?', 5, fin({})),
  msg('agent', 'Over by $68 with 20 days left. I flagged it on the page.', 4, fin({})),
];

const commands = (pinned: boolean) => ({
  agents_overview: overview(
    TEAM.map((a) => (a.id === 'finance' ? { ...a, status: status('idle') } : a))
  ),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'finance' ? CHAT : messagesFor(args),
  agents_page: (args: Record<string, unknown>) =>
    args.agentId === 'finance' ? page(pinned) : null,
  agents_page_version: (args: Record<string, unknown>) => (args.version === 1 ? V1 : null),
  agents_page_pin: (args: Record<string, unknown>) => page(Boolean(args.pinned)),
});

const open = { click: '[data-agent-id="finance"]' };
const VIEW = { width: 1280, height: 1100 };

export const agentsPageScenarios: Scenario[] = [
  {
    id: 'agents-page',
    title: 'Agents — a living page pinned above the conversation',
    looksRightWhen:
      'Under the chat header, in the conversation’s column: a quiet bar with a down chevron and “November budget”, then “Updated 3 min ago · v4” muted on the right and a pin button. Under it the page: three metric tiles ($1,150 spent, $850 left, 20 days), an amber “Heads up” note about eating out, then one card holding “Where it went” (a table, dollar columns right-aligned) and “Bills this month” (a checklist, Rent ticked, notes under the others). A hairline separates the page from the chat, whose messages carry on below. Tokens only; readable in both themes.',
    requires: '.agent-page .agent-block-metrics',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: VIEW,
    commands: commands(true),
  },
  {
    id: 'agents-page-history',
    title: 'Agents — a page’s versions: what changed, and when',
    looksRightWhen:
      'Pressing “Updated 3 min ago · v4” opens a recessed list above the page, newest first: “v4 · 3 min ago · by a routine” over “Added Heads up · Changed month, Where it went — Logged Tuesday’s card spend” (v4 highlighted as the one shown), then v3 (Changed Bills this month — Electricity is due Friday), v2 (by a routine), and v1 “Made the page — Started the month”.',
    requires: '.agent-page__history',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '.agent-page__when' }],
    viewport: VIEW,
    commands: commands(true),
  },
  {
    id: 'agents-page-older',
    title: 'Agents — reading an earlier version of a page',
    looksRightWhen:
      'v1 highlighted in the list, a muted line “v1, as it was 4 d ago. Back to v4”, and the page as it was then: $220 spent, $1,780 left, and the bills checklist, with no table or warning. The bar still says v4: the page itself hasn’t changed.',
    requires: '.agent-page__older',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '.agent-page__when' }, { click: '.agent-page__version', text: 'v1' }],
    viewport: VIEW,
    commands: commands(true),
  },
  {
    id: 'agents-page-folded',
    title: 'Agents — a page folded to its one line',
    looksRightWhen:
      'Only the page’s bar under the header: the chevron turned to point right, “November budget”, “Updated 3 min ago · v4” and the pin button; the chat takes the rest of the window.',
    requires: '.agent-page[data-folded]',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '.agent-page__toggle' }],
    viewport: VIEW,
    commands: commands(true),
  },
  {
    id: 'agents-page-unpinned',
    title: 'Agents — a page the user unpinned',
    looksRightWhen:
      'No page under the header: the chat starts right below it. Among the header’s actions, a pin button titled “Pin “November budget” above this conversation” brings it back.',
    requires: '[aria-label^="Pin the page"]',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: VIEW,
    commands: commands(false),
  },
];
