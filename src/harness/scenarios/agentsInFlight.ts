/**
 * What's in flight as a board ordered by attention (docs/design/in-flight-board-2026-11-10.md):
 * twenty agents, with nothing, one or five needing you (an email to send, a
 * login, a step-in, a session's question, a failed turn), three working,
 * three unread results, one paused by a usage limit, the rest idle. And the
 * same board at a narrow window. Fictional team. Capture with `--theme light` too.
 */

import type { Scenario } from '../types';
import { MIN, agent, msg, now, overview, status } from './agents';
import { GMAIL_LOGIN } from './agentsLogins';

const COLORS = [
  'purple',
  'green',
  'orange',
  'teal',
  'amber',
  'pink',
  'red',
  'blue',
  'brown',
  'gray',
];

/** Twenty agents, the Chief first. Who needs you is laid over this. */
const ROSTER = [
  agent('chief', 'Chief of Staff', {
    isMain: true,
    pinned: true,
    color: 'white',
    colorway: 'graphite',
    icon: 'mogbot',
    minutesAgo: 3,
    role: 'Runs the other agents.',
    preview: 'Morning brief is posted. Two things wait on you.',
  }),
  ...[
    ['siteqa', 'Site QA', 'Checked 14 pages on staging; two forms fail on Safari.'],
    ['memberstack', 'Memberstack', 'Migrated 212 members to the new plan.'],
    ['recruiter', 'Recruiter', 'Three candidates replied overnight.'],
    ['finance', 'Finance', 'Two invoices are overdue: Northwind and Globex.'],
    ['acme', 'Acme Site', 'Pricing table fixed on mobile.'],
    ['inbox', 'Inbox', 'Nine new, two worth your time.'],
    ['research', 'Research', 'Two competitors changed pricing this month.'],
    ['travel', 'Travel', 'Your Lisbon hotel is confirmed for the 14th.'],
    ['books', 'Bookkeeping', 'October is reconciled against the bank.'],
    ['social', 'Social Posts', 'Three drafts for Thursday are ready.'],
    ['native', 'Native App', 'Build 42 is on TestFlight.'],
    ['support', 'Support', 'Answered 11 tickets; one refund needs a look.'],
    ['seo', 'SEO', 'The sitemap had 40 dead links; fixed in a branch.'],
    ['legal', 'Contracts', 'The Globex MSA redline is in your Drive.'],
    ['ops', 'Security & DevOps', 'Backups ran; nothing failed overnight.'],
    ['events', 'Events', 'The venue holds the 22nd until Friday.'],
    ['partners', 'Partnerships', 'Webflow replied: a call next week works.'],
    ['content', 'Blog', 'Outline for the pricing post is ready for you.'],
    ['analytics', 'Analytics', 'Signups up 18% week on week.'],
  ].map(([id, name, preview], i) =>
    agent(id, name, {
      color: COLORS[i % COLORS.length],
      minutesAgo: 30 + i * 47,
      role: '',
      preview,
    })
  ),
];

const at = (agentId: string) => ({ agentId });

/** What each agent needing you is asking for, and what its overview row says. */
const ASKS: Record<string, { lines: unknown[]; row: Record<string, unknown> }> = {
  siteqa: {
    row: {
      status: status('waiting', 'Waiting for your OK'),
      pendingApprovals: 1,
      preview: 'Needs your OK: Site QA needs to send the QA report',
    },
    lines: [
      msg('user', 'Send the QA report to the client when it’s done.', 30, at('siteqa')),
      msg('approval', '', 6, {
        ...at('siteqa'),
        approval: {
          requestId: 'iq-email',
          title: 'Send an email · Gmail',
          summary: 'Send the staging QA report to dana@northwind.example',
          detail:
            '{\n  "to": "dana@northwind.example",\n  "subject": "Staging QA: two Safari issues"\n}',
          status: 'pending',
          tool: 'mcp__gmail__send_email',
          input: { to: 'dana@northwind.example', subject: 'Staging QA: two Safari issues' },
        },
      }),
    ],
  },
  recruiter: {
    row: { pendingApprovals: 1, preview: 'Needs your OK: Recruiter needs your Gmail (work)' },
    lines: [
      msg('approval', '', 12, {
        ...at('recruiter'),
        approval: {
          requestId: 'iq-login',
          title: 'Gmail',
          detail: GMAIL_LOGIN.why,
          status: 'pending',
          login: GMAIL_LOGIN,
        },
      }),
    ],
  },
  finance: {
    row: {
      status: status('waiting', 'Waiting for you in its browser'),
      pendingApprovals: 1,
      preview: 'Needs you in its browser: approve the Microsoft sign-in',
    },
    lines: [
      msg('approval', '', 2, {
        ...at('finance'),
        approval: {
          requestId: 'iq-step',
          title: 'Finance needs you in its browser: approve the Microsoft sign-in on your phone',
          detail:
            'Its tab on login.microsoftonline.com opens on this Mac for you to do this yourself; Hand back when you’re done.',
          status: 'pending',
          stepIn: {
            reason: 'approve the Microsoft sign-in on your phone',
            site: 'login.microsoftonline.com',
            url: 'https://login.microsoftonline.com/common/oauth2/authorize',
            pageTitle: 'Verify your identity',
            tab: 2,
          },
        },
      }),
    ],
  },
  acme: {
    row: { pendingApprovals: 1, preview: 'Needs your OK: Do you want to make this edit?' },
    lines: [
      msg('approval', '', 20, {
        ...at('acme'),
        approval: {
          requestId: 'iq-prompt',
          title: 'Claude Code asks',
          detail: '',
          status: 'pending',
          prompt: {
            kind: 'permission',
            project: '/Users/demo/ShipStudio/acme-marketing',
            sessionId: 'pty-acme',
            tab: 1,
            question: 'Do you want to make this edit to PricingTable.tsx?',
            options: [
              { label: 'Yes', keys: ['1'], role: 'allow' },
              { label: 'No', keys: ['esc'], role: 'deny' },
            ],
            owner: { id: 'acme', name: 'Acme Site' },
            chats: ['acme'],
          },
        },
      }),
    ],
  },
  inbox: {
    row: {
      failure: { kind: 'other' },
      preview:
        "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online.",
    },
    lines: [
      msg('user', 'Sort this morning’s mail.', 41, at('inbox')),
      msg(
        'error',
        "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online.",
        40,
        { ...at('inbox'), failure: { kind: 'other' } }
      ),
    ],
  },
};

/** The order agents start needing you in: one needs Site QA, five needs all of these. */
const ASK_ORDER = ['siteqa', 'recruiter', 'finance', 'acme', 'inbox'];

const WORKING: Record<string, Record<string, unknown>> = {
  memberstack: { status: status('working', 'Thinking') },
  research: {
    status: { state: 'working', activity: 'Reading three pricing pages', since: now - 7 * MIN },
  },
  seo: {
    status: { state: 'working', activity: 'Running the link checker', since: now - 22 * MIN },
  },
};

const RESULT = (title: string, summary: string) => ({
  id: `r-${title}`,
  version: 1,
  title,
  summary,
  checked: ['Checked against the source'],
});

/** Finished and not read yet: two result cards and a plain reply. */
const UNREAD: Record<string, { lines: unknown[]; unread: number }> = {
  travel: {
    unread: 1,
    lines: [
      msg('agent', 'Lisbon is booked: hotel, trains and the dinner on the 15th.', 25, {
        ...at('travel'),
        result: RESULT('Lisbon trip, booked', 'Hotel, trains and dinner on the 15th.'),
      }),
    ],
  },
  books: {
    unread: 1,
    lines: [
      msg('agent', 'Every October invoice on one page, grouped by client.', 55, {
        ...at('books'),
        result: RESULT('October invoice summary', 'Every October invoice on one page.'),
      }),
    ],
  },
  social: {
    unread: 2,
    lines: [
      msg(
        'agent',
        'Three drafts for Thursday are ready: a launch thread, a carousel and a reply.',
        90,
        {
          ...at('social'),
        }
      ),
    ],
  },
};

const PAUSED = {
  native: { failure: { kind: 'usage_limit', resetsAt: now + 90 * MIN } },
};

/** The board with `needing` agents waiting on you, three working, three unread and one paused. */
function board(needing: number) {
  const asking = new Set(ASK_ORDER.slice(0, needing));
  const agents = ROSTER.map((a) => {
    if (asking.has(a.id)) return { ...a, ...ASKS[a.id].row };
    if (WORKING[a.id]) return { ...a, ...WORKING[a.id] };
    if (UNREAD[a.id]) return { ...a, unread: UNREAD[a.id].unread };
    if (a.id in PAUSED) return { ...a, ...PAUSED[a.id as keyof typeof PAUSED] };
    return a;
  });
  const lines = (args: Record<string, unknown>) => {
    const id = String(args.agentId);
    if (asking.has(id)) return ASKS[id].lines;
    if (UNREAD[id]) return UNREAD[id].lines;
    const a = ROSTER.find((r) => r.id === id);
    return a?.preview ? [msg('agent', String(a.preview), 60 * 5, at(id))] : [];
  };
  return {
    agents_overview: overview(agents),
    agents_messages: lines,
    agents_stop: true,
    agents_answer_approval: null,
  };
}

const LOOK =
  'Keys keep their look (colourway, legend, lit states) but the page is ordered by attention: Needs you first, Working now, Finished recently, then everyone else as a quieter grid of smaller keys, names only (the last line on hover or focus). Each heading carries its count. No wall of “…” previews. Answers are neutral, never accent.';

export const agentsInFlightScenarios: Scenario[] = [
  {
    id: 'agents-inflight-none',
    title: 'Agents — What’s in flight, twenty agents, nothing needs you',
    looksRightWhen: `${LOOK} Needs you says one calm line: “Nothing needs you”. Working now · 3 (Memberstack, Research, SEO) with their step and elapsed, a Stop on each. Finished recently · 3 (Lisbon trip, booked; October invoice summary; Social Posts’ reply), names in bold and lines in full ink (unread, as in the sidebar). Paused · 1 (Native App, until its reset). Everyone else · 13 as small keys.`,
    command: 'agents.team',
    requires: '.agents-team__column',
    viewport: { width: 1440, height: 1000 },
    commands: board(0),
  },
  {
    id: 'agents-inflight-one',
    title: 'Agents — What’s in flight, one agent needs you',
    looksRightWhen: `${LOOK} Needs you · 1: Site QA’s row with its key, “Send the staging QA report to dana@northwind.example” in plain words, and its card right there with Deny and a neutral Allow.`,
    command: 'agents.team',
    requires: '.agents-team .agent-approval',
    viewport: { width: 1440, height: 1000 },
    commands: board(1),
  },
  {
    id: 'agents-inflight-five',
    title: 'Agents — What’s in flight, five agents need you',
    looksRightWhen: `${LOOK} Needs you · 5, in the order they asked: the first two open with their cards (an email with Deny / Allow, a Gmail login with Not now / Use my browser), then one line each for Finance (“Needs you in its browser: …”, its name not repeated), Acme Site’s question and Inbox’s “Didn’t finish”, each with a chevron that opens its card in place; Open chat beside each. Working now is on screen without scrolling.`,
    command: 'agents.team',
    requires: '.agents-team .agent-approval',
    viewport: { width: 1440, height: 1100 },
    commands: board(5),
  },
  {
    id: 'agents-inflight-full',
    title: 'Agents — What’s in flight, five need you, the whole page',
    looksRightWhen: `${LOOK} The whole column at once (a tall window), to judge the balance between sections: Needs you leads and is the loudest, the grid at the foot is the quietest.`,
    command: 'agents.team',
    requires: '.agents-team .agent-approval',
    viewport: { width: 1440, height: 2600 },
    commands: board(5),
  },
  {
    id: 'agents-inflight-keys',
    title: 'Agents — What’s in flight, moving through it with the arrow keys',
    looksRightWhen: `${LOOK} The first row was focused, then End (the New agent socket), Up (the key above it in the grid) and Right: focus is a neutral ring on the next key along in Everyone else, scrolled into view, its last line in a tooltip.`,
    command: 'agents.team',
    requires: '.agents-board--quiet .agents-board__key:focus',
    viewport: { width: 1440, height: 1000 },
    afterCommand: [
      { focus: '.agents-team__row' },
      { key: 'End' },
      { key: 'ArrowUp' },
      { key: 'ArrowRight' },
    ],
    commands: board(1),
  },
  {
    id: 'agents-inflight-narrow',
    title: 'Agents — What’s in flight, five need you, a narrow window',
    looksRightWhen: `${LOOK} At 720px: no sidebar, the header switches agents; every section stacks, the cards’ buttons wrap rather than clip, and the grid keeps several small keys per row. No horizontal scroll.`,
    command: 'agents.team',
    requires: '.agents-team .agent-approval',
    viewport: { width: 720, height: 1100 },
    commands: board(5),
  },
];
