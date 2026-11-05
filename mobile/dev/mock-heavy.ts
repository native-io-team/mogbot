/**
 * `--heavy`: an account in daily use. Seventeen agents (the mock's six plus
 * eleven more that came over from Grok), a pile of cards waiting (logins and
 * keys among them), routines that arrived paused, long chats with markdown,
 * code, timelines and result cards, and an import still going.
 *
 * What the phone looks like for its owner a week in, not on day one.
 */

import type { Agent, AgentMessage, CheckIn } from '@shipstudio/companion-protocol';

type Add = (m: Omit<AgentMessage, 'id' | 'agentId'>) => void;

/** The imported ones: name, role, colour, and how many cards each has waiting. */
const IMPORTED: [id: string, name: string, role: string, color: string, waiting: number][] = [
  ['scout', 'Scout', 'Research and news briefs', 'orange', 3],
  ['inbox', 'Inbox Zero', 'Triage email and draft replies', 'red', 8],
  ['travel', 'Travel Desk', 'Flights, hotels and itineraries', 'pink', 2],
  [
    'recruit',
    'Recruiting Coordinator for the Platform Team',
    'Schedules interviews, chases scorecards and keeps the hiring pipeline moving',
    'brown',
    4,
  ],
  ['legal', 'Legal', 'Contracts and NDAs', 'gray', 1],
  ['social', 'Social Media Manager', 'Posts, replies and the content calendar', 'purple', 6],
  ['podcast', 'Podcast Producer', 'Guests, show notes and publishing', 'teal', 0],
  ['home', 'Home & Family Logistics', 'School pickups, repairs and groceries', 'green', 3],
  ['health', 'Health Coach', 'Training plan and meals', 'blue', 0],
  ['investors', 'Investor Updates', 'Monthly update and the data room', 'amber', 4],
  ['ci', 'Research Analyst — Competitive Intelligence', 'Tracks competitors weekly', 'red', 2],
];

const LONG_MARKDOWN = `Here’s the week, by channel:

## Email
- **142** new, **9** need you (I drafted replies to 6)
- Two invoices flagged as possible phishing, quarantined

## Calendar
1. Tuesday’s board prep moved to **10:30**
2. Thursday has three back-to-backs; I held 30 minutes after the second

| Thread | From | Waiting since | Draft |
| --- | --- | --- | --- |
| Renewal pricing | Dana at Northwind | Mon | Ready |
| Offsite venue | Priya | Tue | Ready |
| Podcast intro | Sam (guest) | Wed | Needs you |

\`\`\`text
Subject: Re: Renewal pricing
Hi Dana, thanks for the quick turnaround. We can do the 2-year term at the
quoted rate if the seat cap moves to 60. Happy to sign this week.
\`\`\`

> Nothing goes out until you press Allow on each one.`;

const CODE_REPLY = `The scraper broke because the site moved prices into a JSON blob. Fixed:

\`\`\`ts
const data = JSON.parse(document.querySelector('#__NEXT_DATA__')!.textContent!);
const prices = data.props.pageProps.plans.map((p: { name: string; monthly: number }) => ({
  plan: p.name,
  monthly: p.monthly,
}));
\`\`\`

Ran it against all four competitors: \`ok\` for each, and the sheet is updated.`;

function routine(
  id: string,
  note: string,
  days: number[],
  hour: number,
  at: number,
  now: number
): CheckIn {
  return {
    id,
    note,
    repeat: { kind: 'days', days, hour, minute: 0 },
    nextAt: at,
    createdAt: now - 6 * 86_400_000,
    paused: true,
  };
}

function work(at: number, steps: string[], files: string[] = []): AgentMessage['work'] {
  return {
    startedAt: at - 90_000,
    endedAt: at,
    stepCount: steps.length,
    fileCount: files.length,
    files,
    steps: steps.map((label, i) => ({
      at: at - 90_000 + i * 5000,
      kind: label.startsWith('Read') ? 'read' : label.startsWith('Searched') ? 'web' : 'tool',
      label,
    })),
  } as AgentMessage['work'];
}

const email = (i: number) => ({
  to: 'dana@northwind.example',
  subject: `Re: Renewal pricing (${i + 1})`,
  body: 'Hi Dana, thanks for the quick turnaround. We can do the 2-year term at the quoted rate if the seat cap moves to 60. Happy to sign this week.',
});

/** The cards an agent has waiting, by kind, in turn: plain, login, key, command. */
function waitingCards(id: string, n: number, now: number, add: Add) {
  for (let i = 0; i < n; i++) {
    const ts = now - (n - i) * 7 * 60_000;
    const requestId = `req_${id}_${i}`;
    const kind = (i + id.length) % 4;
    if (kind === 1) {
      add({
        ts,
        kind: 'approval',
        text: '',
        approval: {
          requestId,
          title: 'Secure input · Account login',
          detail: 'Sign in to keep working where Grok left off',
          status: 'pending',
          secret: {
            name: 'Account login',
            purpose: 'Sign in to keep working where Grok left off',
            kind: 'password',
            fields: [
              { label: 'Username', env: `${id.toUpperCase()}_USERNAME` },
              { label: 'Password', env: `${id.toUpperCase()}_PASSWORD` },
            ],
            reference: `secret:${id}/login_${i}`,
          },
        },
      });
    } else if (kind === 2) {
      add({
        ts,
        kind: 'approval',
        text: '',
        approval: {
          requestId,
          title: 'Secure input · API key',
          detail: 'Read the account’s data through its API',
          status: 'pending',
          secret: {
            name: 'API key',
            purpose: 'Read the account’s data through its API',
            kind: 'api_key',
            fields: [{ label: 'API key', env: `${id.toUpperCase()}_KEY` }],
            reference: `secret:${id}/key_${i}`,
          },
        },
      });
    } else if (kind === 3) {
      add({
        ts,
        kind: 'approval',
        text: '',
        approval: {
          requestId,
          title: 'Send an email · Gmail',
          // As the Mac's describe_request writes a connector tool's detail: its input as JSON.
          detail: JSON.stringify(email(i), null, 2),
          status: 'pending',
          tool: 'mcp__claude_ai_Gmail__send_email',
          input: email(i),
        },
      });
    } else {
      add({
        ts,
        kind: 'approval',
        text: '',
        approval: {
          requestId,
          title: 'Run a command',
          detail: `python3 scripts/sync_${id}.py --since 2026-10-01 --write-sheet "Weekly summary"`,
          status: 'pending',
          tool: 'Bash',
          input: {
            command: `python3 scripts/sync_${id}.py --since 2026-10-01 --write-sheet "Weekly summary"`,
          },
          always: {
            kind: 'command_prefix',
            value: `python3 scripts/sync_${id}.py`,
            label: `python3 scripts/sync_${id}.py`,
          },
        },
      });
    }
  }
}

/** A long day-to-day history: markdown, code, a timeline and a result card. */
function history(a: Agent, now: number, add: Add, days: number) {
  for (let d = days; d > 0; d--) {
    const ts = now - d * 86_400_000;
    add({
      ts,
      kind: 'user',
      text:
        d % 3 ? 'Morning. What changed overnight?' : 'Same brief as yesterday please, but shorter.',
    });
    add({
      ts: ts + 60_000,
      kind: 'agent',
      text:
        d % 2
          ? LONG_MARKDOWN
          : `Short version: two things need you, both drafted. Everything else is handled.`,
      work: work(ts + 60_000, [
        'Read the inbox',
        'Searched the web for “Northwind renewal”',
        'Read calendar for this week',
      ]),
    });
  }
  add({ ts: now - 50 * 60_000, kind: 'user', text: 'Why did the price tracker stop updating?' });
  add({
    ts: now - 46 * 60_000,
    kind: 'agent',
    text: CODE_REPLY,
    work: work(
      now - 46 * 60_000,
      ['Read scraper.ts', 'Searched the web for “__NEXT_DATA__ pricing”', 'Ran the scraper'],
      ['scraper.ts']
    ),
  });
  add({
    ts: now - 40 * 60_000,
    kind: 'agent',
    text: 'The weekly competitor sheet is updated.',
    result: {
      id: `res_${a.id}_week`,
      version: 1,
      title: 'Competitor pricing, week 45',
      summary:
        'Four competitors, every plan’s monthly price, and what moved since last week. Northwind cut its Team plan by 12%; nobody else changed.',
      items: [
        {
          kind: 'link',
          label: 'Pricing sheet',
          url: 'https://docs.example.com/sheets/pricing-week-45',
        },
        { kind: 'link', label: 'Northwind pricing page', url: 'https://northwind.example/pricing' },
      ],
      checked: [
        'Every price matches the live page as of 08:10',
        'Last week’s numbers are unchanged in the sheet',
      ],
      notVerified: ['Annual prices: two sites only show them after sign-in'],
    },
  } as Omit<AgentMessage, 'id' | 'agentId'>);
}

/**
 * Add the heavy account to the mock's world: eleven imported agents, cards
 * waiting across the team, paused routines, long chats.
 */
export function addHeavyAccount(
  agents: Agent[],
  messages: Map<string, AgentMessage[]>,
  base: (id: string, name: string, role: string, color: string, extra: Partial<Agent>) => Agent,
  now: number
) {
  for (const [i, [id, name, role, color, waiting]] of IMPORTED.entries()) {
    const out: AgentMessage[] = [];
    const add: Add = (m) =>
      out.push({ id: `${id}_${String(out.length).padStart(4, '0')}`, agentId: id, ...m });
    const a = base(id, name, role, color, {
      createdAt: now - 6 * 86_400_000,
      lastActivityAt: now - (i + 1) * 11 * 60_000,
      pendingApprovals: waiting,
      unread: i % 3 === 0 ? 0 : (i * 7) % 23,
      muted: id === 'podcast',
      checkIns: [
        routine(
          `ci_${id}_1`,
          `Send the morning brief`,
          [1, 2, 3, 4, 5],
          9,
          now + 18 * 3_600_000,
          now
        ),
        ...(i % 2
          ? [routine(`ci_${id}_2`, 'The week in review', [5], 17, now + 3 * 86_400_000, now)]
          : []),
      ],
      preview: waiting
        ? waiting === 1
          ? 'Needs your OK'
          : `${waiting} things need your OK`
        : 'Done. Nothing needs you.',
    });
    if (id === 'inbox' || id === 'ci') history(a, now, add, 12);
    else {
      add({
        ts: now - 6 * 86_400_000,
        kind: 'note',
        text: 'Imported from Grok · 37 past conversations',
      });
      add({ ts: a.lastActivityAt - 60_000, kind: 'user', text: 'Pick up where you left off.' });
      add({
        ts: a.lastActivityAt - 30_000,
        kind: 'agent',
        text: `I’m caught up on everything from Grok. My routines arrived paused; switch them on in my sheet when you’re ready.`,
      });
    }
    waitingCards(id, waiting, now, add);
    agents.push(a);
    messages.set(id, out);
  }
  // The mock's own six get more history and more waiting, too.
  const chief = messages.get('chief');
  if (chief) {
    const add: Add = (m) =>
      chief.push({ id: `chief_h${String(chief.length).padStart(4, '0')}`, agentId: 'chief', ...m });
    add({ ts: now - 90_000, kind: 'agent', text: LONG_MARKDOWN });
    const c = agents.find((x) => x.id === 'chief');
    if (c) c.unread = 3;
  }
}

/** The import talk as it stands an hour in: most staged, some imported, still going. */
export function heavyImportTalk(now: number) {
  return {
    id: 'talk_seed',
    source: 'Grok',
    chiefId: 'chief',
    state: 'interviewing',
    startedAt: now - 70 * 60_000,
    lastAt: now - 40_000,
    exchanges: 63,
    staged: IMPORTED.map(([, name]) => name).concat([
      'Board Prep',
      'Weekend Planner',
      'Reading List',
      'Gift Ideas',
      'Car & Insurance',
    ]),
    imported: IMPORTED.map(([, name]) => name),
    busy: true,
    conversations: 412,
    playbacks: 2,
  };
}
