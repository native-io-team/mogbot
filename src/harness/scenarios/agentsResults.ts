/**
 * Result cards (`share_result`, `agents/results.rs`): the one card a turn
 * ends on — a first version, a second after "Ask for changes" (the first
 * folded), one whose agent couldn't verify much, the composer while asking
 * for changes, and a project copy's card carrying the result with before and
 * after. Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;

const file = (dir: string, name: string, mime: string, size: number) => ({
  name,
  path: `attachments/${dir}/${name}`,
  mime,
  size,
});

const SUMMARY_PDF = file('m-res0', 'october-invoices.pdf', 'application/pdf', 48_211);
const SUMMARY_CSV = file('m-res0', 'october-invoices.csv', 'text/csv', 6_120);
const BEFORE = file('m-res1', 'before.jpg', 'image/jpeg', 21_400);
const AFTER = file('m-res1', 'after.jpg', 'image/jpeg', 19_800);

const WORK = (startMin: number, endMin: number, steps: [number, string, string][]) => ({
  startedAt: now - startMin * MIN,
  endedAt: now - endMin * MIN,
  stepCount: steps.length,
  fileCount: 0,
  files: [],
  steps: steps.map(([s, kind, label]) => ({ at: now - startMin * MIN + s * 1000, kind, label })),
});

const V1 = {
  id: 'res-oct',
  version: 1,
  title: 'October invoice summary',
  summary:
    'Every October invoice on one page, grouped by client, with what’s paid, what’s due and what’s overdue. The CSV has the same rows for your spreadsheet.',
  items: [
    { kind: 'file', file: SUMMARY_PDF, label: 'Summary (PDF)' },
    { kind: 'file', file: SUMMARY_CSV },
    {
      kind: 'link',
      url: 'https://docs.google.com/spreadsheets/d/1oct/edit',
      label: 'Source sheet',
    },
  ],
  checked: ['Totals match the October bank export', 'Every invoice number appears once'],
  notVerified: [
    'Two EUR invoices (Globex, Initech) use today’s rate, not the rate on the invoice date',
    'Northwind’s $4,200 is marked unpaid; the bank export ends Oct 30',
  ],
};

const V2 = {
  ...V1,
  version: 2,
  summary:
    'Every October invoice on one page, grouped by client. EUR invoices now use the rate on each invoice’s date.',
  checked: ['Recomputed both EUR totals', 'Totals match the October bank export'],
  notVerified: ['Northwind’s $4,200 is marked unpaid; the bank export ends Oct 30'],
  changes: 'EUR invoices use the rate on each invoice’s date (Globex −$12.40, Initech +$3.10)',
};

const finance = (o: Record<string, unknown>) => ({ agentId: 'finance', ...o });

const FINANCE_V1 = [
  msg(
    'user',
    'Can you put together a summary of October’s invoices? I need it for the board pack.',
    32,
    finance({})
  ),
  msg(
    'agent',
    'On it. I’ll pull them from the sheet and check them against the bank.',
    31,
    finance({})
  ),
  msg(
    'agent',
    V1.summary,
    24,
    finance({
      id: 'res-v1',
      attachments: [SUMMARY_PDF, SUMMARY_CSV],
      result: V1,
      work: WORK(31, 24, [
        [4, 'tool', 'Searched Google Drive'],
        [40, 'read', 'Read October invoices'],
        [180, 'command', 'Ran python3'],
        [300, 'read', 'Read bank-export-october.csv'],
        [400, 'message', 'Put together its result'],
      ]),
    })
  ),
];

const FINANCE_V2 = [
  ...FINANCE_V1,
  msg(
    'user',
    'Use the rate on each invoice’s date for the EUR ones.',
    10,
    finance({ revises: { id: 'res-oct', version: 1, title: 'October invoice summary' } })
  ),
  msg(
    'agent',
    V2.summary,
    6,
    finance({ id: 'res-v2', attachments: [SUMMARY_PDF, SUMMARY_CSV], result: V2 })
  ),
];

/** A research brief from an agent that couldn't reach much: the list is long and up front. */
const BRIEF = {
  id: 'res-brief',
  version: 1,
  title: 'Northwind: who to talk to',
  summary:
    'A one-page brief on Northwind’s marketing team: who owns the website, what they launched this year, and two openings for us.',
  items: [
    { kind: 'file', file: file('m-res2', 'northwind-brief.md', 'text/markdown', 3_420) },
    { kind: 'link', url: 'https://northwind.example.com/about/team', label: 'Their team page' },
    { kind: 'link', url: 'https://www.linkedin.com/company/northwind-example' },
  ],
  notVerified: [
    'LinkedIn asked me to sign in, so titles come from their own site and may be out of date',
    'I couldn’t confirm who owns the website day to day; Dana Ruiz is my best guess from a press release',
    'Their 2026 launch dates are from a cached page, not the live one',
  ],
};

const LEADGEN_CHAT = [
  msg('user', 'Before Thursday’s call, can you find out who runs Northwind’s website?', 18, {
    agentId: 'leadgen',
  }),
  msg('agent', BRIEF.summary, 9, {
    agentId: 'leadgen',
    id: 'res-brief',
    attachments: [BRIEF.items[0]].map((i) => (i as { file: unknown }).file),
    result: BRIEF,
  }),
];

/* ------------------------------------------------- a project copy's result */

const COPY = {
  id: 'copy_pricing',
  path: `${HARNESS_ROOT}/.worktrees/acme-marketing/acme-site-pricing-cards-9f2c`,
  branch: 'acme-site/pricing-cards-9f2c',
};

const PRICING_FILES = [
  { path: 'src/components/PricingTable.tsx', status: 'modified', added: 38, removed: 12 },
  { path: 'src/styles/pricing.css', status: 'modified', added: 21, removed: 4 },
  { path: 'src/components/PricingCard.tsx', status: 'added', added: 64 },
];

const PRICING_RESULT = {
  id: 'res-pricing',
  version: 1,
  title: 'Pricing cards on mobile',
  summary:
    'The three plans now stack below 640px, and the “Most popular” badge sits beside the plan name instead of over the price.',
  items: [
    { kind: 'file', file: BEFORE, role: 'before' },
    { kind: 'file', file: AFTER, role: 'after' },
    { kind: 'link', url: 'http://localhost:3104/pricing', label: 'Pricing page in the preview' },
  ],
  checked: ['pnpm build passes', 'Checked 375px, 768px and 1280px in the preview'],
  notVerified: ['Safari on a real iPhone'],
};

const ACME_CHAT = [
  msg('user', 'The pricing cards overlap on mobile. Can you fix it and show me?', 30, {
    agentId: 'acme',
  }),
  msg('agent', 'Fixed, with a before and after from the phone preview.', 24, { agentId: 'acme' }),
  msg('changes', `Changed ${PRICING_FILES.length} files in a copy of acme-marketing`, 24, {
    agentId: 'acme',
    id: 'res-copy',
    attachments: [BEFORE, AFTER],
    result: PRICING_RESULT,
    changes: {
      project: ACME_PATH,
      from: 'base-tree',
      to: 'copy-tree',
      files: PRICING_FILES,
      fileCount: PRICING_FILES.length,
      added: 123,
      removed: 16,
      copy: COPY,
    },
    work: WORK(30, 24, [
      [1, 'project', 'Started a copy of acme-marketing'],
      [20, 'read', 'Read PricingTable.tsx'],
      [90, 'edit', 'Edited PricingTable.tsx'],
      [200, 'command', 'Ran pnpm build'],
      [300, 'screenshot', 'Took a screenshot of acme-marketing'],
    ]),
  }),
];

const copyTeam = () =>
  overview(
    TEAM.map((a) =>
      a.id === 'acme'
        ? {
            ...a,
            project: ACME_PATH,
            status: status('idle'),
            copy: {
              ...COPY,
              project: ACME_PATH,
              base: 'a1b2c3',
              baseBranch: 'main',
              createdAt: now - 30 * MIN,
              deps: true,
            },
          }
        : a.id === 'leadgen'
          ? { ...a, status: status('idle') }
          : a
    )
  );

const chats = (finance: unknown[]) => ({
  agents_overview: copyTeam(),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'finance'
      ? finance
      : args.agentId === 'acme'
        ? ACME_CHAT
        : args.agentId === 'leadgen'
          ? LEADGEN_CHAT
          : messagesFor(args),
});

const open = (id: string) => ({ click: `[data-agent-id="${id}"]` });

export const agentsResultsScenarios: Scenario[] = [
  {
    id: 'agents-result-v1',
    title: 'Agents — a result card at the end of a reply',
    looksRightWhen:
      'Finance’s chat ends on one card (same grey surface and radius as an approval card): the title “October invoice summary” in the heading weight, the two-sentence summary, then a quiet outlined “Not verified” box (a question mark, not a warning triangle; no fill) with a warning icon and two lines (EUR rate, Northwind unpaid). Then three rows, each opening: “Summary (PDF)” with “PDF · 47.1 KB”, “october-invoices.csv” with “CSV · 6.0 KB”, “Source sheet” with “docs.google.com”, each with a muted “Open ↗” on the right. Then a quiet “It says it checked” list with two plain-bulleted lines (no ticks: they are the agent’s claims), and a single “Ask for changes” action. Under the card, the folded “Worked 6 min · 5 steps” line. No raw ids, no tool names.',
    requires: '.agent-result .agent-result__unverified',
    openSelector: AGENTS_TAB,
    steps: [open('finance')],
    commands: chats(FINANCE_V1),
  },
  {
    id: 'agents-result-asking',
    title: 'Agents — Ask for changes opens the composer on the card',
    looksRightWhen:
      'Same chat. Above the composer’s text, a quote-style chip with a speech-bubble icon: “Changes to October invoice summary · v1”, with an × to drop it. The text field has focus and the typed request “Use the rate on each invoice’s date for the EUR ones.”',
    requires: '.agent-composer__revising',
    openSelector: AGENTS_TAB,
    steps: [
      open('finance'),
      { click: '.agent-result > .agent-card__actions button' },
      {
        fill: '.agent-composer__input',
        value: 'Use the rate on each invoice’s date for the EUR ones.',
      },
    ],
    commands: chats(FINANCE_V1),
  },
  {
    id: 'agents-result-v2',
    title: 'Agents — the same result, revised to version 2',
    looksRightWhen:
      'The first card is folded to one muted line with a chevron: “October invoice summary · v1 · a newer version is below”. Your message shows a quote bar “Changes to October invoice summary · v1” above “Use the rate on each invoice’s date…”. The newest card has a small “v2” badge beside the title and, under it, a muted line “Changes since v1: EUR invoices use the rate on each invoice’s date (Globex −$12.40, Initech +$3.10)”; its Not verified box now has one line; “It says it checked” has “Recomputed both EUR totals”. One Ask for changes, on the newest card only.',
    requires: '.agent-result-past',
    openSelector: AGENTS_TAB,
    steps: [open('finance')],
    commands: chats(FINANCE_V2),
  },
  {
    id: 'agents-result-not-verified',
    title: 'Agents — a result whose agent couldn’t verify much',
    looksRightWhen:
      'Lead Gen’s brief: title, summary, and straight under it the quiet outlined “Not verified” box with three plain lines (LinkedIn sign-in, a best guess on the website owner, cached launch dates), before the items. No “It says it checked” section at all, because the agent listed none. Items: the brief (MD), “Their team page” (northwind.example.com) and the LinkedIn link shown by its host and path.',
    requires: '.agent-result[data-unverified]',
    openSelector: AGENTS_TAB,
    steps: [open('leadgen')],
    commands: chats(FINANCE_V1),
  },
  {
    id: 'agents-result-copy',
    title: 'Agents — a project copy’s card carrying the result, with before and after',
    looksRightWhen:
      'Acme Site’s reply ends on ONE card, not two: title “Pricing cards on mobile”, the summary, a quiet outlined “Not verified · Safari on a real iPhone”, then two phone screenshots side by side captioned “Before” (cards overlapping) and “After” (stacked), then the “Pricing page in the preview” link row and “It says it checked” (build, three widths, bulleted, no ticks). Below a hairline inside the same card: “Changes are ready” with “3 files”, the line “On a copy of acme-marketing · acme-marketing itself is unchanged”, and Keep changes · Review · Preview · Ask for changes · Discard · ⋯. The folded “Worked 5 min · 5 steps” line sits under the card.',
    requires: '.agent-result .agent-changes[data-in-result]',
    openSelector: AGENTS_TAB,
    steps: [open('acme')],
    commands: chats(FINANCE_V1),
  },
];
