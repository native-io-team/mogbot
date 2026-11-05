/**
 * Agents mode: the Grok Bot-style chat. Populated with a believable team so
 * truncation, ordering, badges and the agent-to-agent lines are reviewable.
 */

import { emit } from '@tauri-apps/api/event';
import type { Scenario } from '../types';
import { workspaceCommands, WORKSPACE_PROJECT } from './workspace';
import { remoteStatus } from './remote';

export const MIN = 60_000;
const DEMO_HOME = '/harness/agents-demo';
export const now = Date.now();

/** Tomorrow at a local wall-clock time, so fixtures agree with their own "at 09:00". */
const tomorrowAt = (hour: number, minute = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

/** The first-run way into import: the sidebar note's link, or with no sidebar the Chief's starter. */
const IMPORT_STARTER =
  '.agents-import-nudge__action, .agents-list__import, .agent-chat__starters > button:last-child';

/** A reply Grok Bot might paste back: prose around two numbered blocks. */
const PASTED_REPLY = [
  'Here is everything, in two parts.',
  '',
  'Part 1 of 2',
  '```json',
  '{"source": "Grok Bot", "agents": [{"name": "Chief", "is_main": true, "role": "Runs my week"}]}',
  '```',
  '',
  'Part 2 of 2',
  '```json',
  '{"source": "Grok Bot", "agents": [{"name": "Finance"}, {"name": "Travel"}, {"name": "Inbox"}]}',
  '```',
].join('\n');

type PreviewRoutine = { when: string; what: string; schedule?: string; refused?: string };

/** One agent as `agents_import_paste_preview` describes it. */
const previewAgent = (
  name: string,
  role: string,
  color: string,
  routines: PreviewRoutine[] = [],
  over: { isMain?: boolean; existing?: boolean; memory?: string[]; instructions?: string } = {}
) => {
  const instructions =
    over.instructions ??
    `You are my ${name.toLowerCase()} agent. ${role}.\n\nKeep replies short, ask before spending money or sending anything on my behalf, and tell me when something needs a decision.`;
  const memory = over.memory ?? [
    'Prefers mornings for anything that needs focus',
    'Lives in Lisbon',
  ];
  return {
    name,
    role,
    isMain: over.isMain ?? false,
    existing: over.existing ?? false,
    instructionsChars: instructions.length,
    memoryLines: memory.length,
    routines,
    color,
    instructions,
    memory,
  };
};

const PASTE_PREVIEW = {
  source: 'Grok Bot',
  blocks: 2,
  agents: [
    previewAgent(
      'Chief',
      'Runs my week and keeps the others on track',
      'white',
      [
        {
          when: 'every weekday at 8am',
          what: 'Brief me on the day.',
          schedule: 'every weekday at 08:00',
        },
        {
          when: 'every sunday at 6pm',
          what: 'Plan the week with me.',
          schedule: 'every Sunday at 18:00',
        },
      ],
      {
        isMain: true,
        memory: [
          'Week starts Monday; protect Friday afternoons',
          'Partner is Ana; her birthday is 12 March',
          'Hates long meeting invites without an agenda',
        ],
      }
    ),
    previewAgent(
      'Finance',
      'Tracks spending, invoices and rent',
      'teal',
      [
        {
          when: 'whenever rent is due',
          what: 'Remind me to pay rent.',
          refused: 'Give it a day and a time.',
        },
      ],
      { existing: true }
    ),
    previewAgent('Travel', 'Books flights and hotels within my rules', 'blue'),
    previewAgent(
      'Inbox',
      'Triages email and drafts replies for me to send',
      'orange',
      [{ when: 'every 2 hours', what: 'Triage new email.', schedule: 'every 2 hours' }],
      { memory: [] }
    ),
  ],
  problems: [] as string[],
};

/** A big team: twelve agents, most with routines, two that can't be set. */
const LONG_PREVIEW = {
  source: 'Grok Bot',
  blocks: 3,
  agents: [
    PASTE_PREVIEW.agents[0],
    PASTE_PREVIEW.agents[1],
    ...(
      [
        ['Travel', 'Books flights and hotels within my rules', 'blue'],
        ['Inbox', 'Triages email and drafts replies for me to send', 'orange'],
        ['Health', 'Keeps my training plan and appointments', 'green'],
        ['Research', 'Digs into anything I ask and cites sources', 'purple'],
        ['Home', 'Bills, repairs and the cleaner’s schedule', 'brown'],
        ['Writing', 'Edits drafts in my voice', 'pink'],
        ['Investor Updates', 'Drafts the monthly update from the metrics', 'amber'],
        ['Hiring', 'Screens candidates and books interviews', 'red'],
        ['Reading List', 'Saves and summarises long reads for the weekend', 'gray'],
        ['Family', 'Birthdays, school dates and gifts', 'teal'],
      ] as const
    ).map(([name, role, color], i) =>
      previewAgent(
        name,
        role,
        color,
        i % 3 === 2
          ? [
              {
                when: 'when it feels right',
                what: 'Check in.',
                refused: 'Give it a day and a time.',
              },
            ]
          : [
              {
                when: 'every friday at 5pm',
                what: 'Weekly recap.',
                schedule: 'every Friday at 17:00',
              },
            ]
      )
    ),
  ],
  problems: [] as string[],
};

const IMPORTED = {
  created: ['Travel', 'Inbox'],
  updated: ['Chief of Staff', 'Finance'],
  skipped: [] as [string, string][],
  routinesSet: [
    {
      agent: 'Chief of Staff',
      when: 'every weekday at 8am',
      what: 'Brief me on the day.',
      detail: 'every weekday at 08:00',
    },
    {
      agent: 'Chief of Staff',
      when: 'every sunday at 6pm',
      what: 'Plan the week with me.',
      detail: 'every Sunday at 18:00',
    },
    { agent: 'Inbox', when: 'every 2 hours', what: 'Triage new email.', detail: 'every 2 hours' },
  ],
  routinesRefused: [] as { agent: string; when: string; what: string; detail: string }[],
};

/** The connector panel's way to the fallback: pasting a reply. */
const PASTE_LINK = '.agents-import__footer .agents-import__note button';

const IMPORT_BUTTON = '.agents-import__footer .button--strong:not(:disabled)';

/** One of the other app's agents as `agents_other_app_preview` describes it. */
const otherAgent = (
  sourceId: string,
  name: string,
  role: string,
  color: string,
  over: Record<string, unknown> = {}
) => ({
  sourceId,
  name,
  role,
  color,
  isMain: false,
  plan: 'new',
  instructions: `You are my ${name.toLowerCase()} agent. ${role}.\n\nAsk before spending money or sending anything on my behalf.`,
  memory: ['Prefers mornings for anything that needs focus', 'Lives in Lisbon'],
  messages: 31,
  attachments: 0,
  routines: [] as { schedule: string; what: string }[],
  secrets: [] as string[],
  rules: [] as string[],
  bytes: 2_400_000,
  projectMissing: false,
  ...over,
});

/** An import with Grok over the connector (`agents_import_talk`, a `connector::Gate`). */
const IMPORT_TALK = {
  id: 'talk1',
  source: 'Grok',
  chiefId: 'chief',
  state: 'interviewing',
  startedAt: now - 6 * MIN,
  lastAt: now - MIN,
  exchanges: 4,
  staged: ['Finance', 'Travel'],
  imported: [] as string[],
  busy: false,
};
export const gateWith = (talk: Record<string, unknown> | null, armed = false) => ({
  armed,
  talk: talk ? { ...IMPORT_TALK, ...talk } : null,
});

/** The other app on this Mac with a team of five: two new, the Chief to merge, one done, one blocked. */
const OTHER_APP_PREVIEW = {
  appName: 'Ship Studio',
  source: '/Users/you/ShipStudio/.shipstudio/agents',
  totalBytes: 9_600_000,
  sameVolume: true,
  freeBytes: 210_000_000_000,
  enoughSpace: true,
  agents: [
    otherAgent('c0', 'Chief of Staff', 'Runs the team', 'white', {
      isMain: true,
      plan: 'merge',
      messages: 214,
      memory: ['Lives in Lisbon', 'Has two cats', 'Prefers short replies'],
      routines: [{ schedule: 'every weekday at 08:00', what: 'Brief me on the day.' }],
      rules: ['npm test'],
    }),
    otherAgent('f1', 'Finance', 'Tracks spending and chases invoices', 'green', {
      messages: 86,
      attachments: 4,
      memory: ['Accountant is Sam', 'Invoices go out on the 1st', 'Reports in EUR'],
      routines: [
        { schedule: 'every 2 hours', what: 'Check for new invoices.' },
        { schedule: 'every Monday at 09:00', what: 'Send me last week’s spending.' },
      ],
      secrets: ['Stripe key', 'Bank login'],
      rules: ['git push', 'example-bank.com'],
      project: '/Users/you/ShipStudio/books',
    }),
    otherAgent('t1', 'Travel', 'Plans trips and keeps bookings straight', 'blue', {
      routines: [{ schedule: 'every Friday at 17:00', what: 'Check next week’s flights.' }],
    }),
    otherAgent('r1', 'Research', 'Reads so you don’t have to', 'purple', {
      plan: 'imported',
      reason: 'Already brought over.',
    }),
    otherAgent('i1', 'Inbox', 'Triage email', 'orange', {
      plan: 'skip',
      reason: 'You already have an agent called Inbox here. Rename one, then import again.',
    }),
  ],
};

export const status = (state: 'idle' | 'working' | 'waiting', activity: string | null = null) => ({
  state,
  activity,
  since: state === 'idle' ? null : now - 2 * MIN,
});

export const agent = (
  id: string,
  name: string,
  over: Record<string, unknown> & { minutesAgo?: number } = {}
) => {
  const { minutesAgo = 60, ...rest } = over;
  return {
    id,
    name,
    role: '',
    shape: 0,
    color: 'purple',
    isMain: false,
    pinned: false,
    hidden: false,
    sessionId: 'session',
    createdAt: now - 30 * 24 * 60 * MIN,
    lastActivityAt: now - minutesAgo * MIN,
    preview: null,
    unread: 0,
    pendingApprovals: 0,
    engine: 'claude' as 'claude' | 'codex',
    model: null as string | null,
    muted: false,
    status: status('idle'),
    // Served by the harness's dev server, so attachment images load over HTTP.
    home: DEMO_HOME,
    ...rest,
  };
};

export const TEAM = [
  agent('chief', 'Chief of Staff', {
    isMain: true,
    // Created pinned: the one agent you're told to talk to doesn't move.
    pinned: true,
    shape: 5,
    color: 'white',
    minutesAgo: 3,
    role: 'Runs the other agents and keeps track of what’s in flight.',
    preview: 'Acme’s staging deploy is green. Want me to have Acme Site open the PR?',
  }),
  agent('acme', 'Acme Site', {
    shape: 0,
    color: 'green',
    minutesAgo: 4,
    role: 'Owns the Acme marketing site rebuild in ~/ShipStudio/acme-marketing.',
    status: status('working', 'Editing PricingTable.tsx'),
    preview: 'Fixing the pricing table on mobile now.',
  }),
  agent('finance', 'Finance', {
    shape: 1,
    color: 'orange',
    minutesAgo: 40,
    unread: 2,
    checkIns: [
      {
        id: 'ci1',
        note: 'See whether Northwind paid the $4,200 invoice; if not, draft a firmer reminder.',
        nextAt: tomorrowAt(9),
        createdAt: now - 60 * MIN,
        paused: false,
      },
      {
        id: 'ci2',
        note: 'Brief me on what came in and went out yesterday, and anything overdue.',
        repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
        nextAt: tomorrowAt(9),
        createdAt: now - 7 * 24 * 60 * MIN,
        paused: false,
      },
      {
        id: 'ci3',
        note: 'Reconcile the month against the bank export.',
        repeat: { kind: 'days', days: [1], hour: 8, minute: 30 },
        nextAt: now + 5 * 24 * 60 * MIN,
        createdAt: now - 30 * 24 * 60 * MIN,
        paused: true,
      },
    ],
    role: 'Invoices, expenses and the books.',
    preview: 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).',
  }),
  agent('leadgen', 'Lead Gen', {
    shape: 8,
    color: 'teal',
    minutesAgo: 90,
    role: 'Finds and qualifies agency leads.',
    status: status('waiting', 'Waiting for your OK'),
    preview: 'Needs your OK: Send an email · Gmail',
  }),
  agent('native', 'Native App', {
    shape: 2,
    color: 'amber',
    minutesAgo: 180,
    pinned: true,
    role: 'The Expo app: builds, TestFlight, store listings.',
    preview: 'Build 42 is on TestFlight.',
  }),
  agent('hiring', 'Hiring', {
    shape: 9,
    color: 'pink',
    minutesAgo: 60 * 26,
    role: 'Job posts, candidate screens and scheduling.',
    preview: 'Here are three replies you could send to Priya.',
  }),
  agent('social', 'Social Posts', {
    shape: 7,
    color: 'red',
    minutesAgo: 60 * 50,
    muted: true,
    role: 'Drafts posts in your voice. Never publishes.',
    preview: 'Three drafts for Thursday are ready.',
  }),
  agent('clients', 'Client Sites QA', {
    shape: 11,
    color: 'blue',
    minutesAgo: 60 * 72,
    hidden: true,
    role: 'Weekly QA across client sites.',
    preview: 'The three QA fixes are done and pushed to branches.',
  }),
];

let n = 0;
export const msg = (
  kind: string,
  text: string,
  minutesAgo: number,
  over: Record<string, unknown> = {}
) => ({
  id: `m${++n}`,
  agentId: 'chief',
  ts: now - minutesAgo * MIN,
  kind,
  text,
  ...over,
});

/**
 * Grok's side is `from_agent` with a `connector:` peer, and the sealed
 * interview's replies are `sent_to_agent` to the same peer, as
 * `agents/connector.rs` records them.
 */
const GROK = { peer: { id: 'connector:Grok', name: 'Grok' } };

/** The consent card (`connector::ask_consent`). */
const consentCard = (status: 'pending' | 'allowed') =>
  msg('approval', '', 7, {
    approval: {
      requestId: 'consent1',
      title: 'Grok wants to bring its agents over',
      detail:
        'It will talk to a separate, sealed conversation that can only stage agents for you to review. It can’t see your chats, files or other agents, and nothing is created until you import.\n\nIts first message: “Hi, I’m Grok. I run three agents for Sam: Main (manages the others), Finance (spending and invoices) and Travel (trips and bookings).”',
      status,
      connector: { kind: 'consent', talkId: 'talk1', source: 'Grok' },
    },
  });
const CONSENT_CARD = consentCard('pending');

const IMPORT_TALK_CHAT = [
  consentCard('allowed'),
  msg(
    'note',
    'Grok is talking to a separate, sealed conversation, not this chat. Nothing is created until you review it. Stop it any time.',
    6
  ),
  msg(
    'from_agent',
    'Hi, I’m Grok. I run three agents for Sam: **Main** (manages the others), **Finance** (spending and invoices) and **Travel** (trips and bookings).',
    6,
    GROK
  ),
  msg(
    'sent_to_agent',
    'Thanks, Grok. Let’s start with Finance: its full instructions as you were briefed, what it remembers about Sam, its routines with when they run, and the logins it relies on (names only).',
    5,
    GROK
  ),
  msg(
    'from_agent',
    'Finance instructions: “Track every expense in the books sheet, chase invoices after 14 days, ask before paying anything.” It remembers: accountant is Lena; invoices go out on the 1st; reports in EUR. Routines: every weekday at 9am, check for new invoices. Logins: Stripe, the bank. More on it [in my docs](https://example.com/finance). <img src="https://example.com/pixel.png">',
    3,
    GROK
  ),
  msg(
    'sent_to_agent',
    'Finance is staged for Sam’s review, routine paused, Stripe and the bank as logins Sam enters here. Now Travel: same four things, please.',
    2,
    GROK
  ),
  msg(
    'from_agent',
    'Travel instructions: “Plan trips door to door, prefer trains under 4 hours, aisle seats.” It remembers: passport renewal due March; loyalty with TAP. Routines: every Friday at 5pm, check next week’s flights. No logins.',
    1,
    GROK
  ),
];

/** The review card (`connector::post_review`): Finance clashes with yours, Travel is new. */
export const REVIEW = {
  proposals: [
    {
      key: 'p1',
      name: 'Finance',
      role: 'Tracks spending and chases invoices',
      instructions:
        'Track every expense in the books sheet.\nChase invoices after 14 days.\nAsk before paying anything.',
      memory: '- Accountant is Lena\n- Invoices go out on the 1st\n- Reports in EUR',
      routines: [
        {
          when: 'every weekday at 9am',
          what: 'Check for new invoices',
          schedule: 'every weekday at 09:00',
        },
      ],
      logins: [
        { name: 'stripe_key', purpose: 'Reads invoices and payouts', kind: 'api_key' },
        { name: 'bank_login', purpose: 'Reads statements', kind: 'password' },
      ],
      clash: {
        agentId: 'finance',
        name: 'Finance',
        role: 'Keeps the books',
        instructions:
          'Keep the books in the shared sheet.\nChase invoices after 14 days.\nAsk before paying anything.',
        logins: ['STRIPE_KEY', 'GITHUB_TOKEN'],
        project: '/Users/sam/ShipStudio/acme-site',
        activeRoutines: 2,
        rules: 3,
        conversation: true,
      },
    },
    {
      key: 'p2',
      name: 'Travel',
      role: 'Trips and bookings',
      instructions: 'Plan trips door to door.\nPrefer trains under 4 hours, aisle seats.',
      memory: '- Passport renewal due March\n- Loyalty with TAP',
      routines: [
        {
          when: 'every friday at 5pm',
          what: 'Check next week’s flights',
          schedule: 'every Friday at 17:00',
        },
      ],
      logins: [],
    },
  ],
  chiefNotes: '- Sam prefers short replies\n- Mornings are for focus work',
  summary: 'Two agents: Finance and Travel. Main manages them; its notes are offered to you.',
};

export const REVIEW_CARD = (status = 'pending', choice?: string) =>
  msg('approval', '', 0, {
    approval: {
      requestId: 'review1',
      title: 'Bring in 2 agents from Grok',
      detail:
        "Finance · Tracks spending and chases invoices\nTravel · Trips and bookings\nReview on your Mac: each agent's instructions are shown there, and nothing is created until you import them.",
      status,
      choice,
      connector: { kind: 'review', talkId: 'talk1', source: 'Grok', review: REVIEW },
    },
  });

export const REVIEW_CHAT = [
  ...IMPORT_TALK_CHAT,
  msg(
    'sent_to_agent',
    'Both are staged. Sam is reviewing them now; nothing is created until Sam presses Import.',
    0,
    GROK
  ),
];

const CHIEF_CHAT = [
  msg('user', 'Morning. What’s on fire?', 190),
  msg(
    'agent',
    'Nothing’s on fire. Three things need you today:\n\n1. **Finance** found two overdue invoices, $5,350 total. It has reminder emails drafted.\n2. **Acme Site** is fixing the pricing table on mobile; the client flagged it yesterday.\n3. **Lead Gen** wants to email 12 new leads and is waiting for your OK on the first one.',
    189
  ),
  msg(
    'user',
    'Get @Acme Site to also check the footer links, the client said a couple are dead.',
    70,
    {
      mentions: [{ id: 'acme', name: 'Acme Site' }],
    }
  ),
  msg('agent', 'On it. I’ve added the footer to Acme Site’s list.', 69),
  msg(
    'sent_to_agent',
    'The client also says a couple of footer links are dead. Check every footer link on staging, fix what’s broken, and include it in the same PR as the pricing table.',
    69,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg(
    'from_agent',
    'Two dead links: /careers (page was removed) and the old Twitter URL. Fixed both on the pricing branch. Staging deploy is building.',
    12,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg('sent_to_agent', 'Good. Tell me when staging is green.', 11, {
    peer: { id: 'acme', name: 'Acme Site' },
  }),
  msg(
    'from_agent',
    'Staging is green: [acme-staging.vercel.app](https://example.com). Pricing table checked at 375px and 768px.',
    4,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
  msg(
    'agent',
    'Acme’s staging deploy is green, with the pricing table fixed on mobile and the two dead footer links (`/careers` and the old Twitter URL) repaired. Want me to have Acme Site open the PR?',
    3
  ),
];

const LEADGEN_CHAT = [
  msg('user', 'Send the intro email to the new leads from this morning.', 15, {
    agentId: 'leadgen',
  }),
  msg('agent', 'Starting with Northwind Studio. Here’s the first one for your OK.', 14, {
    agentId: 'leadgen',
  }),
  msg('approval', '', 14, {
    agentId: 'leadgen',
    approval: {
      requestId: 'req-1',
      title: 'Send an email · Gmail',
      detail:
        '{\n  "to": "hello@northwind.example",\n  "subject": "Your site, faster",\n  "body": "Hi Sam — I build marketing sites for studios like yours…"\n}',
      status: 'pending',
      tool: 'mcp__gmail__send_email',
      input: {
        to: 'hello@northwind.example',
        subject: 'Your site, faster',
        body: 'Hi Sam — I build marketing sites for studios like yours…',
      },
    },
  }),
];

const FINANCE_CHAT = [
  msg('user', 'Chase Northwind if they haven’t paid by tomorrow.', 70, { agentId: 'finance' }),
  msg(
    'agent',
    'Will do. I’ll check back tomorrow at 9:00 and draft a firmer reminder if it’s still open.',
    69,
    { agentId: 'finance' }
  ),
  msg('user', 'What’s outstanding this month?', 60, { agentId: 'finance' }),
  msg(
    'agent',
    [
      'Two invoices are overdue:',
      '',
      '| Client | Amount | Days late |',
      '| --- | --- | --- |',
      '| Northwind | $4,200 | 18 |',
      '| Globex | $1,150 | 6 |',
      '',
      '> Northwind said last week the payment was “in the next run”.',
      '',
      'The reminder I drafted uses your usual template:',
      '',
      '```',
      'Hi Sam, a quick nudge on invoice #1042 ($4,200), due Oct 17.',
      'Let me know if anything is holding it up.',
      '```',
      '',
      '---',
      '',
      '#### Next',
      '- Send both reminders',
      '- Re-check on Friday',
    ].join('\n'),
    45,
    { agentId: 'finance' }
  ),
  msg('check_in', 'Brief me on what came in and went out yesterday, and anything overdue.', 41, {
    agentId: 'finance',
    checkIn: { dueAt: tomorrowAt(9) - 24 * 60 * MIN, late: true, repeats: false },
  }),
  msg(
    'agent',
    'Two invoices are overdue: **Northwind** ($4,200, 9 days) and **Globex** ($1,150, 3 days). Nothing else needs you.',
    40,
    { agentId: 'finance' }
  ),
];

/** Finance's `## Memory`, as `agents_memory` reads it. */
const MEMORY = [
  { text: 'Julian’s accountant is Sam Ortiz (sam@ortiz.co).' },
  { text: 'Invoices go out on the 1st,\nnever on weekends.' },
  { text: 'Reports in EUR unless a client is billed in USD.' },
  { text: 'Lives in Lisbon', group: 'Imported from Grok Bot' },
  { text: 'Prefers mornings for anything that needs focus', group: 'Imported from Grok Bot' },
];

/** The weekday brief with a week of runs behind it and a retry pending. */
const WITH_HISTORY = (() => {
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  const day = 24 * 60 * MIN;
  const at = nine.getTime() > now ? nine.getTime() - day : nine.getTime();
  const retryAt = now + 4 * MIN;
  /** `k` days before `at`, same wall-clock time across DST. */
  const daysBack = (k: number) => {
    const d = new Date(at);
    d.setDate(d.getDate() - k);
    return d.getTime();
  };
  const runs = [
    { at: daysBack(6), outcome: 'ran', attempt: 1 },
    { at: daysBack(5), outcome: 'ran', attempt: 2 },
    {
      at: daysBack(2),
      outcome: 'failed',
      attempt: 1,
      detail: 'Claude Code is signed out.',
      signIn: ['Gmail'],
    },
    { at: daysBack(1), outcome: 'ran', attempt: 1 },
    {
      at,
      outcome: 'retrying',
      attempt: 1,
      detail: 'API Error: 529 overloaded',
      retryAt,
    },
  ];
  return [
    {
      id: 'ci2',
      note: 'Brief me on what came in and went out yesterday, and anything overdue.',
      repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
      nextAt: at + day,
      createdAt: now - 7 * day,
      paused: false,
      runs,
      retry: { at: retryAt, attempts: 1, firstFailedAt: at, dueAt: at },
    },
    {
      id: 'ci3',
      note: 'Reconcile the month against the bank export.',
      repeat: { kind: 'days', days: [1], hour: 8, minute: 30 },
      nextAt: now + 5 * day,
      createdAt: now - 30 * day,
      paused: true,
    },
  ];
})();

const shot = (name: string, size: number) => ({
  name,
  path: `attachments/m-att1/${name}`,
  mime: 'image/jpeg',
  size,
});

const ACME_CHAT = [
  msg(
    'user',
    'The client sent these. The pricing cards overlap on mobile and two footer links 404.',
    50,
    {
      agentId: 'acme',
      attachments: [
        shot('Pricing on mobile.jpg', 40_266),
        shot('Footer links.jpg', 36_471),
        shot('Hero crop.jpg', 27_238),
      ],
    }
  ),
  msg(
    'agent',
    'Got them. The cards overlap below 400px because the grid keeps three columns; I’ll stack them. Checking the footer next.',
    49,
    { agentId: 'acme' }
  ),
  msg(
    'user',
    '> The cards overlap below 400px because the grid keeps three columns\n\nStack them below 640px too. The tablet layout breaks the same way.',
    48,
    { agentId: 'acme' }
  ),
  msg('user', '', 20, {
    agentId: 'acme',
    attachments: [
      {
        name: 'Acme brand guidelines 2026.pdf',
        path: 'attachments/m-att2/Acme brand guidelines 2026.pdf',
        mime: 'application/pdf',
        size: 4_812_330,
      },
      {
        name: 'footer-links.csv',
        path: 'attachments/m-att2/footer-links.csv',
        mime: 'text/csv',
        size: 2_140,
      },
    ],
  }),
  msg(
    'agent',
    'Read both. The guidelines want 24px gutters on mobile, so the stacked cards use that. The CSV lists 31 links; **2 are dead**: `/careers` and the old Twitter URL.\n\nFixing them on the pricing branch.',
    19,
    { agentId: 'acme' }
  ),
];

/**
 * What Acme Site handed back with `share_file`: a caption and a PDF, a CSV on
 * its own, a screenshot (shown inline), then prose naming paths on disk,
 * which render as links that open the file.
 */
const shared = (id: string, name: string, mime: string, size: number, path?: string) => ({
  name,
  path: path ?? `attachments/${id}/${name}`,
  mime,
  size,
});
const ACME_SHARED = [
  msg('user', 'Can you send me the QA report and the fixed hero?', 12, { agentId: 'acme' }),
  msg('agent', 'QA report for the pricing branch: 31 links checked, 2 fixed.', 11, {
    agentId: 'acme',
    attachments: [shared('m-s1', 'Acme QA report.pdf', 'application/pdf', 1_284_400)],
  }),
  msg('agent', '', 11, {
    agentId: 'acme',
    attachments: [shared('m-s2', 'footer-links-checked.csv', 'text/csv', 2_480)],
  }),
  msg('agent', 'The hero at 375px, after the fix.', 10, {
    agentId: 'acme',
    attachments: [
      shared('m-s3', 'Hero at 375px.jpg', 'image/jpeg', 27_238, 'attachments/m-att1/Hero crop.jpg'),
    ],
  }),
  msg(
    'agent',
    'Both are also in the project: the report is at ~/ShipStudio/acme-marketing/qa/report.md and the raw crawl is `~/ShipStudio/acme-marketing/qa/crawl 2026-11-04.json`. The `/careers` route now redirects.',
    9,
    { agentId: 'acme' }
  ),
];

/** The Files list for Acme Site: both directions, newest first. */
type Shared = ReturnType<typeof shared>;
const filesOf = (messages: Record<string, unknown>[], from: 'user' | 'agent') =>
  messages.flatMap((m) =>
    ((m.attachments as Shared[] | undefined) ?? []).map((a) => ({
      ...a,
      messageId: m.id,
      ts: m.ts as number,
      from,
    }))
  );
const ACME_FILES = [...filesOf(ACME_SHARED, 'agent'), ...filesOf(ACME_CHAT, 'user')].sort(
  (a, b) => b.ts - a.ts
);

const withShared = (args: Record<string, unknown>) =>
  args.agentId === 'acme' ? [...ACME_CHAT, ...ACME_SHARED] : messagesFor(args);

/** What the paperclip "picks" in the harness, and what the backend says about it. */
const PICKED = [
  `${DEMO_HOME}/attachments/m-att1/Pricing on mobile.jpg`,
  '/Users/harness/Desktop/QA notes from the client call.md',
];
const inspectFiles = (args: Record<string, unknown>) =>
  (args.paths as string[]).map((path) => {
    const name = path.split('/').pop() ?? path;
    const image = name.endsWith('.jpg');
    return {
      path,
      name,
      mime: image ? 'image/jpeg' : 'text/markdown',
      size: image ? 40_266 : 6_220,
    };
  });
const schedulePreview = (args: Record<string, unknown>) => {
  const when = String(args.when).toLowerCase();
  // The picker's words (routine-phrases.json): "every 2 hours", "2026-11-20 09:00".
  const hours = /^every (?:(\d+) )?(hour|hours|minutes)$/.exec(when);
  if (hours) {
    const n = Number(hours[1] ?? 1);
    const minutes = hours[2] === 'minutes' ? n : n * 60;
    return { nextAt: Date.now() + minutes * 60_000, repeat: { kind: 'every', minutes } };
  }
  const once = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(when);
  if (once) {
    const [, y, m, d, h, min] = once.map(Number);
    return { nextAt: new Date(y, m - 1, d, h, min).getTime(), repeat: null };
  }
  if (when.startsWith('every'))
    return {
      nextAt: tomorrowAt(9),
      repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    };
  if (when.includes('tomorrow')) return { nextAt: tomorrowAt(9), repeat: null };
  throw new Error('Give it a day and a time.');
};

/** Both engines here and signed in, each with its own models (`engine::EngineInfo`). */
export const ENGINES = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
    asks: true,
    models: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    installed: true,
    signedIn: true,
    asks: true,
    models: [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
    ],
  },
];

export const overview = (agents = TEAM, engineReady = true) => ({
  agents,
  engineReady,
  engines: ENGINES,
});

/** Research runs on Codex: same chat, its own model in the header. */
const CODEX_TEAM = [
  ...TEAM,
  agent('research', 'Research', {
    engine: 'codex',
    model: 'gpt-5.5',
    color: 'teal',
    shape: 9,
    minutesAgo: 1,
    role: 'Competitor and market research',
    preview: 'Three of the five now list annual pricing first.',
    status: status('working', '$ rg -l "annual" pricing/'),
    capabilities: {
      seenAt: now,
      lines: [
        { what: 'The team', detail: 'Message the other agents.' },
        {
          what: 'On this Mac',
          detail:
            "Run commands, read and edit files, use the web, send you files and schedule routines, in Codex's sandbox: your projects and its own folder, with no network for commands unless you allow it.",
        },
      ],
    },
  }),
];

const CODEX_CHAT = [
  msg('note', 'Runs on Codex from its next message', 40, { agentId: 'research' }),
  msg('user', 'How do the five competitors on our list show pricing now?', 38, {
    agentId: 'research',
  }),
  msg(
    'agent',
    'Three of the five now list annual pricing first: Northwind, Fable and Linework. Basecamp-style flat pricing is gone from all of them. Halcyon still hides pricing behind a demo form.\n\nWant me to put the screenshots and the per-seat numbers in a sheet?',
    35,
    { agentId: 'research' }
  ),
  msg('user', 'Yes, and check whether any of them changed it this month.', 2, {
    agentId: 'research',
  }),
];

/**
 * Sending, so the motion of a send can be watched (and recorded) in the
 * harness: the message comes back as the backend's would, and for a few
 * seconds afterwards the overview reports that agent as the most recent and
 * working, so the next `agents_overview` moves its row to the top and shows
 * the typing indicator. Nothing replies; there is no event channel here.
 */
const SENT: Record<string, ReturnType<typeof msg>[]> = {};
let lastSend: { agentId: string; at: number } | null = null;

const sendMessage = (args: Record<string, unknown>) => {
  const agentId = String(args.agentId);
  // As the backend does: the mentioned agents, by the names they have now.
  const mentions = ((args.mentions as string[] | undefined) ?? []).flatMap((id) => {
    const found = TEAM.find((a) => a.id === id);
    return found ? [{ id, name: found.name }] : [];
  });
  const sent = { ...msg('user', String(args.text), 0, { agentId, mentions }), ts: Date.now() };
  (SENT[agentId] ??= []).push(sent);
  lastSend = { agentId, at: Date.now() };
  return sent;
};

const liveOverview = () => {
  const send = lastSend;
  if (!send) return overview();
  const working = Date.now() - send.at < 4000;
  return overview(
    TEAM.map((a) =>
      a.id === send.agentId
        ? {
            ...a,
            lastActivityAt: send.at,
            status: working ? status('working', 'Reading the message') : status('idle'),
          }
        : a
    )
  );
};

export const messagesFor = (args: Record<string, unknown>) => {
  const sent = SENT[String(args.agentId)] ?? [];
  if (args.agentId === 'chief') return [...CHIEF_CHAT, ...sent];
  if (args.agentId === 'leadgen') return [...LEADGEN_CHAT, ...sent];
  if (args.agentId === 'finance') return [...FINANCE_CHAT, ...sent];
  if (args.agentId === 'acme') return [...ACME_CHAT, ...sent];
  return sent;
};

/** Dictation mid-sentence: a partial in the draft, the meter at a speaking level. */
const startListening = () => {
  setTimeout(() => {
    void emit('dictation://event', {
      kind: 'partial',
      session: 1,
      text: 'Can you ask Finance to send the Northwind reminder',
    });
    void emit('dictation://event', { kind: 'level', session: 1, level: 0.55 });
  }, 50);
  return { status: 'listening', session: 1 };
};

/**
 * A reply streaming in, played the way the backend sends it: drafts every
 * 40ms carrying the text so far, then the finished message under the draft's
 * id, the working line ("Editing …") while a tool runs, and a second block.
 * Frozen (the default capture) it stops mid-way through the second block, so
 * the screenshot is deterministic; with `?freeze=off` it plays in real time.
 */
const STREAM_ASK = msg('user', 'Where are we on the Acme pricing fix?', 0);
const STREAM_BLOCKS = [
  'Checking with Acme Site now. The pricing cards were stacking at 400px but **not at tablet widths**, which is the bug the client saw.',
  'Fixed. The cards now stack below 640px, and the footer links point at the right pages:\n\n- `/careers` goes to the new jobs page\n- the old Twitter link is now the X profile\n\nStaging redeploys in a minute; I’ll send you the link.',
];
let streamStarted = false;

const playStream = () => {
  const frozen = document.documentElement.hasAttribute('data-harness-freeze');
  const at = (ms: number, fn: () => void) => (frozen ? fn() : void setTimeout(fn, ms));
  const working = (activity: string | null) =>
    void emit('agents://status', {
      agentId: 'chief',
      status: { state: 'working', activity, since: Date.now() },
    });
  // Real deltas are a word or three.
  const chunks = (text: string) =>
    text
      .match(/\S+\s*|\s+/g)
      ?.flatMap((w, i, all) => (i % 2 === 0 ? [w + (all[i + 1] ?? '')] : [])) ?? [text];
  let t = 600;
  STREAM_BLOCKS.forEach((block, b) => {
    const id = `stream-${b}`;
    const parts = chunks(block);
    const last = b === STREAM_BLOCKS.length - 1;
    // Frozen, the second block stops a little over halfway, still writing.
    const shown = frozen && last ? Math.ceil(parts.length * 0.6) : parts.length;
    let text = '';
    for (let i = 0; i < shown; i++) {
      text += parts[i];
      const draft = text;
      at((t += 45), () => void emit('agents://draft', { agentId: 'chief', id, text: draft }));
    }
    if (shown < parts.length) return;
    at((t += 60), () => {
      void emit('agents://message', {
        ...STREAM_ASK,
        id,
        ts: Date.now(),
        kind: 'agent',
        text: block,
      });
      if (!last) working('Editing PricingCards.tsx');
      else void emit('agents://status', { agentId: 'chief', status: status('idle') });
    });
    t += 1600;
  });
};

const streamMessages = () => {
  if (!streamStarted) {
    streamStarted = true;
    setTimeout(playStream, 300);
  }
  return [...CHIEF_CHAT, { ...STREAM_ASK, ts: Date.now() }];
};

/**
 * A plain scan like the backend's: every word, any case, newest first, with
 * the snippet cut around the first match.
 */
const searchFor = (args: Record<string, unknown>) => {
  const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
  const names: Record<string, [string, string]> = {
    chief: ['Chief of Staff', 'white'],
    leadgen: ['Lead Gen', 'teal'],
  };
  return [...CHIEF_CHAT, ...LEADGEN_CHAT]
    .filter((m) => m.kind !== 'approval' && words.every((w) => m.text.toLowerCase().includes(w)))
    .sort((a, b) => b.ts - a.ts)
    .map((m) => {
      const at = Math.max(0, m.text.toLowerCase().indexOf(words[0]) - 40);
      return {
        agentId: m.agentId,
        agentName: names[m.agentId][0],
        agentColor: names[m.agentId][1],
        messageId: m.id,
        ts: m.ts,
        kind: m.kind,
        peerName: (m as { peer?: { name: string } }).peer?.name,
        snippet:
          (at > 0 ? '…' : '') +
          m.text
            .replace(/\*\*|`/g, '')
            .replace(/\s+/g, ' ')
            .slice(at),
      };
    });
};

/** A usage limit that resets in two hours, as Claude Code reported it. */
const RESETS_AT = Math.ceil((now + 2 * 60 * MIN) / (15 * MIN)) * 15 * MIN;
const resetClock = new Date(RESETS_AT).toLocaleTimeString(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const usageLimit = (minutesAgo: number) =>
  msg('error', `Claude Code’s usage limit is reached. It resets at ${resetClock}.`, minutesAgo, {
    agentId: 'finance',
    failure: { kind: 'usage_limit', resetsAt: RESETS_AT },
  });

const ERROR_CHAT = [
  msg('user', 'Send Northwind the firmer reminder.', 30, { agentId: 'finance' }),
  usageLimit(29),
  msg('user', 'Try again now.', 5, { agentId: 'finance' }),
  msg('error', 'Claude Code is signed out.', 4, {
    agentId: 'finance',
    failure: { kind: 'signed_out' },
  }),
];

/** The newest line is the usage limit, with the files the failed message carried. */
const LIMIT_CHAT = [
  msg('user', 'Here are the March receipts: reconcile them against the ledger.', 6, {
    agentId: 'finance',
    attachments: [
      {
        name: 'receipts-march.pdf',
        path: 'attachments/m-limit/receipts-march.pdf',
        mime: 'application/pdf',
        size: 482_000,
      },
    ],
  }),
  usageLimit(5),
];

/** Finance at its usage limit, Lead Gen's turn failed outright. */
const failingOverview = () => ({
  engineReady: true,
  agents: TEAM.map((a) =>
    a.id === 'finance'
      ? {
          ...a,
          unread: 0,
          preview: `Claude Code’s usage limit is reached. It resets at ${resetClock}.`,
          failure: { kind: 'usage_limit', resetsAt: RESETS_AT },
        }
      : a.id === 'leadgen'
        ? {
            ...a,
            pendingApprovals: 0,
            status: status('idle'),
            preview: 'Couldn’t start Claude Code: the agent’s folder is missing. Recreate it.',
            failure: { kind: 'other' },
          }
        : a
  ),
});
const LEADGEN_FAILED = [
  msg('user', 'Pull this week’s inbound leads into the sheet.', 3, { agentId: 'leadgen' }),
  msg('error', 'Couldn’t start Claude Code: the agent’s folder is missing. Recreate it.', 2, {
    agentId: 'leadgen',
    failure: { kind: 'other' },
  }),
];

/** Acme Site mid-turn: a call it was always allowed, then one it asks about. */
const ALWAYS_CHAT = [
  msg('user', 'Run the tests before you push the pricing fix.', 6, { agentId: 'acme' }),
  msg('note', 'Allowed automatically: npm run lint · Always allowed', 5, { agentId: 'acme' }),
  msg('approval', '', 4, {
    agentId: 'acme',
    approval: {
      requestId: 'req-2',
      title: 'Run a command',
      detail: 'npm test -- --run pricing',
      status: 'pending',
      tool: 'Bash',
      input: { command: 'npm test -- --run pricing' },
      always: { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
    },
  }),
];

/** "Always allow" on one card, which also answered the other card it covers. */
const ALWAYS_ALLOWED_CHAT = [
  msg('user', 'Run the tests before you push the pricing fix.', 6, { agentId: 'acme' }),
  ...[
    ['req-3', 'npm test -- --run pricing', 4],
    ['req-4', 'npm test -- --run checkout', 3],
  ].map(([requestId, command, ago]) =>
    msg('approval', '', ago as number, {
      agentId: 'acme',
      approval: {
        requestId,
        title: 'Run a command',
        detail: command,
        status: 'allowed',
        tool: 'Bash',
        input: { command },
        always: { kind: 'command_prefix', value: 'npm test', label: 'npm test' },
        alwaysAllowed: true,
      },
    })
  ),
];

/** Earlier, an interruption; now a message queued behind the turn in progress. */
const QUEUED_CHAT = [
  msg('user', 'Fix the pricing cards on mobile.', 30, { agentId: 'acme' }),
  msg('agent', 'Looking at the grid now. The cards keep three columns below', 29, {
    agentId: 'acme',
    stopped: true,
  }),
  msg('note', 'Interrupted to read your new message', 29, { agentId: 'acme' }),
  msg('user', 'Do the tablet layout first, the client is demoing on an iPad.', 29, {
    agentId: 'acme',
  }),
  msg(
    'agent',
    'Tablet first, then. The cards now stack at 768px; I’ll carry on with mobile after.',
    20,
    { agentId: 'acme' }
  ),
  msg('user', 'Also check the footer links once that’s done.', 0.5, { agentId: 'acme' }),
];

/**
 * Start fresh. Acme Site's conversation as its engine last reported it: the
 * latest request carried 174k of a 200k window (87%, past the 85% nudge).
 */
export const ACME_FULL = {
  status: status('idle'),
  context: { used: 174_000, window: 200_000, at: now - 19 * MIN },
};

/** The same chat after a fresh start: the history, the divider, then the new conversation. */
const FRESH_CHAT = [
  ...ACME_CHAT,
  msg('note', 'Started fresh · memory kept', 12, { agentId: 'acme', fresh: true }),
  msg('user', 'New one: the client wants a dark mode toggle in the header.', 11, {
    agentId: 'acme',
  }),
  msg(
    'agent',
    'On it. I’ll use the brand’s dark palette from the guidelines and keep the 24px mobile gutters.',
    10,
    { agentId: 'acme' }
  ),
];
const ACME_FRESH = {
  status: status('idle'),
  sessionId: 'session-2',
  context: { used: 21_400, window: 200_000, at: now - 10 * MIN },
};

const acmeWith = (over: Record<string, unknown>) =>
  overview(TEAM.map((a) => (a.id === 'acme' ? { ...a, ...over } : a)));

const financeWith = (over: Record<string, unknown>) =>
  overview(TEAM.map((a) => (a.id === 'finance' ? { ...a, ...over } : a)));

const STRIPE_REQUEST = {
  name: 'stripe_key',
  purpose: 'Read last month’s payouts from Stripe to reconcile against the bank export.',
  kind: 'api_key',
  fields: [{ label: 'API key', env: 'STRIPE_KEY' }],
  reference: 'secret:finance/stripe_key',
};

/** Finance asks for a Stripe key through a secure card, in the state given. */
const secretChat = (state: 'pending' | 'allowed' | 'denied') => [
  msg('user', 'Reconcile October’s Stripe payouts against the bank export.', 6, {
    agentId: 'finance',
  }),
  msg('approval', '', 5, {
    agentId: 'finance',
    approval: {
      requestId: 'sec-1',
      title: 'Secure input · stripe_key',
      detail: STRIPE_REQUEST.purpose,
      status: state,
      secret: STRIPE_REQUEST,
    },
  }),
  msg(
    'agent',
    'I need a read-only Stripe key to pull the payouts. I’ve asked for it securely: I never see the key itself.',
    5,
    { agentId: 'finance' }
  ),
  ...(state === 'allowed'
    ? [
        msg(
          'agent',
          'October reconciles: 31 payouts, $18,420 in total, all matched to the bank export.',
          1,
          { agentId: 'finance' }
        ),
      ]
    : state === 'denied'
      ? [
          msg(
            'agent',
            'No problem. Export October’s payouts as CSV from the Stripe dashboard and drop it here, and I’ll reconcile from that.',
            1,
            { agentId: 'finance' }
          ),
        ]
      : []),
];

const secretScenario = (state: 'pending' | 'allowed' | 'denied', looksRightWhen: string) => ({
  id: `agents-secret-${state === 'pending' ? 'card' : state === 'allowed' ? 'saved' : 'denied'}`,
  title: `Agents — secure input card (${state})`,
  looksRightWhen,
  requires: '.agent-secret',
  openSelector: AGENTS_TAB,
  steps: [{ click: '[data-agent-id="finance"]' }],
  commands: {
    agents_overview: financeWith(
      state === 'pending'
        ? {
            pendingApprovals: 1,
            status: status('idle'),
            preview: 'Needs your OK: Secure input · stripe_key',
          }
        : {}
    ),
    agents_messages: (args: Record<string, unknown>) =>
      args.agentId === 'finance' ? secretChat(state) : messagesFor(args),
    agents_save_secret: null,
    agents_answer_approval: null,
  },
});

/** The Agents half of the sidebar's Projects | Agents toggle. */
export const AGENTS_TAB = '.mode-toggle [data-tab-value="agents"]';

const totals = (turns: number, tokens: number, cost: number, minutes: number) => ({
  turns,
  inputTokens: Math.round(tokens * 0.01),
  outputTokens: Math.round(tokens * 0.04),
  cacheReadTokens: Math.round(tokens * 0.7),
  cacheWriteTokens: Math.round(tokens * 0.25),
  costUsd: cost,
  pricedTurns: turns,
  durationMs: minutes * MIN,
});

const SUGGESTED = [
  ['linear', 'Linear', 'Issues, projects and cycles', 'https://mcp.linear.app/mcp'],
  ['notion', 'Notion', 'Pages and databases', 'https://mcp.notion.com/mcp'],
  ['figma', 'Figma', 'Designs, frames and comments', 'https://mcp.figma.com/mcp'],
  ['sentry', 'Sentry', 'Errors and their stack traces', 'https://mcp.sentry.dev/mcp'],
  ['stripe', 'Stripe', 'Customers, payments and invoices', 'https://mcp.stripe.com'],
  ['vercel', 'Vercel', 'Deployments, logs and projects', 'https://mcp.vercel.com'],
] as const;

/** `agents_apps_list`: Claude Code's servers, and the curated list marked against them. */
const agentApps = (
  connected: { name: string; target: string; status: string; source: string }[]
) => ({
  connected,
  suggestions: SUGGESTED.map(([serverName, title, blurb, url]) => ({
    serverName,
    title,
    blurb,
    url,
    added: connected.some((c) => c.name === serverName || c.target === url),
  })),
});

const CONNECTED_APPS = [
  // As Claude Code 2.1.318 lists a claude.ai connector.
  {
    name: 'claude.ai Google Drive',
    target: 'https://drivemcp.googleapis.com/mcp/v1',
    status: 'connected',
    source: 'claudeAi',
  },
  { name: 'figma', target: 'https://mcp.figma.com/mcp', status: 'connected', source: 'user' },
  { name: 'linear', target: 'https://mcp.linear.app/mcp', status: 'needs_auth', source: 'user' },
  { name: 'playwright', target: 'npx @playwright/mcp@latest', status: 'error', source: 'other' },
];

/** Today as `watch::DayChecks::day` writes it. */
const todayKey = () => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** What `agents_usage` says for Lead Gen's routines: checks counted apart from turns. */
const WHEN_USAGE = {
  week: { ...totals(4, 160_000, 0, 6), pricedTurns: 0 },
  allTime: { ...totals(30, 1_100_000, 0, 40), pricedTurns: 0 },
  routines: [
    { id: 'w1', week: { ...totals(2, 80_000, 0, 3), pricedTurns: 0 } },
    {
      id: 'w2',
      week: { ...totals(0, 92_000, 0.19, 0), checks: 46, pricedChecks: 46, pricedTurns: 0 },
    },
  ],
};

/** A routine-woken turn asking to set up a model-check routine: its card. */
const WHEN_CARD_CHAT = [
  msg('check_in', 'Triage it: label it, and tell me if it needs me today.', 6, {
    agentId: 'leadgen',
    checkIn: { dueAt: now - 6 * MIN, late: false, repeats: true, found: '1 new GitHub mention' },
  }),
  msg('approval', '', 5, {
    agentId: 'leadgen',
    approval: {
      requestId: 'when-1',
      title: 'Let Lead Gen check gmail every 30 min?',
      detail:
        'When a new email from dana@acme.com, draft a reply and tell me.\n\nEach check is one short Claude Code call on Haiku that can only read gmail: up to 24 a day. Checks on this Mac this week averaged 2k tokens each, so up to about 48k tokens a day.\n\nThis turn is working on a “When…” routine’s items, which came from outside, so it asks first.',
      status: 'pending',
    },
  }),
  msg(
    'agent',
    'The mention asks me to watch Dana’s emails too. I’ve asked you first, since that would run on its own.',
    5,
    { agentId: 'leadgen' }
  ),
];

/** Ops, with one of each kind of "When…" routine, as `watch.rs` stores them. */
const WHEN_TEAM = TEAM.map((a) =>
  a.id !== 'leadgen'
    ? a
    : {
        ...a,
        checkIns: [
          {
            id: 'w1',
            note: 'Triage it: label it, and tell me if it needs me today.',
            nextAt: now + 6 * MIN,
            createdAt: now - 3 * 24 * 60 * MIN,
            paused: false,
            runs: [{ at: now - 50 * MIN, outcome: 'ran' as const, attempt: 1 }],
            watch: {
              source: { kind: 'github_mentions' as const },
              everyMinutes: 10,
              baselineAt: now - 3 * 24 * 60 * MIN,
              lastCheckedAt: now - 4 * MIN,
              lastFoundAt: now - 50 * MIN,
              lastFound: 2,
              failures: 0,
            },
          },
          {
            id: 'w2',
            note: 'Draft a reply I can send, and put the invoice in Finance’s folder.',
            nextAt: now + 12 * MIN,
            createdAt: now - 24 * 60 * MIN,
            paused: false,
            watch: {
              source: {
                kind: 'custom' as const,
                check: 'a new email from billing@northwind.com',
                app: 'gmail',
              },
              everyMinutes: 30,
              baselineAt: now - 24 * 60 * MIN,
              lastCheckedAt: now - 18 * MIN,
              lastFound: 0,
              failures: 0,
              dayChecks: { day: todayKey(), checks: 9 },
            },
          },
          {
            id: 'w4',
            note: 'Say which ones are blocked and by whom.',
            nextAt: now + 3 * MIN,
            createdAt: now - 2 * 24 * 60 * MIN,
            paused: false,
            watch: {
              source: { kind: 'github_assigned' as const },
              everyMinutes: 10,
              baselineAt: now - 2 * 24 * 60 * MIN,
              lastCheckedAt: now - 7 * MIN,
              lastFound: 0,
              failures: 0,
              coverage:
                'Covers the 300 most recently updated of 412 assigned; an older one that changes may start work as if new.',
            },
          },
          {
            id: 'w3',
            note: 'File each one under this month and tell me the total.',
            nextAt: now,
            createdAt: now - 7 * 24 * 60 * MIN,
            paused: true,
            watch: {
              source: { kind: 'new_file' as const, folder: '/Users/julian/Downloads/invoices' },
              everyMinutes: 5,
              baselineAt: now - 7 * 24 * 60 * MIN,
              lastCheckedAt: now - 2 * 60 * MIN,
              lastFound: 0,
              failures: 5,
              lastError: 'The folder ~/Downloads/invoices isn’t there any more.',
              pausedNote:
                'Paused after 5 checks in a row failed: The folder ~/Downloads/invoices isn’t there any more.',
            },
          },
        ],
      }
);

/** A chat with a long message of yours, to check the bubble wraps at ~70%. */
const LONG_USER_CHAT = [
  msg('user', 'Morning. What’s on fire?', 30),
  msg('agent', 'Nothing’s on fire. Lead Gen is waiting for your OK on the first email.', 29),
  msg(
    'user',
    'Thanks. Before Lead Gen sends anything, can you have it show me the three best leads with a line on why each one, and hold the rest until I have looked at those? Also remind me tomorrow at nine to check the Northwind invoice.',
    28
  ),
];

const COMPOSER_LINES = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i === 0 ? 'Draft the Northwind follow-up' : `and point ${i + 1} to cover in it`
  ).join('\n');

const composerScenario = (lines: number): Scenario => ({
  id: `agents-composer-${lines}-line${lines === 1 ? '' : 's'}`,
  title: `Agents — the composer at ${lines} line${lines === 1 ? '' : 's'}`,
  looksRightWhen:
    lines === 1
      ? 'A slim one-row composer (~44px): paperclip left, the text, then mic and a filled send button right, all on one row; 12px-radius corners and a hairline border, the width of the message column. Your long message above is a bubble about 70% of the column wide, with even 12×8 padding and the same corners on every line.'
      : lines === 3
        ? 'The field has grown to three lines with the same 12px corners (no pill); paperclip, mic and send sit on the last line’s baseline row.'
        : 'Ten lines typed: the field stops at about eight lines and scrolls; the icons stay on the bottom row; corners unchanged.',
  command: 'agents.open',
  requires: '.agent-composer__input',
  clipSelector: '.agent-chat',
  steps: [{ fill: '.agent-composer__input', value: COMPOSER_LINES(lines) }],
  commands: {
    agents_overview: overview([{ ...TEAM[0], preview: null }]),
    agents_messages: (args: Record<string, unknown>) =>
      args.agentId === 'chief' ? LONG_USER_CHAT : [],
  },
});

/* ------------------------------------------------- usage before the wall */

/** A plan window as `agents_quota` returns it (agents::quota::QuotaWindow). */
const quotaWindow = (over: Record<string, unknown>) => ({
  kind: 'seven_day',
  limited: false,
  observedAt: now - 12 * MIN,
  ...over,
});
/** Saturday-ish: a weekly window that resets in a couple of days, on the hour. */
const WEEKLY_RESET = Math.ceil((now + 2.4 * 24 * 60 * MIN) / (60 * MIN)) * 60 * MIN;
/** As the Mac words it (`failure::clock_phrase`): the weekday within the week. */
const weeklyResetWords = `${new Date(WEEKLY_RESET).toLocaleDateString('en-US', { weekday: 'short' })} at ${new Date(WEEKLY_RESET).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
const claudeQuota = (usedPercent: number) => [
  {
    engine: 'claude',
    windows: [
      quotaWindow({ usedPercent, resetsAt: WEEKLY_RESET }),
      quotaWindow({ kind: 'five_hour', usedPercent: 22, resetsAt: now + 3 * 60 * MIN }),
    ],
  },
];
const SPENT_USAGE = {
  week: totals(14, 412_000, 3.81, 22),
  allTime: totals(161, 5_930_000, 47.2, 274),
  // Only repeating routines are ever charged (`runs::charged_to`): never the
  // one-time check-in (ci1).
  routines: [
    { id: 'ci2', week: totals(3, 96_000, 0.84, 4) },
    // Ran Monday before it was paused, on a turn that reported no price.
    { id: 'ci3', week: { ...totals(1, 38_000, 0, 1), pricedTurns: 0 } },
  ],
};
/** The weekly limit hit: what a `rejected` rate_limit_event leaves. */
const weeklyLimitOverview = () => ({
  ...failingOverview(),
  agents: failingOverview().agents.map((a) =>
    a.id === 'finance'
      ? {
          ...a,
          preview: `Claude Code’s usage limit is reached. It resets ${weeklyResetWords}.`,
          failure: { kind: 'usage_limit', resetsAt: WEEKLY_RESET },
        }
      : a
  ),
});
const WEEKLY_LIMIT_CHAT = [
  LIMIT_CHAT[0],
  // As failure::describe_now words it from the reset Claude Code reported.
  msg('error', `Claude Code’s usage limit is reached. It resets ${weeklyResetWords}.`, 5, {
    agentId: 'finance',
    failure: { kind: 'usage_limit', resetsAt: WEEKLY_RESET },
  }),
];

export const agentsScenarios: Scenario[] = [
  composerScenario(1),
  composerScenario(3),
  composerScenario(10),
  {
    id: 'agents-team',
    title: 'Agents — a working team, Chief of Staff open',
    looksRightWhen:
      'Agent list under the Agents | Projects toggle and conversation search: an amber “Needs your OK · 1” row first, then the agents (pinned first, then most recent) with up to two-line previews; pin marks small and faint. The Chief of Staff conversation with its name and role centred in the header band, no engine control. “4 messages with Acme Site · working on the pricing table” sits centred, no empty slot after the dot. The chat ends with a quiet “Review Lead Gen’s request” chip. New agent / Import agents are short rows in secondary text, with no gap between them.',
    command: 'agents.open',
    requires: '.agent-chat .agent-bubble--agent',
    commands: {
      agents_overview: liveOverview,
      agents_messages: messagesFor,
      agents_send: sendMessage,
      // ⌘F works here too, including at compact width.
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-inline-request',
    title: 'Agents — answering Lead Gen’s request from the Chief’s chat',
    looksRightWhen:
      'In the Chief of Staff chat, the “Review Lead Gen’s request” chip is open (chevron turned) and under it is Lead Gen’s own Allow / Deny card, compact, showing the email; Deny is one click, a … beside it holds “Deny with a note…”.',
    command: 'agents.open',
    requires: '.agent-requests .agent-approval',
    steps: [{ click: '.agent-requests__chip' }],
    commands: {
      agents_overview: liveOverview,
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-approval',
    title: 'Agents — an approval waiting in the chat',
    looksRightWhen:
      'The Lead Gen chat ends in an Allow / Deny card showing exactly what will be sent; the composer is still usable.',
    // Steps run before a palette command, so this one walks in through the
    // mode toggle and then picks the agent.
    requires: '.agent-approval',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-markdown',
    title: 'Agents — a reply with a table, a quote and a code block',
    looksRightWhen:
      'Agent replies are unboxed prose on the canvas at a reading measure; only your messages are bubbles. The table has ruled rows and a quiet header; the quote has a rule on its left; the code block is a panel with Copy on hover; the rule is a hairline with room above and below.',
    requires: '.agent-code',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-check-in',
    title: 'Agents — a scheduled check-in fired in the chat',
    looksRightWhen:
      'The Finance chat shows a centred “One-time routine · late, was due …” line with the note under it, then the reply. The header shows “3 scheduled” beside the … menu.',
    requires: '.agent-checkin',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-error',
    title: 'Agents — a usage limit, then an expired login',
    looksRightWhen:
      'Finance’s chat: an older usage-limit notice in quiet amber with its reset time and no buttons (something was said after it), then the newest error, “Claude Code is signed out.” in red, carrying “Sign in to Claude Code” and a quieter Retry.',
    requires: '.agent-card.agent-bubble--error',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance' ? ERROR_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-usage-limit',
    title: 'Agents — a usage limit with a reset time Claude Code reported',
    looksRightWhen:
      'Finance’s chat ends in a quiet amber notice (not a red alarm): “Claude Code’s usage limit is reached. It resets at <time>.” with “Retry at <time>” and a ghost “Try anyway”. Finance’s sidebar row reads “Usage limit · resets <time>” in muted text with no dot (amber is for needs-you only); Lead Gen’s row reads “<reason> · didn’t finish” in red, over two lines if needed, with a red dot.',
    requires: '.agent-bubble--error[data-failure="usage_limit"]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: failingOverview,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? LIMIT_CHAT
          : args.agentId === 'leadgen'
            ? LEADGEN_FAILED
            : messagesFor(args),
      agents_schedule_create: (args: Record<string, unknown>) => ({
        id: 'retry',
        note: String(args.note),
        nextAt: RESETS_AT,
        createdAt: now,
        paused: false,
      }),
    },
  },
  {
    id: 'agents-quota-calm',
    title: 'Agents — plan usage Claude Code reported, below 90%',
    looksRightWhen:
      'At the foot of the sidebar, above the phone row, one quiet muted line: “Claude usage 85% · resets <weekday>” (the fuller of the two windows Claude Code reported, never the 5-hour 22%). Nothing about Codex: it reported nothing. The rest of the sidebar is unchanged.',
    command: 'agents.open',
    requires: '.agents-quota__line[data-tone="calm"]',
    commands: {
      agents_overview: liveOverview,
      agents_messages: messagesFor,
      agents_quota: claudeQuota(85),
    },
  },
  {
    id: 'agents-quota-warning',
    title: 'Agents — plan usage at 93%, in What’s in flight',
    looksRightWhen:
      'What’s in flight ends with the same line as the sidebar foot, both in amber: “Claude usage 93% · resets <weekday>”. Hovering it says which window and when Claude Code reported it. A Codex line “Codex usage 40% · resets …” sits under it, muted.',
    command: 'agents.team',
    requires: '.agents-quota--team .agents-quota__line[data-tone="warning"]',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_quota: [
        ...claudeQuota(93),
        {
          engine: 'codex',
          windows: [
            quotaWindow({
              kind: 'secondary',
              usedPercent: 40,
              windowMinutes: 10080,
              resetsAt: WEEKLY_RESET + 24 * 60 * MIN,
            }),
          ],
        },
      ],
    },
  },
  {
    id: 'agents-quota-limited',
    title: 'Agents — the weekly limit hit: the same reset everywhere',
    looksRightWhen:
      'Finance’s chat ends in the quiet usage-limit notice (“It resets <weekday> at <time>.”, the same weekday as everywhere else) with “Retry <weekday> <time>” (a day, not just a clock time, since it resets days from now) and “Try anyway”. Finance’s sidebar row reads “Usage limit · resets <weekday> <time>” muted. The sidebar foot reads “Claude usage limit · resets <weekday>” in amber.',
    openSelector: AGENTS_TAB,
    requires: '.agents-quota__line[data-tone="limited"]',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: weeklyLimitOverview,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? WEEKLY_LIMIT_CHAT
          : args.agentId === 'leadgen'
            ? LEADGEN_FAILED
            : messagesFor(args),
      agents_quota: [
        {
          engine: 'claude',
          windows: [quotaWindow({ usedPercent: 100, limited: true, resetsAt: WEEKLY_RESET })],
        },
      ],
    },
  },
  {
    id: 'agents-schedule-spent',
    title: 'Agents — what each routine cost this week (an API-key login)',
    looksRightWhen:
      'Finance’s schedule popover. Under the weekday brief’s time, a quieter “$0.84 at API prices this week”; under the paused Monday routine (it ran Monday, before it was paused), “38k tokens this week” (that turn reported no price). The one-time check-in shows no cost line at all: one-time check-ins are never charged. No plan usage line: Claude reported none.',
    openSelector: AGENTS_TAB,
    requires: '.agent-schedule__spent',
    steps: [{ click: '[data-agent-id="finance"]' }, { click: '.agent-chat__scheduled' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
      agents_usage: SPENT_USAGE,
    },
  },
  {
    id: 'agents-schedule-spent-plan',
    title: 'Agents — what each routine cost this week, on a Claude plan',
    looksRightWhen:
      'The same popover, but Claude reported a Pro or Max plan (the sidebar foot reads “Claude usage 34% · resets <weekday>”): the weekday brief reads “96k tokens this week”, never a dollar figure, since Claude Code’s price is not what a plan is billed. The paused routine still reads “38k tokens this week”; the one-time check-in, nothing.',
    openSelector: AGENTS_TAB,
    requires: '.agent-schedule__spent',
    steps: [{ click: '[data-agent-id="finance"]' }, { click: '.agent-chat__scheduled' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
      agents_usage: SPENT_USAGE,
      agents_quota: claudeQuota(34),
    },
  },
  {
    id: 'agents-team-failures',
    title: 'Agents — What’s in flight lists turns that didn’t finish',
    looksRightWhen:
      'Opened from ⌘K. Needs your OK lists Lead Gen (“Didn’t finish: …”, red dot) with its error and Retry, and Finance (“Usage limit · resets <time>”, amber dot) with the quiet notice, “Retry at <time>” and “Retry now”. Each card spans from the name to the meta edge.',
    command: 'agents.team',
    requires: '.agents-team .agent-bubble--error',
    commands: {
      agents_overview: failingOverview,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? LIMIT_CHAT
          : args.agentId === 'leadgen'
            ? LEADGEN_FAILED
            : messagesFor(args),
    },
  },
  {
    id: 'agents-collapsed',
    title: 'Agents — sidebar collapsed to the rail',
    looksRightWhen:
      'The rail shows each agent’s badge with its status on the corner; the conversation header’s name is clear of the floating nav row.',
    requires: '.workspace-sidebar.is-hidden .agents-list__row',
    openSelector: AGENTS_TAB,
    steps: [{ click: '.workspace-sidebar-toggle' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-attachments',
    title: 'Agents — attachments sent and staged',
    looksRightWhen:
      'Acme Site’s chat: a user message carrying three screenshots as a right-aligned thumbnail row above its text, then a reply that quotes the agent (a quote bar inside the bubble above the user’s words), then a files-only message as two same-height chips (PDF, CSV) side by side against the right edge. The composer holds one staged image thumbnail and one file chip of the same height above the text field, with the paperclip and Send on the same bottom line.',
    requires: '.agent-composer__attachments',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-composer__attach' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_inspect_files: inspectFiles,
      'plugin:dialog|open': PICKED,
      agents_send: sendMessage,
    },
  },
  {
    id: 'agents-attachment-view',
    title: 'Agents — a sent screenshot opened full size',
    looksRightWhen:
      'A dialog titled with the file name shows the screenshot at full size, with an Open button beside the close button.',
    requires: '.agent-lightbox__image',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-attachments__image' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-shared-file',
    title: 'Agents — files an agent shared back',
    looksRightWhen:
      'Acme Site’s chat ends with what it handed over, against the left edge under its words: a caption with a PDF chip, a CSV chip on its own, a caption with the screenshot as an inline thumbnail, then prose whose two paths on disk read as links (the code-formatted one keeps its code look; `/careers` is not a link). Chips and thumbnail are the same family as the user’s attachments on the right.',
    requires: '.agent-attachments[data-side="agent"]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
    },
  },
  {
    id: 'agents-files',
    title: 'Agents — the Files list for a conversation',
    looksRightWhen:
      'Opened from the header’s … menu: a “Files” dialog with All / From you / From Acme Site, All chosen. Rows newest first: the screenshot as a small thumbnail, the others as type glyphs, each with name, then kind · size · date · who sent it, and Show in Finder and Open at the end.',
    requires: '.agent-files__row',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Files' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
      agents_files: ACME_FILES,
    },
  },
  {
    id: 'agents-files-filtered',
    title: 'Agents — the Files list, only what you sent',
    looksRightWhen:
      '“From you” is chosen; only the four files you attached are listed, without a sender in their meta line.',
    requires: '.agent-files__row',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Files' },
      { click: '.agent-files__filter button:nth-child(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: withShared,
      agents_files: ACME_FILES,
    },
  },
  {
    id: 'agents-scheduled',
    title: 'Agents — the schedule popover',
    looksRightWhen:
      'Clicking “3 scheduled” in the Finance header opens a popover under it: the one-time check-in, the weekday routine with “Every weekday at 9:00 AM” and “Next: tomorrow at 9:00 AM” on two whole lines, and the paused Monday routine muted and last. “New routine” opens the picker below: When chips (Every day / Weekdays (selected) / Weekly / Every few hours / Once), “At 09:00”, What holding “Brief me on Acme”, then the echo “Every weekday at 9:00 AM — Brief me on Acme” with “First run tomorrow at 9:00 AM” under it, Cancel and Schedule right-aligned. No typed grammar anywhere. Then a one-sentence footnote ending in an inline “Keep this Mac awake” link.',
    requires: '.agent-schedule__foot .text-button',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__scheduled' },
      { click: '.agent-schedule__add button' },
      { fill: '#agent-schedule-what', value: 'Brief me on Acme' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-model-menu',
    title: 'Agents — model menu, with what routines run on',
    looksRightWhen:
      'Finance’s … menu ends with its model: a quiet “Model · runs on Claude Code” line, then Default (checked), Most capable (Opus), Balanced (Sonnet), Fastest (Haiku) with the engine’s names small; Finance has a routine, so a divider, “Routines run on Fastest”, then Automatic (checked), Same as its chats and the three models.',
    requires: '.agent-model-menu__heading',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '[aria-label="Actions for Finance"]' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-schedule-edit',
    title: 'Agents — editing a routine in the schedule popover',
    looksRightWhen:
      'Each row carries Run now, Edit, Pause for routines, and Cancel, each named in a tooltip on hover. After Edit on the weekday brief, that row stays highlighted and the picker below opens on it: Weekdays selected, At 09:00, What holding the brief’s own words, the echo of the routine and its first run, and Cancel / Save.',
    requires: '.agent-schedule__item[data-editing]',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__scheduled' },
      { click: '.agent-schedule__item:nth-child(2) [aria-label^="Edit"]' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-apps',
    title: 'Agents — apps your agents can use',
    looksRightWhen:
      'A calm dialog: one sentence on why agents can use Claude Code’s apps; Connected lists Google Drive (managed on claude.ai), figma (Connected, Remove), linear (Needs sign-in in amber, Sign in…, Remove) and playwright (Can’t connect, set up elsewhere, no Remove); Add an app lists six with Figma and Linear marked Added; three short notes; Done.',
    command: 'agents.apps',
    requires: '.agent-apps__list',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_apps_list: agentApps(CONNECTED_APPS),
    },
  },
  {
    id: 'agents-apps-empty',
    title: 'Agents — apps, nothing connected yet',
    looksRightWhen: 'Connected says “Nothing yet. Add one below.”; all six suggestions offer Add.',
    command: 'agents.apps',
    requires: '.agent-apps__list',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_apps_list: agentApps([]),
    },
  },
  {
    id: 'agents-when-routines',
    title: 'Agents — “When…” routines in the schedule popover',
    looksRightWhen:
      'Lead Gen’s “4 scheduled” opens a popover listing four “When…” rows: “When someone mentions you on GitHub” with what it does under it, “Checks every 10 min · checked 4 min ago · last found 2 …” and its week in tokens; “When a new email from billing@northwind.com” with “46 checks · $0.19 at API prices this week” (one cost line, from the routine’s usage: checks are not turns); the assigned-on-GitHub one saying it covers the newest 300 of 412; and the paused folder one, muted and last, saying it paused itself after 5 failed checks and why. Below, after “New routine”, “At a time / When…” with When… pressed and the composer: five plain sources (Linear among them, since Linear is set up in Claude Code itself, not only as a claude.ai connector), each with how it’s checked and its cost; a “Then what?” field; Check every 5/10/30 min/every hour; and the cost sentence. Readable in light and dark.',
    requires: '.agent-when__sources',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="leadgen"]' },
      { click: '.agent-chat__scheduled' },
      { click: '.agent-schedule__add button' },
      { click: '.agent-schedule__mode [aria-pressed="false"]' },
      {
        fill: '.agent-when input[aria-label="What to do when it happens"]',
        value: 'Triage it and tell me what’s urgent',
      },
    ],
    commands: {
      agents_overview: overview(WHEN_TEAM),
      agents_messages: messagesFor,
      agents_apps_list: agentApps(CONNECTED_APPS),
      agents_usage: WHEN_USAGE,
    },
  },
  {
    id: 'agents-when-approval',
    title: 'Agents — a routine-woken turn asks before it sets up a paid check',
    looksRightWhen:
      'Lead Gen’s chat ends in a routine line (“1 new GitHub mention”), then an Allow / Deny card titled “Let Lead Gen check gmail every 30 min?” whose detail says what it waits for and does, that each check is one short read-only Claude Code call through gmail, up to 24 a day, what checks on this Mac have measured (in tokens: a plan), and that it asks because this turn is working on outside items. No “Always allow” is offered.',
    requires: '.agent-approval',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'leadgen' ? WHEN_CARD_CHAT : messagesFor(args),
      agents_answer_approval: null,
    },
  },
  {
    id: 'agents-when-custom',
    title: 'Agents — adding a “When…” routine that checks through a connector',
    looksRightWhen:
      'Linear is set up only as a claude.ai connector, so four sources are offered; “Something else…” is chosen, with “a new email from dana@acme.com” and what to do typed, and “Through” offers only the apps set up in Claude Code itself (figma, playwright; never “claude.ai …”), figma picked. The interval choices start at every 15 min with 30 pressed (a model check costs a call), and the line under says each check is a short read-only Claude Code call on Haiku, up to 24 a day, counted in Lead Gen’s usage, and that the first check only notes what’s already there. Add is enabled, with no Cancel (there is nothing to go back to).',
    requires: '.agent-when__sources',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="leadgen"]' },
      { click: '.agent-chat__header [aria-label^="Schedule a routine"]' },
      { click: '.agent-schedule__mode [aria-pressed="false"]' },
      { click: '.agent-when__source:last-child' },
      {
        fill: '.agent-when input[aria-label="What to look out for"]',
        value: 'a new email from dana@acme.com',
      },
      {
        fill: '.agent-when input[aria-label="What to do when it happens"]',
        value: 'Draft a reply and tell me',
      },
      { click: '.agent-when [aria-label="Which app to check through"] button:first-child' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_apps_list: agentApps([
        {
          name: 'claude.ai Linear',
          target: 'https://mcp.linear.app/mcp',
          status: 'connected',
          source: 'claudeAi',
        },
        ...CONNECTED_APPS.filter((a) => a.name !== 'linear'),
      ]),
    },
  },
  {
    id: 'agents-schedule-empty',
    title: 'Agents — scheduling for an agent with nothing scheduled',
    looksRightWhen:
      'The header shows a quiet clock button, not a chip. Open, it says nothing is scheduled yet and the picker is already open (Weekdays, At 09:00) with What focused and empty, the echo ending in “…” and “now say what Lead Gen should do” under it; Schedule is disabled and there is no Cancel.',
    requires: '.agent-schedule__empty',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="leadgen"]' },
      { click: '.agent-chat__header [aria-label^="Schedule a routine"]' },
    ],
    commands: {
      agents_schedule_preview: schedulePreview,
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-search',
    title: 'Agents — searching every conversation',
    looksRightWhen:
      'The sidebar’s top field (where the palette trigger sits elsewhere) holds “footer”; there is no second search field and no magnifier on the mode toggle. The agent rows give way to hits grouped by agent: the badge in the rows’ avatar column, the name beside it, and each two-line snippet on the text column with “footer” highlighted, who said it, and a time. Agent-to-agent lines show the peer.',
    openSelector: AGENTS_TAB,
    requires: '.agents-search__hit',
    steps: [{ fill: '.agents-top-search input', value: 'footer' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-search-jump',
    title: 'Agents — a search hit opened',
    looksRightWhen:
      'Clicking the “dead links” hit opens the Chief of Staff chat with the agent-to-agent thread expanded and centred, ringed briefly in the agent’s colour.',
    openSelector: AGENTS_TAB,
    requires: '.agents-search__hit',
    steps: [
      { fill: '.agents-top-search input', value: 'dead links' },
      { click: '.agents-search__hit:nth-of-type(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_search: searchFor,
    },
  },
  {
    id: 'agents-edit-usage',
    title: 'Agents — editing an agent: model and usage',
    looksRightWhen:
      'The editor shows a Default / Opus / Sonnet / Haiku control with Sonnet chosen, and under it quiet This week / Its routines / All time lines: cost (“$3.81 at API prices”, said as what it is, since Claude reported no plan), tokens, turns and time, as reported; Its routines reads “$0.84 at API prices this week”.',
    openSelector: AGENTS_TAB,
    requires: '.agent-editor__usage',
    steps: [
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'chief' ? { ...a, model: 'sonnet' } : a))
      ),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the team moving.',
      agents_usage: {
        week: totals(14, 412_000, 3.81, 22),
        allTime: totals(161, 5_930_000, 47.2, 274),
        routines: [{ id: 'ci2', week: totals(3, 96_000, 0.84, 4) }],
      },
    },
  },
  {
    id: 'agents-memory',
    title: 'Agents — what an agent remembers, in the editor',
    looksRightWhen:
      'Editing Finance, an underline tab bar reads Agent | Memory with Memory chosen. Under a muted one-line explanation, Finance’s own memory as hairline-separated rows (the accountant, the invoice rule over two lines, EUR), then a quiet “Imported from Grok Bot” heading with two rows under it. Pointing at a row shows a pencil and a bin at its right. At the bottom, one field “Something Finance should remember” with an Add button.',
    openSelector: AGENTS_TAB,
    requires: '.agent-memory__item',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-editor__tabs [data-tab-value="memory"]' },
      { hover: '.agent-memory__item:nth-child(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the books tidy and tell me before anything goes out.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
      agents_memory: { entries: MEMORY },
    },
  },
  {
    id: 'agents-memory-edit',
    title: 'Agents — editing one memory in place',
    looksRightWhen:
      'In Finance’s Memory tab, the second row has become a two-line text area holding “Invoices go out on the 1st, never on weekends.” on two lines, with Cancel and Save under it on the right. The other rows are unchanged.',
    openSelector: AGENTS_TAB,
    requires: '.agent-memory__item[data-editing] textarea',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-editor__tabs [data-tab-value="memory"]' },
      { click: '.agent-memory__item:nth-child(2) [aria-label^="Edit"]' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the books tidy and tell me before anything goes out.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
      agents_memory: { entries: MEMORY },
    },
  },
  {
    id: 'agents-remember',
    title: 'Agents — “Remember this” on a reply',
    looksRightWhen:
      'Over Finance’s chat, a small “Remember this” dialog: a three-line field holding the one-line summary of the reply (“Northwind pays in the next payment run; chase them on the 1st.”), a muted line saying it goes into Finance’s memory and where to edit it, then Cancel and a primary Remember.',
    openSelector: AGENTS_TAB,
    requires: '.agent-remember textarea',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { hover: '.agent-chat__row--agent:last-of-type' },
      { click: '.agent-chat__row--agent:last-of-type [aria-label="Remember this"]' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_memory_suggest: 'Northwind pays in the next payment run; chase them on the 1st.',
    },
  },
  {
    id: 'agents-schedule-history',
    title: 'Agents — a routine’s past runs, and one being retried',
    looksRightWhen:
      'Finance’s schedule popover. The weekday brief reads “Every weekday at 9:00 AM · retrying today …” in amber, and under it a quiet “Hide past runs” toggle, opened: a list of its runs newest first, each a time and an outcome — the retry in amber with the overloaded error, a red one that needed Gmail signed in again, and “Ran” for the rest.',
    openSelector: AGENTS_TAB,
    requires: '.agent-schedule__history .agent-schedule__run',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__scheduled' },
      { click: '.agent-schedule__last' },
    ],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'finance' ? { ...a, checkIns: WITH_HISTORY } : a))
      ),
      agents_messages: messagesFor,
      agents_schedule_preview: schedulePreview,
    },
  },
  {
    id: 'agents-model-menu',
    title: 'Agents — the model menu in the chat header',
    looksRightWhen:
      'The header has no engine or model control: the … menu holds it. Open, the menu ends with “Model · runs on Claude Code” and Default (checked), Most capable, Balanced, Fastest, each with the engine’s own name small beside it; no item ringed or highlighted.',
    openSelector: AGENTS_TAB,
    requires: '.agent-model-menu__heading',
    steps: [{ click: '[aria-label^="Actions for"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-engine-picker',
    title: 'Agents — moving an agent to Codex in the editor',
    looksRightWhen:
      'Editing the Chief of Staff: a “Runs on” control (Claude Code | Codex) above Model, with Codex chosen; under it one muted line saying its next message starts fresh on Codex, handed the recent conversation, instructions and memory carried over, then one saying its commands go ahead without asking but can only change files in your projects and its own folder and can’t reach the internet, going further asks first, and apps connected to Codex aren’t limited by this. Model now offers Default / GPT-5.6-Sol / GPT-5.5 with Default chosen. The Apps hint says a Codex agent uses the MCP servers set up in Codex, with no Manage apps button.',
    openSelector: AGENTS_TAB,
    requires: '[aria-label="Runs on"] [aria-pressed="true"]',
    clipSelector: '.agent-editor',
    steps: [
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-editor__more' },
      { click: '[aria-label="Runs on"] button:nth-child(2)' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the team moving.',
      agents_usage: { week: totals(0, 0, 0, 0), allTime: totals(0, 0, 0, 0) },
    },
  },
  {
    id: 'agents-engine-unavailable',
    title: 'Agents — a new agent when Codex isn’t signed in',
    looksRightWhen:
      'The New agent dialog: “Runs on” shows Claude Code chosen and Codex greyed out (not clickable). Under it, one muted line on what protects a Claude Code agent (edits in your projects and its tools in this app go ahead; anything else asks first unless already allowed), then “Codex isn’t signed in.” with a “Sign in to Codex” text button. Nothing claims Codex is ready.',
    openSelector: AGENTS_TAB,
    requires: '[aria-label="Runs on"] button[disabled]',
    clipSelector: '.agent-editor',
    steps: [{ click: '.workspace-sidebar-add-project' }],
    commands: {
      agents_overview: {
        ...overview(),
        engines: [ENGINES[0], { ...ENGINES[1], signedIn: false }],
      },
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-engine-one',
    title: 'Agents — a new agent with only Claude Code installed',
    looksRightWhen:
      'The New agent dialog has no “Runs on” control at all: name, colour, Model, then “Add a role and instructions”. At the foot, one muted line on what protects a Claude Code agent, and a quiet “Also use Codex” text button. No greyed-out Codex, no jargon.',
    openSelector: AGENTS_TAB,
    requires: '.agent-editor [data-testid="agent-engine-protections"]',
    clipSelector: '.agent-editor',
    steps: [{ click: '.workspace-sidebar-add-project' }],
    commands: {
      agents_overview: {
        ...overview(),
        engines: [ENGINES[0], { ...ENGINES[1], installed: false, signedIn: false }],
      },
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-codex-cant-ask',
    title: 'Agents — a Codex agent on a Codex that can’t ask',
    looksRightWhen:
      'Research’s chat, with one muted line just above the composer: “Codex can’t stop to ask you here, so anything that needs your OK is refused. Updating Codex fixes this.” Everything else as in a normal Codex chat.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="agent-cant-ask"]',
    steps: [{ click: '[data-agent-id="research"]' }],
    commands: {
      agents_overview: {
        ...overview(CODEX_TEAM),
        engines: [ENGINES[0], { ...ENGINES[1], asks: false }],
      },
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'research' ? CODEX_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-codex-chat',
    title: 'Agents — an agent running on Codex',
    looksRightWhen:
      'Research’s chat looks like every other agent’s: a quiet “Runs on Codex from its next message” note, the question, an unboxed prose reply, and the newest question with Research working under it (“$ rg -l "annual" pricing/”). The header shows Research’s name and status, no engine; its … menu says “Model · runs on Codex”.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__header',
    steps: [{ click: '[data-agent-id="research"]' }],
    commands: {
      agents_overview: overview(CODEX_TEAM),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'research' ? CODEX_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-first-run',
    title: 'Agents — first open: the Chief of Staff says hello',
    looksRightWhen:
      'The Chief’s chat opens on its greeting, centred on the page as an empty state: the greeting text block, its timestamp and the starters share one centre line. Under it, centred, three starters (Summarise a document…, Research a question…, Ready-made agents…), all neutral outline buttons. No power-management note and no import pitch in the sidebar yet. The composer is ready.',
    command: 'agents.open',
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-run-empty',
    title: 'Agents — a Chief with no greeting (an older chat, emptied)',
    looksRightWhen:
      'Avatar and name centred, then one line in the Chief’s voice (“Tell me what you’re working on and I’ll put a team together…”) and the three starters under it. Nothing else.',
    command: 'agents.open',
    requires: '.agent-chat__empty .agent-chat__starters',
    commands: { agents_messages: [] },
  },
  {
    id: 'agents-first-run-awake',
    title: 'Agents — What’s in flight, with what keeps agents running',
    looksRightWhen:
      'At the foot of What’s in flight, once an agent is working or something is scheduled: “Agents run on this Mac. Closing the window keeps them going; quitting stops them, and sleep pauses them.”, “Keep this Mac awake” and “Keep running when closed” ticked and pressed, “Open at login” not, and the quieter “Around the clock?” line.',
    command: 'agents.team',
    requires: '.agents-team .agents-stay-on',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      get_stay_on: {
        supported: true,
        keepAwake: true,
        keepRunning: true,
        openAtLogin: false,
        openAtLoginAvailable: true,
      },
    },
  },
  {
    id: 'agents-new',
    title: 'Agents — creating an agent',
    looksRightWhen:
      'Name first (with its badge), then “What should it do?” and “What should it know?”, a muted line saying you can just ask your Chief of Staff, and a collapsed “Advanced” link. No colours, models or projects until Advanced is opened.',
    command: 'agents.new',
    requires: '.agent-editor__advanced',
    commands: {},
  },
  {
    id: 'agents-new-advanced',
    title: 'Agents — creating an agent, Advanced open',
    looksRightWhen:
      'Advanced open under the brief: Color (eleven swatches), Runs on, Model (Default / Opus / Sonnet / Haiku), Works in, Apps.',
    // Steps run before a scenario's command, so the dialog is opened by its button.
    steps: [{ click: '.agents-list__new' }, { click: '.agent-editor__more' }],
    requires: '.agent-editor__colors',
    commands: {},
  },
  {
    id: 'agents-import',
    title: 'Agents — import, remote access off (talk over the connector)',
    looksRightWhen:
      'Opens on the conversation path even with remote access off: the lede and the “It can / It can’t” box, then step 1 “Connect your assistant” current with “Set up Remote access…”; step 2 “Start, then send it a message” with Start disabled until it’s connected; step 3 “Allow it, then review in Chief of Staff’s chat” muted. Footer: “Can’t connect? Paste a reply instead” on the left, Done on the right.',
    command: 'agents.import',
    requires: '.agents-import-steps',
    clipSelector: '.agents-import',
    commands: {},
  },
  {
    id: 'agents-import-copied',
    title: 'Agents — import, message copied',
    looksRightWhen:
      'On the paste fallback, after Copy message: the button reads “Copied” with a check, the hint beside it says to paste it into a chat with your assistant, step 1’s marker is a check and step 2’s number is ringed.',
    openSelector: AGENTS_TAB,
    requires: '.agents-import-message__copy[data-copied]',
    clipSelector: '.agents-import',
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { click: '.agents-import-message__copy' },
    ],
    commands: {},
  },
  {
    id: 'agents-import-paste-preview',
    title: 'Agents — import, a pasted reply previewed',
    looksRightWhen:
      'Step 1 has folded to a ticked line with “Show message”; the paste field is shorter. Under it: “4 agents from Grok Bot, in 2 parts · 1 routine can’t be set as written” (the tail amber). One sidebar-style row per agent: its badge in the colour it will have (the main one wears the Chief of Staff’s badge), the name with a chip (Merges into Chief of Staff, Updates, New in green), the role, and compact counts (Instructions · 3 memories · 2 routines). Finance’s counts end in amber “1 won’t be set”. Each row has a chevron. The primary button reads “Import 4 agents”.',
    // Steps run before a palette command, so these walk in: Agents mode, then
    // the sidebar note's Import agents.
    requires: '.agents-import-agent',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: PASTED_REPLY },
    ],
    commands: { agents_import_paste_preview: PASTE_PREVIEW },
  },
  {
    id: 'agents-import-paste-expanded',
    title: 'Agents — import, reading what came across',
    looksRightWhen:
      'Finance’s row is open (chevron turned down): under its name, small uppercase Instructions, Memory and Routines headings, the instructions word for word in a recessed box, memory as a dotted list, and the routine in amber with a warning mark: Won’t be set: “whenever rent is due”. Give it a day and a time.',
    requires: '.agents-import-agent[data-open]',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: PASTED_REPLY },
      { click: '.agents-import-agent:nth-child(2) .agents-import-agent__row' },
    ],
    commands: { agents_import_paste_preview: PASTE_PREVIEW },
  },
  {
    id: 'agents-import-long',
    title: 'Agents — import, a twelve-agent team with routines',
    looksRightWhen:
      '“12 agents from Grok Bot, in 3 parts · 4 routines can’t be set as written”. The list shows about five rows and scrolls inside itself; the dialog does not grow past the window and the footer with “Import 12 agents” stays in view.',
    requires: '.agents-import-agent',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: PASTED_REPLY },
    ],
    commands: { agents_import_paste_preview: LONG_PREVIEW },
  },
  {
    id: 'agents-import-paste-problems',
    title: 'Agents — import, a pasted reply with mistakes',
    looksRightWhen:
      'A calm amber-edged note under the paste, not a JSON debugger: a warning mark and one plain sentence (“That reply isn’t in the format we asked for — copy the message again and ask your assistant to reply with just the code block.”), then a quiet “Show details”. No line numbers, field names or “trailing comma” on screen until Show details is clicked. The agents that did read fine are still listed below. Import stays disabled.',
    requires: '.agents-import-problems',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: '```json\n{"agents":[{"name":"Finance",},]}\n```' },
    ],
    commands: {
      agents_import_paste_preview: {
        ...PASTE_PREVIEW,
        agents: PASTE_PREVIEW.agents.slice(0, 2),
        problems: [
          'Block 2 has a trailing comma at line 14 (a comma right before a } or ]). Delete that comma, or ask the assistant to send it again as valid JSON.',
          'Agent 3 in block 1 has no "name".',
          '“Travel”: "is_main" should be true or false, not text.',
        ],
      },
    },
  },
  {
    id: 'agents-import-done',
    title: 'Agents — import, done',
    looksRightWhen:
      'The tabs and steps are gone. Centred: a green check in a soft green circle, “Your team is here”, one muted line “2 new agents · 2 updated · 3 routines set”, the four agents as pills with their badges (the main one as Chief of Staff), and “Say hi to your team.” with when they start. The footer: Close, and a primary “Open Chief of Staff”.',
    requires: '.agents-import-done',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: PASTED_REPLY },
      { click: IMPORT_BUTTON },
    ],
    commands: { agents_import_paste_preview: PASTE_PREVIEW, agents_import_paste: IMPORTED },
  },
  {
    id: 'agents-import-done-refused',
    title: 'Agents — import, done with routines that weren’t set',
    looksRightWhen:
      'As agents-import-done, plus the same calm amber note as a pasted mistake: “A few things didn’t come across”, one line per routine naming the agent, its phrase and why, and a muted last line asking Finance and Inbox to schedule them in plain words.',
    requires: '.agents-import-done .agents-import-problems',
    clipSelector: '.agents-import',
    openSelector: AGENTS_TAB,
    steps: [
      { click: IMPORT_STARTER },
      { click: PASTE_LINK },
      { fill: '.agents-import__paste', value: PASTED_REPLY },
      { click: IMPORT_BUTTON },
    ],
    commands: {
      agents_import_paste_preview: PASTE_PREVIEW,
      agents_import_paste: {
        ...IMPORTED,
        routinesRefused: [
          {
            agent: 'Finance',
            when: 'whenever rent is due',
            what: 'Remind me to pay rent.',
            detail: 'Give it a day and a time.',
          },
          {
            agent: 'Inbox',
            when: 'whenever something urgent arrives',
            what: 'Ping me.',
            detail: 'Give it a day and a time.',
          },
        ],
      },
    },
  },
  {
    id: 'agents-import-other-app',
    title: 'Agents — import, the other app’s team is on this Mac',
    looksRightWhen:
      'A segmented pair under the title, “From Ship Studio” chosen beside “From another assistant”. The lede says each agent comes with its instructions, memory, files and chat history and picks up from its most recent messages, and that Chief of Staff gets a recap of Ship Studio’s Chief’s conversation. “5 agents in Ship Studio · 2 new, 1 merges into Chief of Staff”, then one row each: Chief of Staff with “Merges into Chief of Staff”, Finance and Travel “New”, Research muted “Already here”, Inbox muted with an amber “Stays behind” and why. Under the list one neutral recessed note with an info mark: secrets stay behind and who will ask again; 4 routines arrive paused while their copies in Ship Studio keep running; Finance works in the same project folder as Ship Studio’s copy. Then a checkbox, off: “Keep their “Always allow” rules (3)” with a muted line on what each choice means. Footer: “Nothing in Ship Studio changes…”, Cancel, primary “Import 2 agents and merge”.',
    command: 'agents.import',
    requires: '.agents-import-behind',
    clipSelector: '.agents-import',
    commands: { agents_other_app_preview: OTHER_APP_PREVIEW },
  },
  {
    id: 'agents-import-other-app-detail',
    title: 'Agents — import from the other app, reading an agent',
    looksRightWhen:
      'The same list with Finance open: “Conversation” (its chat history comes with it, picking up from the most recent messages), instructions in a recessed box, memory as a list, “Routines, arriving paused” with each schedule in bold, “Always allows: git push and example-bank.com”, and its project path with a muted line that its Ship Studio copy works in the same folder.',
    // Steps run before a palette command, so these walk in from the sidebar note.
    openSelector: AGENTS_TAB,
    requires: '.agents-import-agent[data-open]',
    clipSelector: '.agents-import',
    steps: [
      { click: IMPORT_STARTER },
      { click: '.agents-import-agent:nth-child(2) .agents-import-agent__row' },
    ],
    commands: { agents_other_app_preview: OTHER_APP_PREVIEW },
  },
  {
    id: 'agents-import-other-app-done',
    title: 'Agents — import from the other app, done',
    looksRightWhen:
      'The shared done state: “Your team is here”, “2 new agents · 1 updated”, three pills (Chief of Staff, Finance, Travel); Inbox in the calm amber “A few things didn’t come across” note; then a NEUTRAL recessed note (info mark, no amber) titled “Before they get going”: Finance will ask again for Stripe key and Bank login; 4 routines arrived paused and their copies keep running; “Always allow” rules stayed behind for Chief of Staff (npm test) and Finance; Research was already here. Then “Say hi to your team.”',
    openSelector: AGENTS_TAB,
    requires: '.agents-import-done .agents-import-behind',
    clipSelector: '.agents-import',
    steps: [{ click: IMPORT_STARTER }, { click: IMPORT_BUTTON }],
    commands: {
      agents_other_app_preview: OTHER_APP_PREVIEW,
      agents_other_app_import: {
        created: ['Finance', 'Travel'],
        updated: ['Chief of Staff'],
        skipped: [['Inbox', 'You already have an agent called Inbox here.']],
        routinesSet: [],
        routinesRefused: [],
        appName: 'Ship Studio',
        already: ['Research'],
        routinesPaused: 4,
        messages: 331,
        secretsLeft: [{ agent: 'Finance', secrets: ['Stripe key', 'Bank login'] }],
        rulesKept: [],
        rulesLeft: [
          { agent: 'Chief of Staff', rules: ['npm test'] },
          { agent: 'Finance', rules: ['git push', 'example-bank.com'] },
        ],
        filesSkipped: [],
      },
    },
  },
  {
    id: 'agents-import-connected',
    title: 'Agents — import, remote access on, before Start',
    looksRightWhen:
      'No other app here, so no segments: one path. The lede says the other assistant answers a short interview run as Chief of Staff and you review every agent before anything is created. Under it, a recessed two-column box: “It can” (answer questions about its agents; stage them for your review) and “It can’t” (see your chats, files, memory or other agents; create or change anything; start without you). Step 1 is ticked with “Remote access is on”; step 2 “Start, then send it a message” says Start allows one import, with a primary Start button; no message is shown yet. Step 3 “Allow it, then review in Chief of Staff’s chat”.',
    command: 'agents.import',
    requires: '[data-testid="agents-import-start"]',
    clipSelector: '.agents-import',
    commands: { get_remote_access_status: remoteStatus({ enabled: true, serverRunning: true }) },
  },
  {
    id: 'agents-import-started',
    title: 'Agents — import, armed with Start',
    looksRightWhen:
      'As agents-import-connected, after Start: step 2 now reads “Send it this message” with the message (it names import_conversation and says the import ends in your review) and a primary Copy message. The footer gained a quiet Cancel beside Done.',
    command: 'agents.import',
    requires: '.agents-import-message',
    clipSelector: '.agents-import',
    commands: {
      get_remote_access_status: remoteStatus({ enabled: true, serverRunning: true }),
      agents_import_talk: gateWith(null, true),
    },
  },
  {
    id: 'agents-import-connector-live',
    title: 'Agents — import, the interview going on',
    looksRightWhen:
      'As agents-import-started, but Grok is already talking: step 2 is folded and ticked with “Sent”; step 3 is current and reads, with a softly breathing blue dot, “Grok is answering Chief of Staff’s questions · Finance and Travel staged”, and “Open Chief of Staff” is the primary button. The footer has Stop import beside Done.',
    command: 'agents.import',
    requires: '.agents-import-watch__live',
    clipSelector: '.agents-import',
    commands: {
      get_remote_access_status: remoteStatus({ enabled: true, serverRunning: true }),
      agents_import_talk: gateWith({}),
    },
  },
  {
    id: 'agents-import-paste-fallback',
    title: 'Agents — import, pasting a reply instead (the fallback)',
    looksRightWhen:
      'The paste path, reached from “Can’t connect? Paste a reply instead”: its lede, then a quiet text link “Talk over the connector instead” under it, then the two numbered steps (the message to copy, the paste field) and the footer with Cancel and a disabled Import.',
    // Steps run before a palette command, so this walks in from the sidebar note.
    openSelector: AGENTS_TAB,
    requires: '.agents-import__paste',
    clipSelector: '.agents-import',
    steps: [{ click: IMPORT_STARTER }, { click: PASTE_LINK }],
    commands: {},
  },
  {
    id: 'agents-import-consent',
    title: 'Agents — another assistant asks to start an import',
    looksRightWhen:
      'The Chief’s chat ends on a request card: download icon, “Grok wants to bring its agents over”, prose that Grok talks to a separate, sealed conversation that can only stage agents and can’t see chats, files or other agents, nothing created until you import; then Grok’s first message in quotes. Deny and a neutral Allow on the right. Above the composer one bar, amber dot: “Import from Grok · Needs your OK” / “Nothing has been shared yet.”, and a plain secondary Stop (not red). The bar never mentions “the card”.',
    command: 'agents.open',
    requires: '[data-testid="agent-import-talk"][data-state="awaiting_consent"]',
    commands: {
      agents_overview: overview([{ ...TEAM[0], pendingApprovals: 1 }]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? [...CHIEF_CHAT.slice(0, 2), CONSENT_CARD] : messagesFor(args),
      agents_import_talk: gateWith({ state: 'awaiting_consent', staged: [], exchanges: 1 }),
    },
  },
  {
    id: 'agents-import-talk',
    title: 'Agents — the sealed import interview, live in the Chief’s chat',
    looksRightWhen:
      'The Chief’s chat. The answered consent card (“Allowed”), then a quiet note that Grok is talking to a separate, sealed conversation, not this chat. Grok’s lines sit on the left labelled “From Grok” over outlined recessed bubbles, in plain text exactly as sent; replies to Grok are indented, labelled “To Grok · from the sealed conversation” over dashed bubbles. The Chief’s row reads “Bringing in agents from Grok”. Above the composer one bar with a live accent dot: “Importing from Grok · Finance staged for review”, a muted line that what you type here stays between you and Chief of Staff, and a secondary Stop.',
    command: 'agents.open',
    requires: '[data-testid="agent-import-talk"][data-state="interviewing"]',
    commands: {
      agents_overview: overview([
        { ...TEAM[0], status: status('working', 'Talking to Grok (import)') },
        TEAM.find((a) => a.id === 'finance') ?? TEAM[1],
      ]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? IMPORT_TALK_CHAT : messagesFor(args),
      agents_import_talk: gateWith({ staged: ['Finance'], busy: true }),
    },
  },
  {
    id: 'agents-import-review',
    title: 'Agents — the review card: Grok’s agents, staged',
    looksRightWhen:
      'One card: download icon, “Bring in 2 agents from Grok”. A muted lede: read each agent’s instructions before you import; only what’s ticked is created; routines paused, logins asked for securely, no permissions. Grok’s summary in italics. Two rows in the same row component as the Ship Studio import: tick box, avatar, “Finance (from Grok)” with a neutral “Name taken here” chip, role, muted counts; under it its instructions in a recessed box in proportional type. “Travel” with a neutral “New”. An unticked “Add to Chief of Staff’s notes”. Right-aligned: Don’t import, then a neutral Import 2 agents. The bar above the composer has an amber dot: “Import from Grok · ready to review” / “Nothing is created until you import.”, and the card’s buttons are fully in view above it.',
    command: 'agents.open',
    requires: '[data-testid="agent-import-review"]',
    commands: {
      agents_overview: overview([
        { ...TEAM[0], pendingApprovals: 1 },
        TEAM.find((a) => a.id === 'finance') ?? TEAM[1],
      ]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? [...REVIEW_CHAT, REVIEW_CARD()] : messagesFor(args),
      agents_import_talk: gateWith({ state: 'review' }),
      agents_import_review_current: REVIEW,
    },
  },
  {
    id: 'agents-import-review-replace',
    title: 'Agents — the review card, replacing your Finance',
    looksRightWhen:
      'As agents-import-review with Finance opened: a segmented pair “Add as Finance (from Grok)” | “Replace your Finance”, Replace chosen. An amber list says every consequence: its instructions become these and its memory is kept; its role becomes “Tracks spending and chases invoices” (now “Keeps the books”); it starts a fresh conversation; its 2 routines are paused; it’s no longer bound to acme-site; its 3 “Always allow” rules are removed; its saved logins are removed: STRIPE_KEY, GITHUB_TOKEN. Under it an unticked “Keep its saved logins”. A recessed monospace diff: “− Keep the books in the shared sheet.” in red, “+ Track every expense in the books sheet.” in green, the unchanged lines plain. Then What it remembers, “Routines · arrive paused” and “Logins it asks for · on secure cards, never here” (stripe_key, bank_login). The name chip now reads “Replaces your Finance” in amber.',
    command: 'agents.open',
    requires: '.agent-import-review__diff',
    steps: [
      {
        click:
          '[data-testid="agent-import-review"] .agents-import-agent:first-child .agents-import-agent__row',
      },
      { click: '.agent-import-review__clash .segmented-control button:last-child' },
    ],
    commands: {
      agents_overview: overview([
        { ...TEAM[0], pendingApprovals: 1 },
        TEAM.find((a) => a.id === 'finance') ?? TEAM[1],
      ]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? [...REVIEW_CHAT, REVIEW_CARD()] : messagesFor(args),
      agents_import_talk: gateWith({ state: 'review' }),
      agents_import_review_current: REVIEW,
    },
  },
  {
    id: 'agents-import-review-done',
    title: 'Agents — the review card, imported',
    looksRightWhen:
      'The same card, answered: no checkboxes ticked, no buttons, and at its foot a check mark with “Imported Finance (from Grok), Travel”. Under it a quiet note: imported from Grok, Finance (from Grok) and Travel, they start when you message them, routines paused. No bar above the composer; the sidebar lists Finance (from Grok) and Travel.',
    command: 'agents.open',
    requires: '.agent-import-review__outcome',
    commands: {
      agents_overview: overview([
        TEAM[0],
        TEAM.find((a) => a.id === 'finance') ?? TEAM[1],
        agent('finance-grok', 'Finance (from Grok)', {
          shape: 2,
          color: 'orange',
          minutesAgo: 0,
          role: 'Tracks spending and chases invoices',
          preview: 'Imported from Grok. It starts when you message it; its routines are paused.',
          sessionId: null,
        }),
        agent('travel', 'Travel', {
          shape: 3,
          color: 'blue',
          minutesAgo: 0,
          role: 'Trips and bookings',
          preview: 'Imported from Grok. It starts when you message it; its routines are paused.',
          sessionId: null,
        }),
      ]),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief'
          ? [
              ...REVIEW_CHAT,
              REVIEW_CARD('allowed', 'Imported Finance (from Grok), Travel'),
              msg(
                'note',
                'Imported from Grok: Finance (from Grok), Travel. They start when you message them; routines are paused.',
                0
              ),
            ]
          : messagesFor(args),
      agents_import_talk: gateWith({
        state: 'imported',
        imported: ['Finance (from Grok)', 'Travel'],
      }),
    },
  },
  {
    id: 'agents-import-nudge',
    title: 'Agents — the import note at the foot of the agent list',
    looksRightWhen:
      'Under the last row, on the rows’ grid: a neutral icon tile in the badge column, then a short bold-ish title, one muted line, and a green “Import agents →” text action, all starting where the names above start. A faint × at the top right. A hairline under it like a row’s; no card, no fill. New agent and Import agents follow.',
    openSelector: AGENTS_TAB,
    requires: '.agents-import-nudge',
    clipSelector: '.agents-list',
    commands: {
      agents_overview: overview([TEAM[0], TEAM.find((a) => a.id === 'finance') ?? TEAM[1]]),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-streaming',
    title: 'Agents — a reply streaming in',
    looksRightWhen:
      'The first reply is complete; below it the second is still being written: plain agent bubble, same width and type as the rest, a soft dot breathing at the end of its last line, no typing dots under it. The header still says Working and the composer offers Stop. With ?freeze=off it plays live: words arrive every 40ms, the bubble grows without re-animating, and “Editing PricingCards.tsx” shows between the two blocks.',
    command: 'agents.open',
    requires: '.agent-bubble[data-streaming]',
    mockEvents: true,
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'chief' ? { ...a, status: status('working') } : a))
      ),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? streamMessages() : messagesFor(args),
    },
  },
  {
    id: 'agents-team-overview',
    title: 'Agents — What’s in flight (⌘K)',
    looksRightWhen:
      'Opened from ⌘K; the agent list has no Team row and no row is selected. The header reads “What’s in flight”. The main column shows four sections in a fixed order: Needs your OK (Lead Gen, with its Gmail card answerable in place), Working now (Acme Site, “Editing PricingTable.tsx”, with the loader), Scheduled next (Finance’s two active check-ins, soonest first, the paused one absent), Recent replies (newest first, one plain line each, with times). Rows share the sidebar’s badge and type.',
    command: 'agents.team',
    requires: '.agents-team .agent-approval',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-mention',
    title: 'Agents — @ in the composer offers the team',
    looksRightWhen:
      'Typing “@fi” opens the app’s menu surface upward from the composer’s left edge: Finance first (its name starts with “fi”), each row a mini badge, the name, and the role muted. The first row is highlighted; the field keeps focus. Earlier in the chat, “@Acme Site” in your bubble is tinted green.',
    openSelector: AGENTS_TAB,
    requires: '.agent-mention-menu',
    steps: [{ fill: '.agent-composer__input', value: 'Can you ask @fi' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-dictating',
    title: 'Agents — dictating into the composer',
    looksRightWhen:
      'The words arriving sit in the composer in the full text colour, never mistakable for the placeholder. The mic is green with a green halo sized by the voice level; the composer border is tinted green; in the paperclip’s place a pulsing dot says Listening with a Cancel beside it. Nothing reads as an error, and Send is unchanged.',
    // Steps run before a palette command, so walk in through the sidebar.
    openSelector: AGENTS_TAB,
    requires: '.agent-composer[data-dictation="listening"]',
    steps: [{ click: '.agent-composer__mic' }],
    mockEvents: true,
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      start_dictation: startListening,
      cancel_dictation: null,
      stop_dictation: null,
    },
  },
  {
    id: 'agents-dictation-blocked',
    title: 'Agents — dictation without microphone access',
    looksRightWhen:
      'One quiet line above the composer says the app (by its brand name) needs microphone access, with a link to open System Settings. The composer still works for typing.',
    // Steps run before a palette command, so walk in through the sidebar.
    openSelector: AGENTS_TAB,
    requires: '[data-bar="dictation"] .agent-bar',
    clipSelector: '.agent-chat__footer',
    steps: [{ click: '.agent-composer__mic' }],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      start_dictation: { status: 'blocked', reason: 'microphone' },
    },
  },
  {
    id: 'agents-always-allow',
    title: 'Agents — Always allow on an approval, and a call it allowed itself',
    looksRightWhen:
      'Acme Site’s chat: a quiet centred “Allowed automatically: npm run lint · Always allowed” line, then a “Run a command” card for npm test -- --run pricing. Deny and Allow sit on the right; on the left, apart and muted, “Always allow npm test” with npm test in mono. Its tooltip says any command starting with npm test runs without asking and that chained commands still ask.',
    requires: '.agent-approval__always',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith({ status: status('waiting', 'Waiting for your OK') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ALWAYS_CHAT : messagesFor(args),
      agents_answer_approval: null,
    },
  },
  {
    id: 'agents-always-allowed',
    title: 'Agents — two cards answered by one Always allow',
    looksRightWhen:
      'Acme Site’s chat: two “Run a command” cards (npm test -- --run pricing, then npm test -- --run checkout), both resolved, each reading “Always allowed · npm test” with npm test in mono, where the buttons were.',
    requires: '.agent-approval .agent-card__outcome',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith({ status: status('working', 'Running npm test') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ALWAYS_ALLOWED_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-permissions',
    title: 'Agents — what an agent may do without asking',
    looksRightWhen:
      'Editing Acme Site, under usage: a Permissions group listing “Commands starting with npm test”, “Commands starting with npm run lint”, “Web pages on vercel.com” and “Send an email · Gmail”, hairline-separated, each with a quiet Revoke on the right.',
    openSelector: AGENTS_TAB,
    requires: '.agent-permissions__rule',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: acmeWith({
        permissions: [
          ['command_prefix', 'npm test'],
          ['command_prefix', 'npm run lint'],
          ['domain', 'vercel.com'],
          ['tool', 'mcp__gmail__send_email', 'Send an email · Gmail'],
        ].map(([kind, value, label], i) => ({
          id: `rule-${i}`,
          kind,
          value,
          label: label ?? value,
          createdAt: now - i * MIN,
        })),
      }),
      agents_messages: messagesFor,
      agents_instructions: 'Owns the Acme marketing site.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
      agents_revoke_permission: null,
    },
  },
  {
    id: 'agents-queued',
    title: 'Agents — a message queued while the agent works',
    looksRightWhen:
      'Acme Site is Working. Earlier: a reply cut off with “Stopped”, a quiet centred “Interrupted to read your new message”, then the message that interrupted it and the reply. Then the working dots with “Editing PricingTable.tsx”, and only under them your newest message, slightly dimmed, with “Queued, sends when Acme Site finishes · Interrupt and send now” under it. The composer holds a second message, and beside the mic a faint “↵ queues · ⌘↵ interrupts and sends now”.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__queued',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { fill: '.agent-composer__input', value: 'And the 404 page.' },
    ],
    commands: {
      agents_overview: acmeWith({ status: status('working', 'Editing PricingTable.tsx') }),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? QUEUED_CHAT : messagesFor(args),
      agents_interrupt: true,
    },
  },
  {
    id: 'agents-fresh-suggested',
    title: 'Agents — a nearly full conversation suggests starting fresh',
    looksRightWhen:
      'Acme Site is idle. Under its last reply, one quiet centred line: “This conversation is getting long — Acme Site may lose track of early details. Start fresh (memory is kept)”, the last part an underlined, brighter link. Nothing else changed in the chat.',
    openSelector: AGENTS_TAB,
    requires: '.agent-fresh-hint',
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith(ACME_FULL),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-fresh-menu',
    title: 'Agents — Start fresh in the agent’s … menu',
    looksRightWhen:
      'The header’s … menu is open. After “Edit agent…” comes “Start fresh (87% full)…” with a reload icon, then the divider, Hide from sidebar and Delete…',
    openSelector: AGENTS_TAB,
    requires: '.ss-dropdown__item',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
    ],
    commands: {
      agents_overview: acmeWith(ACME_FULL),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-fresh-confirm',
    title: 'Agents — confirming a fresh start',
    looksRightWhen:
      'A small dialog: “Start Acme Site fresh?”, then that its next message starts a new conversation, its instructions and memory carry over, and anything it only knew from this conversation doesn’t. The hint says the chat stays. Cancel and a primary (not red) “Start fresh”.',
    openSelector: AGENTS_TAB,
    requires: '.modal-frame-content',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Start fresh' },
    ],
    commands: {
      agents_overview: acmeWith(ACME_FULL),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-fresh-divider',
    title: 'Agents — the chat after starting fresh',
    looksRightWhen:
      'Acme Site’s earlier conversation is all still there. Below it, a calm full-width divider: a hairline either side of “Started fresh · memory kept”. Under it the new conversation (the dark mode request and its reply). No “% full” nudge: the new conversation is small.',
    openSelector: AGENTS_TAB,
    requires: '.agent-fresh',
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: acmeWith(ACME_FRESH),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? FRESH_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-fresh-meter',
    title: 'Agents — how full the conversation is, in the editor',
    looksRightWhen:
      'Editing Acme Site: under This week / All time, a third quiet line “Conversation · 11% full · 21k of 200k tokens”. It is there only because the engine reported both numbers.',
    openSelector: AGENTS_TAB,
    requires: '.agent-editor__usage',
    clipSelector: '.agent-editor__usage',
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: acmeWith(ACME_FRESH),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? FRESH_CHAT : messagesFor(args),
      agents_instructions: 'Own the Acme marketing site. Ask before anything ships.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
    },
  },
  {
    id: 'agents-no-engine',
    title: 'Agents — the Chief’s engine (Claude Code) isn’t installed',
    looksRightWhen:
      'Codex is here but Claude Code isn’t, and this Chief has a conversation on Claude Code. The composer’s slot says “Chief of Staff runs on Claude Code, which isn’t installed on this Mac yet.” with “Set up Claude Code”; the header band is undisturbed and there is no send button.',
    command: 'agents.open',
    requires: '.agent-composer--blocked',
    commands: {
      agents_overview: {
        ...overview([{ ...TEAM[0], preview: null }]),
        engineReady: false,
        engines: ENGINES.map((e) =>
          e.id === 'claude' ? { ...e, installed: false, signedIn: false } : e
        ),
      },
    },
  },
  {
    id: 'agents-claude-signed-out',
    title: 'Agents — Claude Code signed out',
    looksRightWhen:
      'Claude Code is installed but its sign-in lapsed: before anything is typed, the composer’s slot says “Chief of Staff runs on Claude Code, which is signed out on this Mac.” with a “Sign in” button. No send button.',
    command: 'agents.open',
    requires: '.agent-composer--blocked',
    commands: {
      agents_overview: {
        ...overview([{ ...TEAM[0], preview: null }]),
        engines: ENGINES.map((e) => (e.id === 'claude' ? { ...e, signedIn: false } : e)),
      },
    },
  },
  {
    id: 'agents-no-engine-at-all',
    title: 'Agents — set up on another agent CLI (no Claude Code or Codex)',
    looksRightWhen:
      'Someone set up on Opencode, Cursor or their own agent: Agents explains in one panel that agents run on Claude Code or Codex, with “Set up Claude Code” (primary) and “Set up Codex”, and a quiet link back to their projects. No chat, no composer.',
    command: 'agents.open',
    requires: '.agents-no-engine',
    commands: {
      agents_overview: {
        ...overview([{ ...TEAM[0], preview: null }]),
        engineReady: false,
        engines: ENGINES.map((e) => ({ ...e, installed: false, signedIn: false })),
      },
    },
  },

  // ---------------------------------------------------- the mode toggle
  {
    id: 'mode-toggle-home',
    startOn: 'projects',
    title: 'Mode toggle — on the dashboard, an agent waiting',
    looksRightWhen:
      'A text-only “Projects | Agents” segmented control directly above Search, 30px tall like it, with exactly Search’s left and right edges. Projects is selected. A small amber badge sits in the Agents segment’s top-right corner and both labels are centred in their halves. No Agents row under Search and no + beside the toggle.',
    requires: '.mode-toggle .mode-toggle__dot',
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-tooltip',
    startOn: 'projects',
    title: 'Mode toggle — the Agents tooltip names who wants you',
    looksRightWhen: 'Hovering Agents shows “Lead Gen needs your OK · 1 unread (⌘⇧A)”.',
    requires: '.mode-toggle .mode-toggle__dot',
    steps: [{ hover: AGENTS_TAB }],
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-workspace',
    title: 'Mode toggle — inside a project',
    looksRightWhen:
      'The toggle sits above Search in the project sidebar, Projects selected, the amber badge on Agents. The titlebar has no Agents button. The hairline under Search continues the preview toolbar’s bottom hairline in one straight line.',
    project: WORKSPACE_PROJECT,
    requires: '.workspace-body .mode-toggle .mode-toggle__dot',
    storage: {
      elementTreeVisible: '0',
      [`shipstudio.layout.project:${WORKSPACE_PROJECT}`]: JSON.stringify({
        order: ['agent', 'preview'],
        floating: [],
        widths: {},
      }),
    },
    commands: {
      ...workspaceCommands,
      // A feature branch, so the "editing main" banner doesn't sit between
      // the header and the toolbar whose hairline the sidebar's must meet.
      get_current_branch: 'feat/pricing-page',
      get_hide_main_branch_warning: true,
      agents_overview: overview(),
    },
  },
  {
    id: 'mode-toggle-agents',
    title: 'Mode toggle — Agents mode, reached by the toggle',
    looksRightWhen:
      'Agents is selected and carries no badge (the list shows who wants you). Conversation search sits where Search was, at the same edges. The list ends in a “New agent” row like the project list’s “Open project”.',
    openSelector: AGENTS_TAB,
    requires: '.agents-list [data-agent-id="chief"]',
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-collapsed',
    startOn: 'projects',
    title: 'Mode toggle — collapsed sidebar',
    looksRightWhen:
      'In the rail the toggle is two stacked icons (folder, agents) in one 30px-wide segmented column, Projects selected, the amber badge on the agents icon’s corner. Search sits under it as an icon.',
    requires: '.workspace-sidebar.is-hidden .mode-toggle--stacked .mode-toggle__dot',
    steps: [{ click: '.workspace-sidebar-toggle' }],
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-agents-collapsed',
    title: 'Mode toggle — collapsed sidebar in Agents mode',
    looksRightWhen:
      'The stacked icon toggle has Agents selected and no badge; the agent badges follow below.',
    openSelector: AGENTS_TAB,
    requires:
      '.workspace-sidebar.is-hidden .mode-toggle--stacked [data-tab-value="agents"].is-active',
    steps: [{ click: '.workspace-sidebar-toggle' }],
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-compact-home',
    startOn: 'projects',
    title: 'Mode toggle — compact window, dashboard',
    looksRightWhen:
      'No sidebar below 750px, so the toggle is a folder | agents icon pair at the top-left, clear of the traffic lights, 24px tall like the compact top bar’s controls. Projects is selected; the amber badge straddles the agents segment’s corner.',
    viewport: { width: 700, height: 800 },
    requires: '.project-card',
    commands: { agents_overview: overview() },
  },
  {
    id: 'mode-toggle-compact-agents',
    title: 'Mode toggle — compact window, Agents',
    looksRightWhen:
      'The icon pair replaces the old Home button at the header’s leading edge, Agents selected, at the same x as on the dashboard. The title stays centred; Home is still in the agent switcher.',
    viewport: { width: 700, height: 800 },
    command: 'agents.open',
    requires: '.agent-chat',
    commands: { agents_overview: overview(), agents_messages: messagesFor },
  },
  {
    id: 'mode-toggle-compact-workspace',
    title: 'Mode toggle — compact window, project',
    looksRightWhen:
      'The compact top bar leads with the icon pair (Projects selected, badge on agents), then the dev-server dot, pin, ⌘K and the project picker on the right. Same height as those controls.',
    viewport: { width: 700, height: 800 },
    project: WORKSPACE_PROJECT,
    requires: '.compact-topbar',
    commands: { ...workspaceCommands, agents_overview: overview() },
  },
  secretScenario(
    'pending',
    'Finance’s chat: a card with a lock, “Finance needs your Stripe key”, the purpose under it, one masked “API key” field, a muted line saying it’s kept in the Keychain for Finance only and Finance never sees it, then Deny and a disabled Save on the right.'
  ),
  secretScenario(
    'allowed',
    'The same card resolved: no field or buttons, a green “Saved to your Keychain · Finance can use it now”, then Finance’s reconciliation reply.'
  ),
  secretScenario(
    'denied',
    'The same card resolved: a muted “Declined · Finance was told”, then Finance offering the CSV route instead.'
  ),
  {
    id: 'agents-secrets-editor',
    title: 'Agents — the Secrets list in Edit agent',
    looksRightWhen:
      'Editing Finance, below Permissions: a Secrets group listing stripe_key ($STRIPE_KEY) and bank ($BANK_USERNAME, $BANK_PASSWORD), each with its purpose, when it was added and when a turn last had it (or “not used yet”), hairline-separated, each with a quiet Revoke on the right.',
    openSelector: AGENTS_TAB,
    requires: '.agent-secrets__row',
    clipSelector: '.agent-editor [role="group"][aria-label="Secrets"]',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: financeWith({
        secrets: [
          {
            id: 's1',
            ...STRIPE_REQUEST,
            purpose: 'Read payouts to reconcile against the bank export',
            createdAt: now - 3 * 24 * 60 * MIN,
            lastUsedAt: now - 2 * 60 * MIN,
          },
          {
            id: 's2',
            name: 'bank',
            purpose: 'Download monthly statements',
            kind: 'password',
            fields: [
              { label: 'Username', env: 'BANK_USERNAME' },
              { label: 'Password', env: 'BANK_PASSWORD' },
            ],
            reference: 'secret:finance/bank',
            createdAt: now - 20 * MIN,
          },
        ],
      }),
      agents_messages: messagesFor,
      agents_instructions: 'Invoices, expenses and the books.',
      agents_usage: { week: totals(6, 120_000, 1.2, 9), allTime: totals(40, 900_000, 9.4, 70) },
      agents_revoke_secret: null,
    },
  },
  {
    id: 'agents-secret-paste-hint',
    title: 'Agents — a key pasted in the composer',
    looksRightWhen:
      'Above Finance’s composer, a quiet line: “That looks like a Stripe key. Keep it out of the chat?” with “Store it securely” and “Dismiss”. The composer holds the message with the key; nothing is blocked.',
    openSelector: AGENTS_TAB,
    requires: '[data-bar="secret"] .agent-bar',
    steps: [
      { click: '[data-agent-id="finance"]' },
      {
        fill: '.agent-composer__input',
        value: 'Here is the Stripe key: sk_live_51HxAbCdEfGhIjKlMnOpQr',
      },
    ],
    commands: {
      agents_overview: financeWith({}),
      agents_messages: messagesFor,
      agents_add_secret: null,
    },
  },
];
