/**
 * Blocks (`show`): an agent answering with UI, not just prose. One chat per
 * family: numbers (metrics, a line chart, grouped bars, a table), more
 * charts (stacked area, donut, pie, a sparkline), deciding (a comparison,
 * quick replies, a form), progress (a checklist, steps, facts, callouts,
 * links, a diff), the same decisions once answered, and blocks from a turn
 * that read outside text. Fictional throughout. Capture each with
 * `--theme light` too.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, msg, overview, status } from './agents';

const fin = (o: Record<string, unknown>) => ({ agentId: 'finance', ...o });

/** A message carrying blocks: `text` is their plain version, as the Mac writes it. */
const blocks = (id: string, minutesAgo: number, intro: string, items: unknown[], extra = {}) =>
  msg(
    'agent',
    `${intro}\n\n(plain-text version of ${items.length} blocks)`,
    minutesAgo,
    fin({ id, blocks: { v: 1, intro, items, ...extra } })
  );

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];

const NUMBERS = [
  msg('user', 'How did revenue do this year? And what’s eating the margin?', 30, fin({})),
  blocks('m-numbers', 29, 'Revenue is up 38% since January. October was the best month yet.', [
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
        { label: 'Gross margin', value: 61.5, suffix: '%', delta: '-2.1 pts', vs: 'vs September' },
        {
          label: 'Refunds',
          value: 1240,
          prefix: '$',
          delta: -380,
          good: 'down',
          vs: 'vs September',
        },
        { label: 'Open invoices', value: 14 },
      ],
    },
    {
      kind: 'chart',
      chart: 'line',
      title: 'Monthly revenue',
      summary: '',
      labels: MONTHS,
      prefix: '$',
      series: [
        {
          name: 'Revenue',
          values: [34900, 33100, 36400, 37800, 39900, 38200, 41600, 43000, 42900, 48200],
        },
      ],
    },
    {
      kind: 'chart',
      chart: 'bar',
      title: 'Costs by quarter',
      summary: '',
      labels: ['Q1', 'Q2', 'Q3', 'Q4 so far'],
      prefix: '$',
      series: [
        { name: 'Hosting', values: [9200, 10400, 12100, 8300] },
        { name: 'Contractors', values: [14100, 12800, 16500, 9900] },
        { name: 'Software', values: [3100, 3300, 3600, 2500] },
      ],
    },
    {
      kind: 'table',
      title: 'Biggest customers',
      summary: '',
      columns: [
        { label: 'Customer' },
        { label: 'Plan' },
        { label: 'Revenue', numeric: true, prefix: '$' },
        { label: 'Seats', numeric: true },
        { label: 'Since' },
      ],
      rows: [
        ['Northwind', 'Enterprise', 84200, 120, '2023'],
        ['Globex', 'Team', 41950, 46, '2024'],
        ['Initech', 'Team', 38400, 40, '2022'],
        ['Umbrella', 'Enterprise', 36100, 75, '2025'],
        ['Hooli', 'Pro', 12900, 9, '2024'],
        ['Stark', 'Pro', 11300, 8, '2025'],
        ['Wayne', 'Team', 9800, 12, '2023'],
        ['Acme', 'Pro', 7600, 5, '2024'],
        ['Soylent', 'Pro', 4100, 3, '2025'],
        ['Vandelay', 'Pro', null, 2, '2025'],
      ],
    },
  ]),
];

const CHARTS = [
  msg('user', 'Where do signups come from, and how is the week going?', 20, fin({})),
  blocks('m-charts', 19, 'Search still brings most people in; referrals doubled.', [
    {
      kind: 'chart',
      chart: 'area',
      stacked: true,
      title: 'Signups by channel',
      axis: 'Signups per week',
      summary: '',
      labels: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'],
      series: [
        { name: 'Search', values: [120, 132, 128, 141, 150, 147, 158, 166] },
        { name: 'Referral', values: [30, 34, 41, 45, 52, 58, 61, 66] },
        { name: 'Ads', values: [44, 40, 38, 52, 49, 41, 39, 36] },
      ],
    },
    {
      kind: 'chart',
      chart: 'donut',
      title: 'Where this month’s signups came from',
      summary: '',
      labels: ['Search', 'Referral', 'Ads', 'Social', 'Other'],
      series: [{ name: 'Signups', values: [612, 238, 166, 91, 40] }],
    },
    {
      kind: 'chart',
      chart: 'pie',
      title: 'Plan mix',
      summary: '',
      labels: ['Pro', 'Team', 'Enterprise'],
      series: [{ name: 'Customers', values: [58, 31, 11] }],
    },
    {
      kind: 'chart',
      chart: 'sparkline',
      title: 'Signups today, by hour',
      summary: '',
      labels: [],
      series: [{ name: 'Signups', values: [2, 1, 0, 1, 3, 6, 9, 12, 10, 14, 13, 17] }],
    },
  ]),
];

const COMPARE = {
  kind: 'comparison',
  title: 'Where to host the new site',
  summary: '',
  options: [
    {
      name: 'Vercel',
      summary: 'What the team already knows; previews on every pull request.',
      facts: [
        { label: 'Cost', value: '$20 / month' },
        { label: 'Build time', value: '~40 s' },
      ],
      pros: ['Previews per branch', 'Zero config for Next.js'],
      cons: ['Bandwidth adds up past 1 TB'],
      recommended: true,
      reply: 'Let’s go with Vercel.',
    },
    {
      name: 'Netlify',
      summary: 'Close second, a little cheaper at our traffic.',
      facts: [
        { label: 'Cost', value: '$19 / month' },
        { label: 'Build time', value: '~55 s' },
      ],
      pros: ['Forms built in'],
      cons: ['Slower builds', 'Edge functions are separate'],
      reply: 'Let’s go with Netlify.',
    },
    {
      name: 'Cloudflare Pages',
      summary: 'Cheapest by far; needs a bit of setup for images.',
      facts: [
        { label: 'Cost', value: '$5 / month' },
        { label: 'Build time', value: '~70 s' },
      ],
      pros: ['Unlimited bandwidth'],
      cons: ['Image resizing is extra work', 'Fewer team features'],
      reply: 'Let’s go with Cloudflare Pages.',
    },
  ],
};

const CHOICES = {
  kind: 'choices',
  summary: '',
  question: 'Want me to move the DNS over as well?',
  options: [
    { label: 'Yes, move it', reply: 'Yes, move the DNS too.' },
    { label: 'Not yet', reply: 'Not yet.' },
    { label: 'What does that involve?', reply: 'What does moving the DNS involve?' },
  ],
};

const FORM = {
  kind: 'form',
  title: 'The launch event',
  summary: '',
  submit: 'Send details',
  fields: [
    { id: 'name', label: 'Event name', type: 'text', required: true, placeholder: 'Spring launch' },
    { id: 'date', label: 'Date', type: 'date', required: true },
    { id: 'size', label: 'Guests', type: 'number', placeholder: '40' },
    { id: 'where', label: 'Where', type: 'choice', options: ['Office', 'Rooftop', 'Online'] },
    { id: 'notes', label: 'Anything else', type: 'long_text' },
  ],
};

const DECIDE = [
  msg('user', 'Help me pick a host, then I’ll give you the event details.', 12, fin({})),
  blocks('m-decide', 11, 'Three good options. I’d pick Vercel: it is what the team already uses.', [
    COMPARE,
  ]),
  blocks('m-dns', 10.5, 'One more thing first.', [CHOICES]),
  blocks('m-form', 10, 'And for the launch event, a few details:', [FORM]),
];

const PROGRESS = [
  msg('user', 'Where are we on the launch?', 8, fin({})),
  blocks('m-progress', 7, 'Most of it is done. One thing is blocked on DNS.', [
    {
      kind: 'steps',
      title: 'Launch plan',
      summary: '',
      items: [
        { title: 'Copy approved', status: 'done', when: 'Mon' },
        { title: 'Site built', status: 'done', when: 'Wed', detail: 'All 6 pages, both themes' },
        {
          title: 'Domain moved',
          status: 'failed',
          detail: 'The registrar wants a code from your email',
        },
        {
          title: 'Announcement drafted',
          status: 'current',
          detail: 'Two versions, for you to pick',
        },
        { title: 'Go live', status: 'todo', when: 'Fri 9:00' },
      ],
    },
    {
      kind: 'checklist',
      title: 'Before Friday',
      summary: '',
      items: [
        { text: 'Pricing page proofread', done: true },
        { text: 'Analytics on', done: true },
        { text: 'Redirects from the old site', done: true },
        { text: 'Social images', done: false, note: 'Waiting on the final logo' },
        { text: 'Domain transfer code', done: false },
      ],
    },
    {
      kind: 'facts',
      title: 'The domain',
      summary: '',
      items: [
        { label: 'Domain', value: 'acme-launch.com' },
        { label: 'Registrar', value: 'Namecheap' },
        { label: 'Expires', value: '12 March 2027' },
        { label: 'Nameservers', value: 'dns1.registrar-servers.com, dns2.registrar-servers.com' },
      ],
    },
    {
      kind: 'callout',
      tone: 'warning',
      summary: '',
      text: 'The transfer code expires in 5 days. Forward me the registrar’s email and I’ll finish it.',
    },
    {
      kind: 'callout',
      tone: 'success',
      title: 'Redirects work',
      summary: '',
      text: 'All 42 old addresses land on the right new page.',
    },
    {
      kind: 'callout',
      tone: 'info',
      summary: '',
      text: 'Go-live is at 9:00 on Friday, your time.',
    },
    {
      kind: 'links',
      title: 'Sources',
      summary: '',
      items: [
        {
          url: 'https://www.namecheap.com/support/knowledgebase/transfer/',
          label: 'How to transfer a domain',
          domain: 'namecheap.com',
        },
        {
          url: 'https://vercel.com/docs/domains',
          label: 'Vercel: adding a domain',
          domain: 'vercel.com',
          note: 'step 3',
        },
        {
          url: 'https://status.vercel.com',
          label: 'status.vercel.com',
          domain: 'status.vercel.com',
        },
      ],
    },
    {
      kind: 'code',
      language: 'diff',
      title: 'vercel.json',
      summary: '',
      code: '@@ redirects @@\n {\n-  "source": "/blog/:slug",\n-  "destination": "/news/:slug"\n+  "source": "/blog/:slug*",\n+  "destination": "/journal/:slug*",\n+  "permanent": true\n }',
    },
  ]),
];

const ANSWERED = [
  ...DECIDE.slice(0, 3),
  msg('user', 'Let’s go with Vercel.', 9, fin({})),
  blocks('m-ack', 8, 'Vercel it is. Moving the project over now.', [
    {
      ...CHOICES,
      question: 'Shall I keep the old site up for a week?',
      options: [
        { label: 'Yes', reply: 'Yes' },
        { label: 'No', reply: 'No' },
      ],
    },
  ]),
  msg('user', 'Yes', 7, fin({})),
];

const OUTSIDE = [
  msg('agent', 'A “When…” routine found a new email from billing@northwind.com.', 6, fin({})),
  blocks(
    'm-outside',
    5,
    'Northwind asks to move their renewal to annual billing.',
    [
      {
        ...CHOICES,
        question: 'How should I answer them?',
        options: [
          { label: 'Accept annual billing', reply: 'Accept Northwind’s annual billing.' },
          { label: 'Ask for a call', reply: 'Ask Northwind for a call first.' },
        ],
      },
    ],
    { fromOutside: true }
  ),
];

const team = () =>
  overview(TEAM.map((a) => (a.id === 'finance' ? { ...a, status: status('idle') } : a)));

const commands = (chat: unknown[]) => ({
  agents_overview: team(),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'finance' ? chat : messagesFor(args),
  agents_send: () => null,
});

const open = { click: '[data-agent-id="finance"]' };
const TALL = { width: 1440, height: 1900 };

export const agentsBlocksScenarios: Scenario[] = [
  {
    id: 'agents-blocks-numbers',
    title: 'Agents — blocks: metric tiles, a line chart, grouped bars, a table',
    looksRightWhen:
      'Finance answers with its sentence, then four metric tiles in a row (big values “$48.2K”, “61.5%”, “$1,240”, “14”; deltas with an arrow: green ↑ +$12.4, red ↓ −2.1 pts, green ↓ −$380 because down is good for refunds; muted “vs September”; a thin blue sparkline under the first). Then a card “Monthly revenue”: a 2px blue line with a faint wash, hairline grid, ticks “$30K … $50K”, months along the bottom, “$48.2K” labelled at the end. Then “Costs by quarter”: three bars per quarter in blue, orange, teal with 2px gaps and rounded tops, a legend above. Then “Biggest customers”: a table with right-aligned tabular numbers, the first eight rows and “Show all 10 rows”. Tokens only; readable in both themes.',
    requires: '.agent-block-metrics',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: TALL,
    commands: commands(NUMBERS),
  },
  {
    id: 'agents-blocks-chart-hover',
    title: 'Agents — blocks: pointing at a month (or arrowing to it) shows its value',
    looksRightWhen:
      'On “Monthly revenue”, a faint column and a thin crosshair at one month, a dot on the line with a surface ring, and a small tooltip beside it with the month in bold and the value (Jul, “$41,600”) in tabular figures. The end label is hidden while hovering.',
    requires: '.agent-block-chart__tooltip',
    openSelector: AGENTS_TAB,
    steps: [
      open,
      { focus: '[data-chart="line"] svg' },
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft' },
    ],
    viewport: TALL,
    commands: commands(NUMBERS),
  },
  {
    id: 'agents-blocks-table-sorted',
    title: 'Agents — blocks: a table sorted by revenue, every row shown',
    looksRightWhen:
      '“Biggest customers” sorted by Revenue, largest first (Northwind at the top), the Revenue header showing a small down arrow, all ten rows, Vandelay’s empty revenue as a muted dash at the bottom, and “Show fewer” under it.',
    requires: '.agent-block-table',
    openSelector: AGENTS_TAB,
    steps: [
      open,
      { click: '.agent-block-table th button', text: 'Revenue' },
      { click: '.agent-block-table__more button' },
    ],
    viewport: TALL,
    commands: commands(NUMBERS),
  },
  {
    id: 'agents-blocks-charts',
    title: 'Agents — blocks: stacked area, donut, pie and a sparkline',
    looksRightWhen:
      '“Signups by channel”: three stacked bands (blue, orange, teal) with hairline gaps, “Signups per week” above, a legend. “Where this month’s signups came from”: a donut with 2px gaps between slices, the total “1,147” in the middle, a legend beside it with each share (53%, 21%, …). “Plan mix”: a pie with three slices and its legend. “Signups today, by hour”: just its title and a thin rising line ending in a dot, no axes.',
    requires: '[data-chart="donut"]',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: TALL,
    commands: commands(CHARTS),
  },
  {
    id: 'agents-blocks-decide',
    title: 'Agents — blocks: a comparison, quick replies and a form',
    looksRightWhen:
      '“Where to host the new site”: three option cards side by side, Vercel ringed in a neutral outline with a “Recommended” badge; each with its line, cost and build time right-aligned, green + pros and red − cons under a hairline, and “Pick this” at the bottom (Vercel’s strong neutral, the others outlined; never the accent). Then “Want me to move the DNS over as well?” with three outlined buttons. Then a card “The launch event” with Event name, Date (a date input), Guests, Where as three toggle buttons, Anything else as a text area, “Optional” beside the optional ones, and “Send details” right-aligned, strong neutral.',
    requires: '.agent-block-compare',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: TALL,
    commands: commands(DECIDE),
  },
  {
    id: 'agents-blocks-form-invalid',
    title: 'Agents — blocks: a form sent with what it needs missing',
    looksRightWhen:
      'The launch event form after pressing Send details empty: “Needed” in red under Event name and Date, their fields outlined as invalid; nothing was sent (no new message in the chat).',
    requires: '.agent-block-form__error',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '.agent-block-form button[type="submit"]' }],
    viewport: TALL,
    commands: commands(DECIDE),
  },
  {
    id: 'agents-blocks-progress',
    title: 'Agents — blocks: steps, a checklist, facts, callouts, links and a diff',
    looksRightWhen:
      '“Launch plan”: five steps on a rail, two green ticks, a red ✕ on “Domain moved” with its reason in red, a blue ring on “Announcement drafted”, a numbered grey disc for Go live. “Before Friday”: a thin green progress bar, “3 of 5 done”, ticked boxes muted, open boxes with a note under Social images. “The domain”: label/value rows with hairlines. Three tinted notes, each with its icon and a word: amber “Heads up”, green “Redirects work”, blue “Note”. “Sources”: three chips with a letter tile, the label and the domain, an external-link mark (no favicons). Then a vercel.json diff with green and red line washes in the mono font.',
    requires: '.agent-block-steps',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: TALL,
    commands: commands(PROGRESS),
  },
  {
    id: 'agents-blocks-answered',
    title: 'Agents — blocks: answered decisions stay answered',
    looksRightWhen:
      'The comparison above the user’s “Let’s go with Vercel.”: Vercel ringed in green with “✓ Your pick”, the other two with no Pick this. The DNS question shows no buttons, only “Answered”. The later “Shall I keep the old site up for a week?” shows one quiet chip “✓ Yes”, no buttons.',
    requires: '.agent-block-compare__chosen',
    openSelector: AGENTS_TAB,
    steps: [open],
    viewport: TALL,
    commands: commands(ANSWERED),
  },
  {
    id: 'agents-blocks-outside',
    title: 'Agents — blocks from a turn that read outside text stage, never send',
    looksRightWhen:
      '“How should I answer them?” with two outlined buttons, and under them a muted line saying this came from something it read outside the app, so the answer goes into your message first. After clicking “Ask for a call”, the composer holds “Ask Northwind for a call first.” and nothing was sent.',
    requires: '.agent-blocks__staged',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '.agent-block-choices button', text: 'Ask for a call' }],
    commands: commands(OUTSIDE),
  },
];
