/**
 * A heavy, realistic team after a Grok import: the Chief and 21 imported
 * agents, sixteen of them waiting on a login or an OK, two working, three
 * rooms, every imported routine paused, and long chats (the Chief's last
 * reply is a long markdown answer with lists, a table and code).
 *
 * Unlike `agents-stress` (synthetic names, for perf), this is for looking:
 * realistic-length names and colours, the mix of states the sidebar and What's
 * in flight have to sort at once. Fixtures only; every name, address and
 * figure here is made up (a small homeware brand).
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, agent, msg, now, overview, status } from './agents';
import { FULL_INVENTORY } from './agentsUsage';

const H = 60 * MIN;
const DAY = 24 * H;

interface Seat {
  id: string;
  name: string;
  color: string;
  role: string;
  /** What the row says when nothing else is going on. */
  preview: string;
  minutesAgo: number;
  /** Logins it asked for on import, still open. */
  logins?: string[];
  /** An Allow / Deny card it is waiting on mid-turn. */
  asks?: { title: string; detail: string; tool: string };
  working?: string;
  unread?: number;
  pinned?: boolean;
  muted?: boolean;
  engine?: 'claude' | 'codex';
}

const SEATS: Seat[] = [
  {
    id: 'pitches',
    name: 'Pitches',
    color: 'blue',
    role: 'Writes the wholesale pitch emails for the spring range.',
    preview: 'Two things are waiting on you, and I couldn’t fully check one of them.',
    minutesAgo: 8,
    logins: ['crm_api_key'],
  },
  {
    id: 'lisbon',
    name: 'Lisbon Office',
    color: 'teal',
    role: 'The lease, the fit-out and the opening date for the new office.',
    preview: 'The lease is ready; two pages need your signature.',
    minutesAgo: 15,
    logins: ['mail_app_password', 'esign_token'],
  },
  {
    id: 'triage',
    name: 'Inbox Triage',
    color: 'red',
    role: 'Watches the team chat and mailbox for anything addressed to you.',
    preview: 'Three threads tagged you overnight; one needs an answer today.',
    minutesAgo: 12,
    logins: ['chat_bot_token', 'chat_user_token', 'wiki_token'],
  },
  {
    id: 'forum',
    name: 'Customer Forum Helper',
    color: 'pink',
    role: 'Answers questions on the customer forum and flags bugs.',
    preview: 'Two new bug reports, both about checkout on older iPhones.',
    minutesAgo: 25,
    logins: ['forum_bot_token'],
  },
  {
    id: 'storedev',
    name: 'Storefront Dev',
    color: 'green',
    role: 'Builds and maintains the online store.',
    preview: '',
    minutesAgo: 2,
    working: 'Editing src/components/CheckoutSummary.tsx',
    engine: 'codex',
  },
  {
    id: 'recruiting',
    name: 'Recruiting',
    color: 'brown',
    role: 'Screens candidates and books interviews.',
    preview: 'Marco replied; he can do Thursday at 3.',
    minutesAgo: 40,
    logins: ['ats_api_key', 'calendar_token'],
    unread: 1,
  },
  {
    id: 'storeqa',
    name: 'Storefront QA',
    color: 'purple',
    role: 'Weekly checks across the store and the brand sites.',
    preview: '',
    minutesAgo: 1,
    working: 'Checking 14 pages at 375px',
  },
  {
    id: 'social',
    name: 'Social Drafts',
    color: 'amber',
    role: 'Drafts posts in the brand’s voice. Never publishes.',
    preview: 'Three drafts for Thursday are ready.',
    minutesAgo: 180,
    asks: {
      title: 'Schedule a post · Scheduler',
      detail: 'Thursday 9:00 · “Our spring range is in, and it ships free this week…”',
      tool: 'mcp__scheduler__schedule_post',
    },
  },
  {
    id: 'warehouse',
    name: 'Warehouse Lease',
    color: 'white',
    role: 'Renewing the warehouse lease and moving stock between units.',
    preview: 'The landlord quoted $6,400 a month; the new unit is free from the 1st.',
    minutesAgo: 60 * 3,
    logins: ['bank_portal_login'],
  },
  {
    id: 'forecast',
    name: 'Revenue Forecast',
    color: 'blue',
    role: 'Keeps the quarterly forecast and the wholesale pipeline current.',
    preview: 'Pipeline is $84k weighted; two orders slipped to February.',
    minutesAgo: 60 * 5,
    logins: ['crm_token'],
  },
  {
    id: 'support',
    name: 'Support Desk',
    color: 'orange',
    role: 'Answers order and returns tickets.',
    preview: 'The helpdesk export has 1,204 open tickets; 31 have no order number.',
    minutesAgo: 60 * 7,
    logins: ['helpdesk_api_key'],
  },
  {
    id: 'mobile',
    name: 'Mobile App',
    color: 'gray',
    role: 'The shopping app: builds, TestFlight, store listings.',
    preview: 'Build 42 is on TestFlight.',
    minutesAgo: 60 * 9,
    pinned: true,
  },
  {
    id: 'generalist',
    name: 'Generalist',
    color: 'teal',
    role: 'Picks up whatever falls between the others.',
    preview: 'Nothing pending.',
    minutesAgo: 60 * 10,
  },
  {
    id: 'vans',
    name: 'Delivery Vans',
    color: 'red',
    role: 'Insurance, servicing and replacing the delivery vans.',
    preview: 'Nothing is blocked. The listing goes up once you send photos.',
    minutesAgo: 60 * 11,
  },
  {
    id: 'docs',
    name: 'Help Centre Writer',
    color: 'pink',
    role: 'Writes and updates the help centre articles.',
    preview: 'The articles for the new returns policy are drafted.',
    minutesAgo: 60 * 12,
    logins: ['github_token', 'docs_cms_token'],
  },
  {
    id: 'research',
    name: 'Market Research',
    color: 'green',
    role: 'Researches stockists before the first pitch goes out.',
    preview: '40 stockists researched; 12 look like a fit.',
    minutesAgo: 60 * 14,
    logins: ['research_api_key'],
  },
  {
    id: 'finance',
    name: 'Finance',
    color: 'brown',
    role: 'Invoices, expenses and the books.',
    preview: 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).',
    minutesAgo: 60 * 16,
    logins: ['payments_key', 'ledger_token', 'bank_api_token'],
  },
  {
    id: 'tradeshow',
    name: 'Trade Show',
    color: 'purple',
    role: 'The stand, the shipping and the schedule for the spring fair.',
    preview: 'The stand is booked for the 14th; bring the signed forms.',
    minutesAgo: 60 * 20,
    logins: ['mail_app_password', 'venue_portal_login'],
  },
  {
    id: 'infra',
    name: 'Infrastructure',
    color: 'amber',
    role: 'Watches certificates, DNS, backups and dependency alerts.',
    preview: 'Two Dependabot alerts are high; both have fixes.',
    minutesAgo: 60 * 22,
    logins: ['dns_token', 'hosting_token', 'error_tracker_token'],
    muted: true,
  },
  {
    id: 'partners',
    name: 'Partner Emails',
    color: 'white',
    role: 'Sends the stockist sequences and handles replies.',
    preview: 'Needs your OK',
    minutesAgo: 60 * 26,
    asks: {
      title: 'Send an email · Mail',
      detail: 'To: dana@northwind.example · “Spring range for Northwind”',
      tool: 'mcp__mail__send_email',
    },
  },
  {
    id: 'prospects',
    name: 'Prospect List',
    color: 'blue',
    role: 'Finds and qualifies stockists across Europe.',
    preview: '18 new prospects this week; 5 are warm intros.',
    minutesAgo: 60 * 30,
    logins: ['leads_api_key'],
  },
];

/** Every imported routine arrives paused (docs/agents.md, "Import"). */
const pausedRoutine = (id: string, note: string) => ({
  id: `${id}-r1`,
  note,
  repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  nextAt: now + DAY,
  createdAt: now - 2 * DAY,
  paused: true,
});

const pending = (s: Seat) => (s.logins?.length ?? 0) + (s.asks ? 1 : 0);

const chief = {
  ...TEAM[0],
  lastActivityAt: now - 4 * MIN,
  preview: 'Here’s where the team stands after the import, and what I’d do first.',
};

const team = () =>
  overview([
    chief as unknown as ReturnType<typeof agent>,
    ...SEATS.map((s, i) =>
      agent(s.id, s.name, {
        color: s.color,
        shape: i % 12,
        role: s.role,
        minutesAgo: s.minutesAgo,
        unread: s.unread ?? 0,
        pinned: s.pinned ?? false,
        muted: s.muted ?? false,
        engine: s.engine ?? 'claude',
        pendingApprovals: pending(s),
        preview: s.working ? s.preview || null : s.preview,
        checkIns: [pausedRoutine(s.id, `Morning check for ${s.name}`)],
        status: s.working
          ? {
              ...status('working', s.working),
              work: {
                startedAt: now - 3 * MIN,
                stepCount: 9,
                fileCount: 2,
                doing: s.working,
                steps: [
                  { at: now - 170_000, kind: 'read', label: 'Read the brief' },
                  { at: now - 60_000, kind: 'edit', label: s.working },
                ],
              },
            }
          : s.asks
            ? status('waiting', 'Waiting for your OK')
            : status('idle'),
      })
    ),
  ]);

// ── the Chief's chat ───────────────────────────────────────────────

const LONG_REPLY = [
  '## Where the team stands',
  '',
  'All 21 agents came over from Grok. **16 of them are waiting on you**, almost all for the logins they used there; nothing runs until you answer, and every routine is paused.',
  '',
  '### What I’d do first',
  '',
  '1. **Finance** — add `payments_key` and `ledger_token`. Two invoices are overdue and it can’t chase them without the payments key.',
  '2. **Partner Emails** — one email to Dana at Northwind is waiting on your OK. Read it first; it quotes last year’s prices.',
  '3. **Infrastructure** — the DNS token. A certificate on `shop.example.com` expires in 6 days.',
  '   - The other two (hosting, error tracking) can wait.',
  '   - If you’d rather not give it DNS access, a read-only token is enough for the certificate check.',
  '4. Everyone else can wait until the weekend.',
  '',
  '### By agent',
  '',
  '| Agent | Waiting on | Since | Blocking |',
  '| --- | --- | --- | --- |',
  '| Finance | 3 logins | 16 h | Overdue invoices |',
  '| Partner Emails | 1 email | 26 h | Northwind sequence |',
  '| Infrastructure | 3 logins | 22 h | Certificate renewal on shop.example.com |',
  '| Inbox Triage | 3 logins | 12 min | Overnight mentions |',
  '| Support Desk | 1 login | 7 h | Ticket export from the old helpdesk |',
  '',
  '### The routine I’d turn back on first',
  '',
  'Storefront QA’s weekly check found a broken layout last month. This is the schedule it had in Grok, as it will run here:',
  '',
  '```yaml',
  'every: weekdays 09:00',
  'sites:',
  '  - shop.example.com',
  '  - example.org',
  '  - example.net',
  'widths: [375, 768, 1280]',
  'report_to: chief',
  '```',
  '',
  '> Nothing here has been checked against the live sites yet; I only read what Grok had.',
  '',
  'Want me to open Finance’s cards first?',
].join('\n');

const CHIEF_CHAT = [
  msg('note', 'Imported 21 agents from Grok', 60 * 30),
  ...Array.from({ length: 24 }, (_, i) =>
    i % 2 === 0
      ? msg(
          'user',
          [
            'Morning. Anything on fire?',
            'Who owns the checkout fix?',
            'Can Finance chase Northwind?',
            'What did Storefront QA find?',
          ][i % 4],
          60 * 29 - i * 60
        )
      : msg(
          'agent',
          [
            'Nothing’s on fire. Inbox Triage has three mentions for you; one is from Dana and needs an answer today.',
            'Storefront Dev has it. It’s editing the checkout summary now and will share a preview when the mobile layout holds at 375px.',
            'It can once it has the payments key; it asked for it on a card in its chat.',
            'Two pages overflow at 375px on shop.example.com: the product grid and the footer. It has screenshots of both.',
          ][(i - 1) % 4],
          60 * 29 - i * 60
        )
  ),
  msg('user', 'Where does everyone stand after the import? What should I do first?', 6),
  msg('agent', LONG_REPLY, 4),
];

const seatChat = (s: Seat) => [
  msg(
    'note',
    'Imported from Grok. It starts when you message it; its routines are paused.',
    60 * 30,
    {
      agentId: s.id,
    }
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    msg(
      i % 2 ? 'agent' : 'user',
      i % 2
        ? `${s.preview || 'On it.'} ${'I’ll keep the details in my notes so you don’t have to repeat them. '.repeat(1 + (i % 3))}`
        : `Quick one for ${s.name}: anything new since yesterday?`,
      60 * 28 - i * 90,
      { agentId: s.id }
    )
  ),
  ...(s.logins ?? []).map((name, i) =>
    msg('approval', '', 30 - i * 0.1, {
      agentId: s.id,
      approval: {
        requestId: `login-${s.id}-${name}`,
        title: `Secure input · ${name}`,
        detail: `${s.name} used this with Grok.`,
        status: 'pending',
        secret: {
          name,
          purpose: `${s.name} used this with Grok.`,
          kind: name.endsWith('password') ? 'password' : 'token',
          fields: [{ label: 'Value', env: name.toUpperCase() }],
          reference: `secret:${s.id}/${name}`,
          quiet: true,
        },
      },
    })
  ),
  ...(s.asks
    ? [
        msg('approval', '', 20, {
          agentId: s.id,
          approval: {
            requestId: `ask-${s.id}`,
            title: s.asks.title,
            detail: s.asks.detail,
            status: 'pending',
            tool: s.asks.tool,
          },
        }),
      ]
    : []),
];

const CHATS: Record<string, unknown[]> = Object.fromEntries<unknown[]>([
  ['chief', CHIEF_CHAT],
  ...SEATS.map((s): [string, unknown[]] => [s.id, seatChat(s)]),
]);

// ── rooms ──────────────────────────────────────────────────────────

const room = (over: Record<string, unknown>) => ({
  muted: false,
  createdAt: now - 3 * DAY,
  lastActivityAt: now - 2 * H,
  unread: 0,
  turnsUsed: 0,
  turnCap: 8,
  waiting: [],
  ...over,
});

const ROOMS = [
  room({
    id: 'pipeline',
    name: 'Pipeline',
    members: ['research', 'partners', 'prospects', 'forecast'],
    preview: 'Partner Emails: The Northwind email is waiting on your OK.',
    unread: 2,
    lastActivityAt: now - 30 * MIN,
  }),
  room({
    id: 'launch',
    name: 'Spring range launch',
    members: ['chief', 'docs', 'forum', 'social'],
    lead: 'chief',
    preview: 'Social Drafts: Three drafts for Thursday are ready.',
  }),
  room({
    id: 'store',
    name: 'Storefront',
    members: ['storedev', 'storeqa', 'support'],
    preview: 'Storefront QA: Two pages overflow at 375px.',
    lastActivityAt: now - DAY,
  }),
];

const NAMES: Record<string, [string, string]> = Object.fromEntries<[string, string]>([
  ['chief', ['Chief of Staff', 'white']],
  ...SEATS.map((s): [string, [string, string]] => [s.id, [s.name, s.color]]),
]);

/** `agents_search` over every chat, as the backend does: message text, newest first. */
const search = (args: Record<string, unknown>) => {
  const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
  return Object.values(CHATS)
    .flat()
    .map((m) => m as ReturnType<typeof msg>)
    .filter((m) => m.kind !== 'approval' && m.kind !== 'note')
    .filter((m) => words.every((w) => m.text.toLowerCase().includes(w)))
    .sort((a, b) => b.ts - a.ts)
    .map((m) => ({
      agentId: m.agentId,
      agentName: NAMES[m.agentId][0],
      agentColor: NAMES[m.agentId][1],
      messageId: m.id,
      ts: m.ts,
      kind: m.kind,
      snippet: m.text
        .replace(/[*`#|>]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 160),
    }));
};

const commands = {
  agents_instructions:
    'Answer questions on the customer forum within a day. Flag anything that looks like a bug to Storefront Dev; never promise dates.',
  agents_search: search,
  agents_overview: team,
  agents_messages: (args: Record<string, unknown>) => CHATS[String(args.agentId)] ?? [],
  agents_rooms: ROOMS,
  agents_room_focus: null,
  agents_room_messages: () => [],
  agents_usage_overview: FULL_INVENTORY,
};

const NARROW = { width: 1100, height: 760 };

const base = {
  openSelector: AGENTS_TAB,
  requires: '.agents-list__row',
  commands,
};

export const agentsHeavyScenarios: Scenario[] = [
  {
    ...base,
    id: 'agents-heavy',
    title: 'Agents — the real shape: Chief + 21 imported agents, 16 waiting',
    looksRightWhen:
      'Sidebar: “Needs your OK · 16” first, then the Chief (pinned) and Mobile App (pinned), then the 16 waiting on you, the two working, and the rest by recent activity; the two working agents show their activity line in the working colour; Customer Forum Helper fits on one line beside its dot. The Chief’s chat ends on a long markdown reply (headings, a numbered list with a nested list, a five-column table, a YAML block, a quote) that sits inside the reading column. Rooms below the agents.',
  },
  {
    ...base,
    id: 'agents-heavy-narrow',
    title: 'Agents — 22 agents in an 1100px window',
    looksRightWhen:
      'As agents-heavy in a narrower window: the sidebar keeps its width, names and previews ellipsise on one line each, the table in the Chief’s reply scrolls inside itself rather than pushing the column wider.',
    viewport: NARROW,
  },
  {
    ...base,
    id: 'agents-heavy-inflight',
    title: 'Agents — What’s in flight with 16 agents waiting and 2 working',
    looksRightWhen:
      'What’s in flight: the 16 agents needing you first, each one row with its count of requests; the two working ones under it; nothing overflowing.',
    requires: '.agents-team',
    steps: [{ click: '.agents-list__needs-you' }],
  },
  {
    ...base,
    id: 'agents-heavy-search',
    title: 'Agents — searching across 22 agents',
    looksRightWhen:
      'Typing “storefront” in the top field: the agent list gives way to results; agents whose name matches (Storefront Dev, Storefront QA) come first.',
    steps: [{ fill: '.agents-top-search input', value: 'storefront' }],
    requires: '.agents-list',
  },
  {
    ...base,
    id: 'agents-heavy-agent',
    title: 'Agents — an imported agent with three login cards',
    looksRightWhen:
      'Finance’s chat: the import note, its exchanges, then three secure cards at the foot. The row is current in the sidebar and the sidebar kept its scroll position.',
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '.agent-secret',
  },
  {
    ...base,
    id: 'agents-heavy-editor',
    title: 'Agents — editing an agent with a long name',
    looksRightWhen:
      'Edit agent for Customer Forum Helper (the longest name): the name fits its field; the dialog does not grow sideways.',
    steps: [
      { click: '[data-agent-id="forum"]' },
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'Edit Customer Forum Helper' },
      { click: '.command-palette [role="option"]', text: 'Edit Customer' },
    ],
    requires: '.agent-editor',
  },
  {
    ...base,
    id: 'agents-heavy-settings',
    title: 'Settings → Agents with 22 agents',
    looksRightWhen:
      'Settings on its Agents tab with the heavy roster behind it: nothing in Settings lists every agent, so 22 agents change nothing here; the Usage group reads as in settings-agents-usage.',
    command: 'agents.usage',
    requires: '.agents-usage .agents-usage__line',
    commands: {
      ...commands,
      agents_desktop_settings: {
        supported: true,
        menuBarIcon: false,
        quickEntry: true,
        shortcut: 'Alt+Space',
        shortcutLabel: '⌥Space',
      },
    },
  },
];
