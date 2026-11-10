/**
 * "Budget" (hidden, `/chat/budget`): a conversation with a living page
 * (`src-tauri/src/agents/page.rs`): a running budget at v4, changed by a
 * routine three minutes ago, with three earlier versions kept. What
 * `agents.page`, `agents.pageVersion` and `agents.pagePin` answer for it.
 */

import type {
  AgentMessage,
  ConversationPage,
  PageHistoryEntry,
  PageVersion,
} from '@shipstudio/companion-protocol';

export const PAGE_AGENT = 'budget';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const metrics = (spent: number, left: number) => ({
  id: 'month',
  kind: 'metrics',
  summary: `Spent $${spent}, $${left} left`,
  items: [
    { label: 'Spent', value: spent, prefix: '$', delta: '+$310', vs: 'this week' },
    { label: 'Left', value: left, prefix: '$', good: 'up' },
  ],
});

const bills = {
  id: 'bills',
  kind: 'checklist',
  title: 'Bills this month',
  summary: 'Bills this month',
  items: [
    { text: 'Rent', done: true },
    { text: 'Electricity', done: false, note: 'Due Friday' },
    { text: 'Phone', done: false, note: 'Due the 28th' },
  ],
};

const categories = {
  id: 'categories',
  kind: 'table',
  title: 'Where it went',
  summary: 'Where it went',
  columns: [
    { label: 'Category' },
    { label: 'Spent', prefix: '$' },
    { label: 'Budget', prefix: '$' },
  ],
  rows: [
    ['Groceries', 412, 500],
    ['Eating out', 268, 200],
    ['Transport', 96, 150],
  ],
};

const headsUp = {
  id: 'heads-up',
  kind: 'callout',
  tone: 'warning',
  title: 'Eating out',
  summary: 'Eating out is over budget',
  text: 'Eating out is $68 over budget with 20 days to go.',
};

export function pageMock(now: number) {
  let pinned = true;
  const history: PageHistoryEntry[] = [
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
      at: now - DAY,
      title: 'November budget',
      note: 'Electricity is due Friday',
      changes: { added: [], changed: ['bills'], removed: [] },
    },
    {
      version: 2,
      at: now - 2 * DAY,
      title: 'November budget',
      changes: { added: ['categories'], changed: ['month'], removed: [] },
      byRoutine: true,
    },
    {
      version: 1,
      at: now - 4 * DAY,
      title: 'Budget',
      note: 'Started the month',
      changes: { added: ['month', 'bills'], changed: [], removed: [] },
    },
  ];
  const v1: PageVersion = {
    ...history[3],
    blocks: { v: 1, items: [metrics(220, 1780), bills] },
  };
  const page = (): ConversationPage => ({
    ...history[0],
    agentId: PAGE_AGENT,
    conversation: 'first',
    pinned,
    blocks: { v: 1, items: [metrics(1150, 850), headsUp, categories, bills] },
    history,
  });
  const messages: AgentMessage[] = [
    {
      id: 'budget-1',
      agentId: PAGE_AGENT,
      ts: now - 4 * DAY,
      kind: 'user',
      text: 'Keep a running budget for November, and update it when I send receipts.',
    },
    {
      id: 'budget-2',
      agentId: PAGE_AGENT,
      ts: now - 4 * DAY + MIN,
      kind: 'agent',
      text: 'Done: it’s pinned above this chat. I’ll update it every evening from your card.',
    },
    {
      id: 'budget-3',
      agentId: PAGE_AGENT,
      ts: now - 5 * MIN,
      kind: 'user',
      text: 'How am I doing on eating out?',
    },
    {
      id: 'budget-4',
      agentId: PAGE_AGENT,
      ts: now - 4 * MIN,
      kind: 'agent',
      text: 'Over by $68 with 20 days left. I flagged it on the page.',
    },
  ];
  return {
    messages,
    get: (agentId: string, conversation?: string) =>
      agentId === PAGE_AGENT && (conversation ?? 'first') === 'first' ? page() : null,
    version: (agentId: string, version: number) =>
      agentId !== PAGE_AGENT ? null : version === 1 ? v1 : version === 4 ? page() : null,
    pin: (agentId: string, value: boolean) => {
      if (agentId !== PAGE_AGENT) return null;
      pinned = value;
      return page();
    },
  };
}
