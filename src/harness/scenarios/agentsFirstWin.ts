/**
 * The first few minutes: the Chief's three starters (a team, a morning
 * brief, a one-page site) and "More ideas…", what each leaves in the
 * composer, the gallery and what picking from it does, the New agent dialog
 * on a ready-made agent (and the one that needs an email app), a ready-made
 * agent's own first open, and first results landing (a team built, a
 * document summarised). Built on the base layer's fresh Chief (`./base`).
 */

import type { Scenario } from '../types';
import { baseCommands, chiefGreeting } from './base';
import { agent, MIN, now } from './agents';

const BASE_OVERVIEW = baseCommands.agents_overview as {
  engineReady: boolean;
  agents: Record<string, unknown>[];
  engines: unknown[];
};
const CHIEF = BASE_OVERVIEW.agents[0];

/** The document the picker "chooses", and what the backend says about it. */
const DOCUMENT = '/Users/harness/Documents/Q3 board update.pdf';
const inspect = (args: Record<string, unknown>) =>
  (args.paths as string[]).map((path) => ({
    path,
    name: path.split('/').pop() ?? path,
    mime: 'application/pdf',
    size: 182_400,
  }));

/** The Chief just made Inbox from its template; nothing said there yet. */
const INBOX = agent('inbox', 'Inbox', {
  role: 'Goes through your email and tells you what needs you, what can wait and what is noise.',
  color: 'teal',
  shape: 3,
  template: 'inbox',
  sessionId: null,
  minutesAgo: 1,
});
const WITH_INBOX = { ...BASE_OVERVIEW, agents: [CHIEF, INBOX] };
const inboxMessages = (args: Record<string, unknown>) =>
  args.agentId === 'inbox'
    ? [
        {
          id: 'n-created',
          agentId: 'inbox',
          ts: now - MIN,
          kind: 'note',
          text: 'Created by Chief of Staff',
          peer: { id: 'chief', name: 'Chief of Staff', color: 'white', shape: 5 },
        },
      ]
    : [chiefGreeting('chief')];

/** The first win: a picked document summarised, and one ready-made agent offered. */
const FIRST_WIN = [
  chiefGreeting('chief', now - 6 * MIN),
  {
    id: 'u1',
    agentId: 'chief',
    ts: now - 4 * MIN,
    kind: 'user',
    text: 'Summarise this for me: the main points, any dates or decisions, and anything I need to do.',
    attachments: [
      {
        name: 'Q3 board update.pdf',
        path: 'attachments/u1/Q3 board update.pdf',
        mime: 'application/pdf',
        size: 182_400,
      },
    ],
  },
  {
    id: 'a1',
    agentId: 'chief',
    ts: now - 3 * MIN,
    kind: 'agent',
    text: [
      'Revenue is up 12% on Q2, but the board wants the hiring plan cut from nine roles to six before it signs off the budget.',
      '',
      'Decisions and dates: the budget vote is on **14 November**; the EU launch moved from October to **January**.',
      '',
      'For you: send the revised hiring plan to Priya by **10 November**, and confirm who presents the EU launch slide.',
      '',
      'Page 7 is a scanned table I couldn’t read, so the regional numbers aren’t in this.',
    ].join('\n'),
  },
  {
    id: 'a2',
    agentId: 'chief',
    ts: now - 3 * MIN,
    kind: 'agent',
    text: 'If documents like this come in often, I can set up a Research assistant to take them on. Want me to?',
  },
];

/** The first win from "Build me a team…": three agents, proposed then made. */
const TEAM = [
  agent('studio-ops', 'Studio Ops', {
    role: 'Keeps projects, deadlines and invoices from slipping.',
    color: 'teal',
    shape: 2,
    sessionId: null,
    minutesAgo: 1,
  }),
  agent('new-business', 'New Business', {
    role: 'Finds leads and drafts proposals for you to send.',
    color: 'orange',
    shape: 4,
    sessionId: null,
    minutesAgo: 1,
  }),
  agent('scout', 'Scout', {
    role: 'Watches what other studios ship and what clients ask for.',
    color: 'blue',
    shape: 1,
    sessionId: null,
    minutesAgo: 1,
  }),
];
const WITH_TEAM = { ...BASE_OVERVIEW, agents: [CHIEF, ...TEAM] };
const TEAM_BUILT = [
  chiefGreeting('chief', now - 8 * MIN),
  {
    id: 'u1',
    agentId: 'chief',
    ts: now - 7 * MIN,
    kind: 'user',
    text: 'Build me a team of agents for this: I run a two-person design studio and I’m bad at follow-ups.',
  },
  {
    id: 'a1',
    agentId: 'chief',
    ts: now - 6 * MIN,
    kind: 'agent',
    text: [
      'Here’s a team I’d start with:',
      '',
      '- **Studio Ops**: deadlines, invoices and the follow-ups you mean to send.',
      '- **New Business**: finds leads and drafts proposals for you to send.',
      '- **Scout**: a weekly look at what other studios ship and what clients ask for.',
      '',
      'Each keeps its own memory, and nothing goes out without your OK. Shall I make them?',
    ].join('\n'),
  },
  { id: 'u2', agentId: 'chief', ts: now - 2 * MIN, kind: 'user', text: 'Yes, go ahead.' },
  {
    id: 'a2',
    agentId: 'chief',
    ts: now - MIN,
    kind: 'agent',
    text: 'Done: they’re in your sidebar. Studio Ops is asking you for this week’s deadlines, and Scout will have its first look ready on Monday morning.',
  },
];

export const agentsFirstWinScenarios: Scenario[] = [
  {
    id: 'agents-first-win-team',
    title: 'Agents — first run: “Build me a team…”',
    looksRightWhen:
      'The greeting with its starters still under it (Build me a team…, Brief me every morning…, Make me a one-page site…, then a quieter More ideas…), and the composer holding “Build me a team of agents for this: ” with the caret after it. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="team"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-brief',
    title: 'Agents — first run: “Brief me every morning…”',
    looksRightWhen:
      'The composer holds “Every weekday at 8am, brief me on ” with the caret after it, ready for the topics. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="brief"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-site',
    title: 'Agents — first run: “Make me a one-page site…”',
    looksRightWhen:
      'The composer holds “Make me a one-page website for ” with the caret after it. Nothing has been sent, and nothing about Node, Git or project tools appears.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="site"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-ideas',
    title: 'Agents — first run: “More ideas…” opens the gallery',
    looksRightWhen:
      'A dialog “Ideas to start with”: one line saying a pick is typed out and nothing is sent, then four groups (A team, Something that keeps going, Something real, Right now), each row a title and one muted line on what happens. Nothing is in the accent. At the foot, two quiet links: Ready-made agents… and Talk to your team from your phone….',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="more"]' }],
    requires: '.agents-ideas__idea',
    commands: {},
  },
  {
    id: 'agents-ideas-palette',
    title: 'Agents — ⌘K “Ideas for your team…” from the projects side',
    looksRightWhen:
      'Agents mode, with the same “Ideas to start with” dialog open over the Chief’s chat.',
    command: 'agents.ideas',
    requires: '.agents-ideas__idea',
    commands: {},
  },
  {
    id: 'agents-ideas-when',
    title: 'Agents — gallery: picking “When a PDF lands in Downloads…”',
    looksRightWhen:
      'The dialog has closed, and the Chief’s composer holds the whole request (“When a new PDF lands in my Downloads folder, read it and tell me what it is and whether I need to do anything.”). Nothing has been sent.',
    command: 'agents.open',
    steps: [
      { click: '.agent-chat__starters > [data-idea="more"]' },
      { click: '.agents-ideas__idea[data-idea="when-pdf"]' },
    ],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-document',
    title: 'Agents — gallery: “Summarise a document…” picked a file',
    looksRightWhen:
      'The greeting with its starters still under it, and the composer holding the picked PDF as a chip with the request typed out (“Summarise this for me: the main points, any dates or decisions, and anything I need to do.”). Nothing has been sent: no user bubble, no working line.',
    command: 'agents.open',
    steps: [
      { click: '.agent-chat__starters > [data-idea="more"]' },
      { click: '.agents-ideas__idea[data-idea="document"]' },
    ],
    requires: '.agent-composer__attachments',
    commands: {
      'plugin:dialog|open': [DOCUMENT],
      agents_inspect_files: inspect,
    },
  },
  {
    id: 'agents-first-win-ready-made',
    title: 'Agents — gallery: “Ready-made agents…” opens New agent on one',
    looksRightWhen:
      'New agent, opened on “Start from”: Blank / Research / Inbox / Weekly Review with Research pressed. Below it the name “Research” on a blue badge, what it does, and its full briefing in “What should it know?”, editable. Create is the only filled button.',
    command: 'agents.open',
    steps: [
      { click: '.agent-chat__starters > [data-idea="more"]' },
      { click: '.agents-ideas__foot button', text: 'Ready-made agents' },
    ],
    requires: '.agent-editor__templates',
    commands: {},
  },
  {
    id: 'agents-first-win-team-built',
    title: 'Agents — the first win: a team built',
    looksRightWhen:
      'The greeting, the user’s “Build me a team…” request, the Chief’s short list of three agents (a name and one line each), the user’s “Yes, go ahead”, and the Chief saying they’re made and what each is starting on. Three new agents in the sidebar, each its own colour. The starters are gone.',
    command: 'agents.open',
    requires: '[data-agent-id="studio-ops"]',
    commands: {
      agents_overview: WITH_TEAM,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? TEAM_BUILT : [],
    },
  },
  {
    id: 'agents-template-inbox',
    title: 'Agents — New agent on Inbox triage (⌘K), which needs an email app',
    looksRightWhen:
      'Inbox pressed under “Start from”, and directly under the choices one muted line, “It reads your email through an app you connect, such as Gmail.”, with a “Connect an app…” button beside it. It doesn’t claim anything is or isn’t connected. Name Inbox on a teal badge, its role and briefing filled in.',
    command: 'agents.template.inbox',
    requires: '.agent-editor__needs',
    commands: {},
  },
  {
    id: 'agents-template-first-open',
    title: 'Agents — a ready-made Inbox the Chief just made, first open',
    looksRightWhen:
      'Inbox’s chat: “Created by Chief of Staff”, then a quiet centred line “It reads your email through an app you connect, such as Gmail. Connect an app…”, then its own starters (“What needs me today?”, “Draft replies…”), not the generic ones. No tinted box, nothing in the accent but the badge.',
    command: 'agents.open',
    steps: [{ click: '[data-agent-id="inbox"]' }],
    requires: '.agent-chat__needs',
    commands: {
      agents_overview: WITH_INBOX,
      agents_messages: inboxMessages,
    },
  },
  {
    id: 'agents-first-win-result',
    title: 'Agents — the first win: a document summarised',
    looksRightWhen:
      'The greeting, the user’s request with the PDF chip, then the Chief’s reply leading with the answer, naming dates and what the user must do, and saying plainly which page it couldn’t read. Then one line offering a Research assistant. The starters are gone.',
    command: 'agents.open',
    requires: '.agent-chat__messages',
    commands: {
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? FIRST_WIN : [],
    },
  },
];
