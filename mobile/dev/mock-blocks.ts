/**
 * "Blocks" (hidden, `/chat/blocks`): one conversation with every block kind
 * an agent can `show`, as the Mac checks and stores them
 * (`src-tauri/src/agents/blocks.rs`), each with its plain-text `text` for
 * older phones. Ends on a question and a form still waiting, after a
 * comparison already answered, so qa:web sees both states.
 */

import type { AgentMessage, Attachment, Block } from '@shipstudio/companion-protocol';
import { png } from './mock-assets';

type Attach = (
  agentId: string,
  messageId: string,
  name: string,
  mime: string,
  bytes: Buffer
) => Attachment;

const ID = 'blocks';

/** A small bar picture, the kind of image an agent makes in its folder. */
function funnelPng(): Buffer {
  const bars: [number, number, number][] = [
    [40, 520, 0],
    [40, 380, 1],
    [40, 240, 2],
    [40, 120, 3],
  ];
  return png(
    640,
    360,
    [246, 244, 239],
    [
      ...bars.map(([x, w, i]) => ({
        x: x + (520 - w) / 2,
        y: 40 + i * 76,
        w,
        h: 56,
        color: [63, 111, 216] as [number, number, number],
        r: 8,
      })),
    ]
  );
}

export function blocksMessages(now: number, attach: Attach): AgentMessage[] {
  const out: AgentMessage[] = [];
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const say = (minutesAgo: number, text: string) =>
    out.push({ id: `${ID}_${out.length}`, agentId: ID, ts: at(minutesAgo), kind: 'user', text });
  const show = (
    minutesAgo: number,
    intro: string,
    items: Block[],
    extra: Partial<AgentMessage> = {}
  ) => {
    const id = `${ID}_${out.length}`;
    out.push({
      id,
      agentId: ID,
      ts: at(minutesAgo),
      kind: 'agent',
      text: [intro, ...items.map((b) => b.summary)].filter(Boolean).join('\n\n'),
      blocks: { v: 1, ...(intro ? { intro } : {}), items },
      ...extra,
    });
    return id;
  };

  say(60, 'How did signups do this week?');
  show(59, 'Signups are up **18%** on last week, mostly from Thursday’s launch post.', [
    {
      kind: 'metrics',
      summary:
        '- Signups: 1,284 (+18% vs last week)\n- Trials started: 312 (+6%)\n- Churn: 2.1% (+0.4%)',
      items: [
        {
          label: 'Signups',
          value: 1284,
          delta: '+18%',
          vs: 'vs last week',
          trend: [140, 152, 149, 171, 260, 214, 198],
        },
        { label: 'Trials started', value: 312, delta: '+6%', vs: 'vs last week' },
        {
          label: 'Churn',
          value: 2.1,
          suffix: '%',
          delta: '+0.4%',
          good: 'down',
          vs: 'vs last week',
        },
        { label: 'Revenue', value: 48250, prefix: '$', delta: 3100, vs: 'vs last week' },
      ],
    },
    {
      kind: 'chart',
      chart: 'line',
      title: 'Signups per day',
      summary: 'Signups per day (line chart, Mon to Sun)',
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      series: [
        { name: 'This week', values: [140, 152, 149, 171, 260, 214, 198] },
        { name: 'Last week', values: [128, 131, 140, 138, 152, 120, 116] },
      ],
      axis: 'Signups',
    },
  ]);
  say(50, 'Break it down by channel');
  show(49, '', [
    {
      kind: 'chart',
      chart: 'bar',
      stacked: true,
      title: 'Signups by channel',
      summary: 'Signups by channel (bar chart, Mon to Sun)',
      labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      series: [
        { name: 'Search', values: [70, 72, 69, 80, 90, 84, 80] },
        { name: 'Social', values: [40, 50, 48, 61, 130, 92, 78] },
        { name: 'Direct', values: [30, 30, 32, 30, 40, 38, 40] },
      ],
    },
    {
      kind: 'chart',
      chart: 'donut',
      title: 'Where they came from',
      summary: 'Where they came from (donut chart)',
      labels: ['Search', 'Social', 'Direct', 'Referral'],
      series: [{ name: 'Signups', values: [545, 499, 240, 81] }],
    },
  ]);
  say(40, 'Which invoices are still open?');
  show(39, 'Seven open, **$18,940** in all. Two are past due.', [
    {
      kind: 'table',
      title: 'Open invoices',
      summary: 'Open invoices (10 rows)',
      columns: [
        { label: 'Client' },
        { label: 'Amount', numeric: true, prefix: '$' },
        { label: 'Due' },
        { label: 'Days late', numeric: true },
      ],
      rows: [
        ['Acme Co.', 4200, 'Nov 2', 7],
        ['Globex', 1890.5, 'Nov 5', 4],
        ['Initech', 3100, 'Nov 14', null],
        ['Umbrella', 980, 'Nov 15', null],
        ['Hooli', 5400, 'Nov 20', null],
        ['Stark Industries', 2120, 'Nov 22', null],
        ['Wayne Enterprises', 1250, 'Nov 30', null],
        ['Soylent', 640, 'Dec 1', null],
        ['Vandelay', 310, 'Dec 3', null],
        ['Tyrell', 2875, 'Dec 6', null],
      ],
    },
    {
      kind: 'facts',
      title: 'Acme Co.',
      summary: 'Acme Co.',
      items: [
        { label: 'Contact', value: 'Dana Whitfield' },
        { label: 'Terms', value: 'Net 30' },
        { label: 'Last paid', value: 'Oct 3, $3,900' },
        { label: 'Reminder', value: 'Sent Nov 6, no reply' },
      ],
    },
  ]);
  say(30, 'Where are we on the launch?');
  show(29, '', [
    {
      kind: 'checklist',
      title: 'Launch checklist',
      summary: 'Launch checklist',
      items: [
        { text: 'Domain points at the new site', done: true },
        { text: 'SSL certificate issued', done: true },
        { text: 'Pricing page copy approved', done: false, note: 'Waiting on you' },
        { text: 'Analytics events firing', done: true },
        { text: 'Announcement email scheduled', done: false },
      ],
    },
    {
      kind: 'steps',
      title: 'Moving the site',
      summary: 'Moving the site',
      items: [
        { title: 'Copy the pages over', status: 'done', when: 'Mon' },
        { title: 'Check every page against the old one', status: 'done', when: 'Tue' },
        {
          title: 'Switch the domain',
          status: 'current',
          detail: 'DNS can take up to an hour to settle.',
        },
        {
          title: 'Redirect the old blog links',
          status: 'failed',
          detail: '12 of 140 links still 404.',
        },
        { title: 'Turn the old site off', status: 'todo' },
      ],
    },
  ]);
  const funnelId = `${ID}_${out.length}`;
  const funnel = attach(ID, funnelId, 'funnel.png', 'image/png', funnelPng());
  show(
    25,
    'A few things from the review:',
    [
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Prices change Monday',
        summary: 'Warning: Prices change Monday.',
        text: 'Stripe will charge the new Pro price from Monday. Anyone on the old plan keeps it until renewal.',
      },
      {
        kind: 'callout',
        tone: 'success',
        summary: 'Done: backups verified.',
        text: 'Last night’s backup restored cleanly to a scratch database.',
      },
      {
        kind: 'links',
        title: 'Sources',
        summary: 'Sources',
        items: [
          {
            url: 'https://stripe.com/docs/billing/prices',
            label: 'Changing prices',
            domain: 'stripe.com',
            note: 'Billing docs',
          },
          {
            url: 'https://www.example.com/blog/launch',
            label: 'Our launch post',
            domain: 'example.com',
          },
        ],
      },
      {
        kind: 'code',
        language: 'diff',
        title: 'pricing.json',
        summary: 'pricing.json',
        code: '  "pro": {\n-   "monthly": 29,\n+   "monthly": 34,\n    "yearly": 290\n  }',
      },
      {
        kind: 'image',
        file: funnel,
        caption: 'Trial to paid, last 30 days',
        summary: 'Image: Trial to paid, last 30 days (funnel.png)',
      },
    ],
    { attachments: [funnel] }
  );
  say(20, 'Should we move hosting?');
  show(19, 'Three that fit. I’d go with Vercel: the previews alone save you a day a month.', [
    {
      kind: 'comparison',
      summary: 'Vercel, Netlify or Cloudflare Pages',
      options: [
        {
          name: 'Vercel',
          summary: 'Built for Next.js; what the site runs on now.',
          pros: ['Preview for every branch', 'Zero config for this repo'],
          cons: ['$20 a seat'],
          facts: [
            { label: 'Cost', value: '$40/mo' },
            { label: 'Move', value: '1 hour' },
          ],
          recommended: true,
          reply: 'Let’s go with Vercel.',
        },
        {
          name: 'Netlify',
          pros: ['Forms built in'],
          cons: ['Next.js support lags', 'Slower builds'],
          facts: [
            { label: 'Cost', value: '$19/mo' },
            { label: 'Move', value: '1 day' },
          ],
          reply: 'Let’s go with Netlify.',
        },
        {
          name: 'Cloudflare Pages',
          pros: ['Cheapest at scale'],
          cons: ['Needs an adapter', 'Image work moves'],
          facts: [
            { label: 'Cost', value: '$5/mo' },
            { label: 'Move', value: '2–3 days' },
          ],
          reply: 'Let’s go with Cloudflare Pages.',
        },
      ],
    },
  ]);
  say(15, 'Let’s go with Vercel.');
  show(14, 'Good. When should I move it?', [
    {
      kind: 'choices',
      summary: '“This weekend” / “Next weekend” / “Tonight”',
      options: [
        { label: 'This weekend', reply: 'This weekend.' },
        { label: 'Next weekend', reply: 'Next weekend.' },
        { label: 'Tonight, after 10', reply: 'Tonight, after 10.' },
      ],
    },
    {
      kind: 'form',
      title: 'Book the move',
      submit: 'Book it',
      summary: 'Book the move — please reply with: Who to tell, Plan, Seats, Notes',
      fields: [
        {
          id: 'who',
          label: 'Who to tell',
          type: 'text',
          required: true,
          placeholder: 'Names or emails',
        },
        {
          id: 'plan',
          label: 'Plan',
          type: 'choice',
          options: ['Pro', 'Team', 'Enterprise'],
          required: true,
        },
        { id: 'seats', label: 'Seats', type: 'number', placeholder: 'How many' },
        { id: 'day', label: 'Start on', type: 'date' },
        { id: 'notes', label: 'Anything else', type: 'long_text' },
      ],
    },
  ]);
  return out;
}

/**
 * "Brief" (hidden, `/chat/brief`): the morning brief as `brief::compose_blocks`
 * builds it, under a short exchange from yesterday, so qa:web sees the brief
 * as the phone draws it.
 */
export function briefMessages(now: number): AgentMessage[] {
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const clock = (h: number, m = 0) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };
  const gist =
    'Morning brief, Tuesday 10 November: 2 cards wait for you, 1 thing didn’t work, 4 routines today, 3 agents worked.';
  const items: Block[] = [
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
        [clock(9), 'Finance', 'Sweep the invoices inbox (every 2 hours)'],
        [
          clock(10, 30),
          'Research',
          'Read what’s new on AI agents and write up the three that matter',
        ],
        [clock(14), 'Acme Site', 'Check staging for broken links'],
        [clock(17), 'Lead Gen', 'Find 10 new studios in Lisbon (weekdays)'],
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
  const msg = (id: number, minutesAgo: number, kind: 'user' | 'agent', text: string) => ({
    id: `brief_${id}`,
    agentId: 'brief',
    ts: at(minutesAgo),
    kind,
    text,
  });
  return [
    msg(0, 20 * 60, 'user', 'Morning. What’s on fire?'),
    msg(
      1,
      20 * 60 - 1,
      'agent',
      'Nothing’s on fire. Lead Gen wants your OK on the first of 12 emails.'
    ),
    {
      ...msg(2, 4, 'agent', [gist, ...items.map((b) => b.summary)].join('\n\n')),
      blocks: { v: 1, intro: gist, items },
    },
  ];
}
