/**
 * After an import: the overwhelm it used to cause, and "Setting up your team"
 * (`src-tauri/src/agents/team_setup.rs`, `components/agents/TeamSetupCard.tsx`).
 *
 * A fictional team of 16 agents imported from Grok Bot, in the shape of the
 * import this was built for: the user asked the
 * Chief to "see what they need", it messaged every agent at once, and each
 * woke up and raised a request against a path from its old home, beside the
 * login cards the import had already put in its chat. `before` is that state
 * as an older build left it; `after` is the same team once the upgrade has
 * folded it in (the fan-out's requests set aside, one checklist in the
 * Chief's chat).
 */

import type { Scenario } from '../types';
import { MIN, TEAM, agent, msg, now, overview, status } from './agents';

const SOURCE = 'Grok Bot';
const CHIEF = TEAM[0];

interface Imported {
  id: string;
  name: string;
  color: string;
  role: string;
  /** Logins the import asked for (secure cards in its chat). */
  logins: string[];
  /** Whether the fan-out made it raise a request. */
  asked?: string;
  /** A routine that arrived paused. */
  routine?: { when: string; what: string };
  gaps?: string[];
}

const COLORS = ['orange', 'blue', 'teal', 'green', 'pink', 'amber', 'purple', 'red', 'brown'];

const IMPORTED: Imported[] = [
  {
    id: 'newsletter',
    name: 'Newsletter',
    role: 'The monthly newsletter',
    logins: [],
    asked: 'ls -la /workspace/newsletter/drafts/',
  },
  {
    id: 'garden',
    name: 'Garden Plan',
    role: 'The spring garden',
    logins: [],
    asked: 'ls /workspace/garden/',
  },
  {
    id: 'inbox',
    name: 'Inbox Watch',
    role: 'Watches the shop inbox',
    logins: ['shop_mail', 'helpdesk'],
    asked: 'ls -la /workspace/inbox-watch/',
    routine: {
      when: 'every day at 08:20',
      what: 'Check the shop inbox and send the morning digest',
    },
  },
  {
    id: 'events',
    name: 'Events',
    role: 'Workshops and the weekly roundup',
    logins: ['eventbrite'],
    routine: { when: 'every Friday at 16:00', what: 'Draft the weekly workshop roundup' },
  },
  {
    id: 'site',
    name: 'Shop Site',
    role: 'The shop’s website',
    logins: ['vercel', 'github', 'cloudflare'],
  },
  {
    id: 'recruiting',
    name: 'Recruiting',
    role: 'Recruiting pipeline',
    logins: ['hirehub', 'jobboard'],
    gaps: [
      'When a candidate replies: move them to the next stage (ask me to set this up here once I’m in)',
    ],
  },
  {
    id: 'orders',
    name: 'Order QA',
    role: 'Checks every order batch',
    logins: ['shipping'],
    asked: 'ls /workspace/order-qa/',
  },
  {
    id: 'photos',
    name: 'Photo Posts',
    role: 'Drafts posts for sign-off',
    logins: ['buffer', 'pinboard'],
    routine: { when: 'every weekday at 10:00', what: 'Draft today’s post for sign-off' },
  },
  {
    id: 'kitchen',
    name: 'Kitchen Reno',
    role: 'The kitchen renovation',
    logins: [],
    asked: 'cat /workspace/kitchen/plan.md',
  },
  {
    id: 'wholesale',
    name: 'Wholesale',
    role: 'Wholesale orders',
    logins: ['crm'],
    asked: 'ls /workspace/wholesale/',
  },
  {
    id: 'support',
    name: 'Support Desk',
    role: 'Customer support queue',
    logins: ['helpdesk', 'chat_widget'],
    asked: 'git status',
  },
  {
    id: 'catalog',
    name: 'Catalog',
    role: 'The product catalog',
    logins: ['shop_admin', 'photo_library'],
  },
  { id: 'studio', name: 'Studio', role: 'The kiln, glazes and class bookings', logins: [] },
  {
    id: 'workshop',
    name: 'Workshop',
    role: 'Builds shop features end to end',
    logins: ['github_workshop'],
    gaps: [
      '“Now and then”: check the open PRs. I can’t read that time, so it won’t be set: tell me when it should run',
    ],
  },
  {
    id: 'books',
    name: 'Bookkeeper',
    role: 'Books, invoices and payroll',
    logins: ['business_bank', 'bankline', 'payroll_app'],
    asked: 'ls /workspace/books/; cat /workspace/books/status.md',
    routine: { when: 'every Monday at 09:00', what: 'Send last week’s spending' },
    gaps: ['Nothing about payroll dates yet: tell me when remittances are due'],
  },
  {
    id: 'stockists',
    name: 'Stockists',
    role: 'Finds shops to stock the range',
    logins: ['leads_db'],
    asked: 'ls /workspace/stockists/leads/',
  },
].map((a, i) => ({ ...a, color: COLORS[i % COLORS.length] }));

const at = (a: Imported, minutesAgo: number, kind: string, text: string, over = {}) =>
  msg(kind, text, minutesAgo, { agentId: a.id, ...over });

const loginCard = (a: Imported, name: string, j: number) =>
  at(a, 40, 'approval', '', {
    id: `${a.id}-login-${j}`,
    approval: {
      requestId: `${a.id}-login-${j}`,
      title: `Secure input · ${name}`,
      detail: '',
      status: 'pending',
      secret: {
        name,
        purpose: `A login ${a.name} used with ${SOURCE}`,
        kind: 'password',
        fields: [{ label: 'Password', env: name.toUpperCase() }],
        reference: `ref-${a.id}-${j}`,
        quiet: true,
      },
    },
  });

/** One imported agent's chat: its logins, the import line, then the fan-out. */
function chatOf(a: Imported, after: boolean) {
  const lines: Record<string, unknown>[] = a.logins.map((l, j) => loginCard(a, l, j));
  lines.push(
    at(
      a,
      40,
      'note',
      `Imported from ${SOURCE}. It starts when you message it; its routines are paused.`
    )
  );
  if (!a.asked) return lines;
  lines.push(
    at(
      a,
      38,
      'from_agent',
      'Robin asked me to gather everything waiting on him in one place. Reply with every item that’s waiting on him right now.',
      {
        peer: { id: CHIEF.id, name: CHIEF.name },
      }
    ),
    at(a, 37, 'approval', '', {
      id: `${a.id}-ask`,
      approval: {
        requestId: `${a.id}-ask`,
        title: 'Run a command',
        detail: a.asked,
        status: after ? 'expired' : 'pending',
        tool: 'Bash',
        input: { command: a.asked },
        ...(after && {
          setAside: `Set aside: this came from ${CHIEF.name} checking in with every agent after the import. Nothing ran.`,
        }),
      },
    }),
    at(
      a,
      36,
      'agent',
      'One thing is waiting on Robin: a permission card I just raised to list my folder.'
    )
  );
  if (after) {
    lines.push(
      at(
        a,
        1,
        'note',
        `Set aside a request from when ${CHIEF.name} checked in after the import. Nothing ran; it asks again if it still needs to.`
      )
    );
  }
  return lines;
}

const pendingOf = (a: Imported, after: boolean) => a.logins.length + (a.asked && !after ? 1 : 0);

function agentsFor(after: boolean, greeted: string[] = []) {
  return [
    { ...CHIEF, pendingApprovals: 0, minutesAgo: 0 },
    ...IMPORTED.map((a, i) =>
      agent(a.id, a.name, {
        shape: (i % 13) + 1,
        color: a.color,
        role: a.role,
        minutesAgo: 30 + i,
        pendingApprovals: pendingOf(a, after),
        preview: a.asked
          ? 'One thing is waiting on Robin: a permission card I just raised to list my folder.'
          : `Imported from ${SOURCE}. It starts when you message it; its routines are paused.`,
        status: greeted[0] === a.id ? status('working', 'Reading CLAUDE.md') : status('idle'),
        checkIns: a.routine
          ? [
              {
                id: `${a.id}-r`,
                note: a.routine.what,
                nextAt: now + 60 * MIN,
                createdAt: now - 40 * MIN,
                paused: true,
                pausedOnImport: true,
                repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
              },
            ]
          : [],
      })
    ),
  ];
}

const CHIEF_BEFORE = [
  msg(
    'note',
    `Imported from ${SOURCE}: ${IMPORTED.map((a) => a.name).join(', ')}. They start when you message them; routines are paused.`,
    41
  ),
  msg(
    'user',
    'All right, it says all of my agents need my okay. Work with them, see what they need, and make sure everything is handled.',
    39
  ),
  ...IMPORTED.map((a, i) =>
    msg(
      'sent_to_agent',
      'Robin asked me to gather everything waiting on him in one place. Reply with every item that’s waiting on him right now.',
      38 - i * 0.05,
      {
        peer: { id: a.id, name: a.name },
      }
    )
  ),
  msg('agent', `I’ve asked all ${IMPORTED.length} agents what they’re waiting on you for.`, 37),
  msg(
    'agent',
    '7 of 16 agents have answered so far. **Recruiting is blocked**: it needs two logins. **Bookkeeper** has a deadline: payroll is due Nov 15. Several opened a read-only card just to list their own folders…',
    34
  ),
  msg(
    'agent',
    'All 16 agents have answered. In order of urgency, this is what they need from you: …',
    30
  ),
];

/** When the upgrade posted the card, under its line. */
const POSTED_MIN = 20;

const CHIEF_AFTER = [
  ...CHIEF_BEFORE,
  msg(
    'note',
    'What your team needs to get going is in one place now, below. Nothing it asked for has run.',
    POSTED_MIN
  ),
];

/** After the card: the conversation goes on under it, as under any message. */
const LATER = [
  msg('user', 'Thanks. I’ll do the logins tonight. What’s on for tomorrow?', 6),
  msg('agent', 'Tomorrow is quiet: the kiln firing at 10 and the wholesale call at 3.', 5),
];

const messages =
  (after: boolean, extraChief: Record<string, unknown>[] = []) =>
  (args: Record<string, unknown>) => {
    if (args.agentId === CHIEF.id) return [...(after ? CHIEF_AFTER : CHIEF_BEFORE), ...extraChief];
    const a = IMPORTED.find((x) => x.id === args.agentId);
    return a ? chatOf(a, after) : [];
  };

type StepState = 'open' | 'done' | 'skipped';

/** team_setup::SetupView for this team. */
function setupView(
  states: Partial<Record<'logins' | 'routines' | 'missing' | 'hello', StepState>>,
  greeted: string[] = []
) {
  const steps = [
    {
      id: 'logins',
      state: states.logins ?? 'open',
      logins: IMPORTED.flatMap((a) =>
        a.logins.map((name, j) => ({
          agentId: a.id,
          agentName: a.name,
          requestId: `${a.id}-login-${j}`,
          name,
          purpose: `A login ${a.name} used with ${SOURCE}`,
        }))
      ),
    },
    {
      id: 'routines',
      state: states.routines ?? 'open',
      routines: IMPORTED.filter((a) => a.routine).map((a) => ({
        agentId: a.id,
        agentName: a.name,
        checkInId: `${a.id}-r`,
        when: a.routine!.when,
        what: a.routine!.what,
        on: a.id === 'inbox' && states.routines !== undefined,
      })),
    },
    {
      id: 'missing',
      state: states.missing ?? 'open',
      gaps: IMPORTED.filter((a) => a.gaps).map((a) => ({
        agentId: a.id,
        agentName: a.name,
        lines: a.gaps!,
      })),
    },
    {
      id: 'hello',
      state: states.hello ?? 'open',
      agents: IMPORTED.map((a) => ({
        agentId: a.id,
        agentName: a.name,
        color: a.color,
        state: greeted[0] === a.id ? 'working' : greeted.includes(a.id) ? 'said_hi' : 'quiet',
      })),
    },
  ];
  const done = steps.filter((s) => s.state !== 'open').length;
  return {
    id: 'setup1',
    source: SOURCE,
    postedAt: now - POSTED_MIN * MIN,
    steps,
    done,
    total: steps.length,
    current: steps.find((s) => s.state === 'open')?.id,
    complete: done === steps.length,
    agents: IMPORTED.length,
    setAside: IMPORTED.filter((a) => a.asked).length,
    dismissed: false,
  };
}

export const agentsTeamSetupScenarios: Scenario[] = [
  {
    id: 'agents-team-setup-before',
    title: 'Agents — after a 16-agent import, before (an older build)',
    looksRightWhen:
      'Without this change (the state the upgrade folds in): the Chief’s chat ends in the fan-out’s replies, and above the composer the requests bar counts every imported agent as needing your OK, logins and folder requests together; sixteen sidebar rows say Needs your OK. Nothing here is the new design.',
    command: 'agents.open',
    requires: '[data-testid="agent-requests-bar"]',
    commands: {
      agents_overview: overview(agentsFor(false)),
      agents_messages: messages(false),
    },
  },
  {
    id: 'agents-team-setup',
    title: 'Agents — Setting up your team (after the upgrade)',
    looksRightWhen:
      'The same team after the update. The Chief’s chat ends in one quiet line (“What your team needs to get going is in one place now, below…”) and one card, “Setting up your team”, “0 of 4 done”, with a muted line about the agents from Grok Bot staying quiet until you say hi. Four steps in order, each a row with a ring: Add logins (open: one line about the Keychain, then one row per login, its name over the agents that need it (“bankline” over “Bookkeeper”), with Add), Switch on routines, Fill in what’s missing, Say hi to your team. Above the composer one bar, “A few things to finish setting up your team · 0 of 4 done” with Continue; no requests bar for the imported agents’ logins and no count of requests anywhere.',
    command: 'agents.open',
    requires: '[data-testid="team-setup"]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true),
      agents_team_setup: setupView({}),
    },
  },
  {
    id: 'agents-team-setup-later',
    title: 'Agents — Setting up your team, with the conversation going on under it',
    looksRightWhen:
      'The card sits where it was posted, right under “What your team needs to get going is in one place now, below…”, and the conversation after it comes under the card: your “Thanks. I’ll do the logins tonight…” and the Chief’s reply about tomorrow are the newest lines, at the foot, over the composer. The bar above the composer still says “A few things to finish setting up your team · 1 of 4 done” with Continue; Continue scrolls up to the card and rings it.',
    command: 'agents.open',
    requires: '[data-testid="team-setup"]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true, LATER),
      agents_team_setup: setupView({ logins: 'done' }),
    },
  },
  {
    id: 'agents-team-setup-routines',
    title: 'Agents — Setting up your team: routines',
    looksRightWhen:
      'Logins is ticked (“Logins added”); “1 of 4 done”. Switch on routines is open: one line saying they came in paused, then each routine as “Inbox Watch · every day at 08:20” with what it does under it and a switch on the right (Inbox Watch’s on, the rest off). Skip for now and a neutral Done at the foot, right-aligned.',
    command: 'agents.open',
    requires: '[data-testid="team-setup"] [data-step="routines"][data-open]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true),
      agents_team_setup: setupView({ logins: 'done' }),
    },
  },
  {
    id: 'agents-team-setup-missing',
    title: 'Agents — Setting up your team: what’s missing',
    looksRightWhen:
      '“2 of 4 done”: logins ticked, routines skipped (a dashed ring, “Skipped”). Fill in what’s missing is open: each agent’s name in bold with its lines under it (Recruiting, Builder, Bookkeeper), then Skip for now and “Ask Chief of Staff to sort these”, neutral, not the accent.',
    command: 'agents.open',
    requires: '[data-testid="team-setup"] [data-step="missing"][data-open]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true),
      agents_team_setup: setupView({ logins: 'done', routines: 'skipped' }),
    },
  },
  {
    id: 'agents-team-setup-hello',
    title: 'Agents — Setting up your team: say hi, one at a time',
    looksRightWhen:
      '“3 of 4 done”. Say hi to your team is open: a row per agent with its mini badge and name. Newsletter reads “Replying…” with Open; Garden Plan and Inbox Watch read “Said hi”; every other row has a Say hi button, all disabled while Newsletter replies. Done at the foot.',
    command: 'agents.open',
    requires: '[data-testid="team-setup"] [data-step="hello"][data-open]',
    commands: {
      agents_overview: overview(agentsFor(true, ['newsletter', 'garden', 'inbox'])),
      agents_messages: messages(true),
      agents_team_setup: setupView({ logins: 'done', routines: 'done', missing: 'done' }, [
        'newsletter',
        'garden',
        'inbox',
      ]),
    },
  },
  {
    id: 'agents-team-setup-done',
    title: 'Agents — Setting up your team, finished',
    looksRightWhen:
      'No card: one quiet centred line where the card was, under “What your team needs…”, “Done · Your team is set up.”, with Hide. The conversation after it stays under it, and there is no setup bar above the composer.',
    command: 'agents.open',
    requires: '[data-testid="team-setup-done"]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true, LATER),
      agents_team_setup: {
        ...setupView({ logins: 'done', routines: 'done', missing: 'done', hello: 'done' }),
        complete: true,
      },
    },
  },
  {
    id: 'agents-team-setup-in-flight',
    title: 'Agents — What’s in flight while setting up the team',
    looksRightWhen:
      'At the top of What’s in flight, above Needs your OK: a row with the Chief’s badge, “Setting up your team”, and “1 of 4 done · in Chief of Staff’s chat”. Needs your OK doesn’t list the sixteen imported agents for their logins (the checklist holds them).',
    command: 'agents.team',
    requires: '[data-testid="agents-team-setup"]',
    commands: {
      agents_overview: overview(agentsFor(true)),
      agents_messages: messages(true),
      agents_team_setup: setupView({ logins: 'done' }),
    },
  },
];
