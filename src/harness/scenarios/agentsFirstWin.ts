/**
 * The first few minutes: the Chief's three starters (a morning brief, the
 * inbox, research written up) and "More ideas…", the whole
 * brief each leaves in the composer, the gallery and what picking from it
 * does, the New agent dialog on a ready-made agent (and the one that needs
 * an email app), a ready-made agent's own first open, and first results
 * landing (a nightly pipeline set up, a site handed back with Preview, a
 * document summarised). Built on the base layer's fresh Chief (`./base`).
 */

import type { Scenario } from '../types';
import { baseCommands, chiefGreeting, HARNESS_ROOT } from './base';
import { agent, MIN, now } from './agents';

const BASE_OVERVIEW = baseCommands.agents_overview as {
  engineReady: boolean;
  agents: Record<string, unknown>[];
  engines: unknown[];
};
const CHIEF = BASE_OVERVIEW.agents[0];

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

/** "Ship fixes while I sleep…", set up: GitHub first, then the pair, the routine and a first run. */
const PIPELINE = [
  agent('fixer', 'Fixer', {
    role: 'Each night, fixes the top open issue in acme-marketing, in its own copy.',
    color: 'teal',
    shape: 2,
    sessionId: null,
    minutesAgo: 1,
    project: `${HARNESS_ROOT}/acme-marketing`,
  }),
  agent('reviewer', 'Reviewer', {
    role: 'Reviews the Fixer’s change before it reaches you.',
    color: 'orange',
    shape: 4,
    sessionId: null,
    minutesAgo: 1,
  }),
];
const WITH_PIPELINE = { ...BASE_OVERVIEW, agents: [CHIEF, ...PIPELINE] };
const PIPELINE_SET_UP = [
  chiefGreeting('chief', now - 12 * MIN),
  {
    id: 'u1',
    agentId: 'chief',
    ts: now - 11 * MIN,
    kind: 'user',
    text: 'Every night at 1am, have one agent take the top open GitHub issue in my repo and fix it in its own copy of the project, then have a second agent review the fix. In the morning, give me one card with the change to keep, review or discard. Nothing gets pushed without me. The repo: acme/marketing-site',
  },
  {
    id: 'a1',
    agentId: 'chief',
    ts: now - 10 * MIN,
    kind: 'agent',
    text: 'First, GitHub: this Mac isn’t signed in yet. Open ⌘K → **Connect GitHub account**, finish the sign-in in your browser, and tell me when it’s done.',
  },
  { id: 'u2', agentId: 'chief', ts: now - 6 * MIN, kind: 'user', text: 'Done.' },
  {
    id: 'a2',
    agentId: 'chief',
    ts: now - 2 * MIN,
    kind: 'agent',
    text: [
      'Signed in, and acme/marketing-site is already your **acme-marketing** project. Here’s the pipeline:',
      '',
      '- **Fixer** works in its own copy of acme-marketing, so your folder is never touched.',
      '- **Reviewer** checks each fix and sends it back if it isn’t right.',
      '- Every night at 1am, while the app is open and this Mac is awake.',
      '',
      'I’m doing the first run now so you can see the card you’ll wake up to. If it asks to run `gh`, choose Always allow: at 1am nobody is there to press Allow. Pushing always waits for you.',
    ].join('\n'),
  },
];

/** "Turn client briefs into sites…": the draft handed back on a card with Preview. */
const SITE_HANDED_BACK = [
  chiefGreeting('chief', now - 30 * MIN),
  {
    id: 'u1',
    agentId: 'chief',
    ts: now - 29 * MIN,
    kind: 'user',
    text: 'When a new client brief lands in a folder, read it, start a new project for it, draft the site and send me a card I can preview. Nothing goes to the client without me. The folder to watch: ~/Clients/Briefs',
  },
  {
    id: 'a1',
    agentId: 'chief',
    ts: now - MIN,
    kind: 'agent',
    text: 'One page from the brief: the menu, opening hours and a map link, in the warm palette it asks for.',
    result: {
      id: 'res-site',
      version: 1,
      title: 'Northwind Bakery: first draft',
      summary:
        'One page from the brief: the menu, opening hours and a map link, in the warm palette it asks for.',
      checked: ['The page loads in the preview with no console errors'],
      notVerified: [
        'The opening hours are as the brief gives them; I couldn’t check them anywhere else',
      ],
      project: `${HARNESS_ROOT}/portfolio-site`,
    },
  },
];

export const agentsFirstWinScenarios: Scenario[] = [
  {
    id: 'agents-first-win-morning-brief',
    title: 'Agents — first run: “Brief me every morning”',
    looksRightWhen:
      'The greeting with its starters still under it (Brief me every morning, Sort my inbox, draft replies, Research it and write it up, left-aligned under the greeting, all neutral outline buttons, then a quieter More ideas…), and the composer holding the whole brief, “Every weekday at 8am, have a researcher read what’s new … My topics: ”, with the caret after it, ready for the one blank. Send is off and a quiet hint says “Fill in the end, then send”: the brief can’t go with its blank empty. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="morning-brief"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-research',
    title: 'Agents — first run: “Research it and write it up”',
    looksRightWhen:
      'The composer holds the whole brief, “Have a researcher dig into this and collect good sources … The topic: ”, with the caret after it, ready for the one blank. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="research"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-inbox',
    title: 'Agents — first run: “Sort my inbox, draft replies”',
    looksRightWhen:
      'The composer holds the whole brief, “Through the day, have one agent sort my new email … My email is in: ”, with the caret after it, ready for the one blank. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > [data-idea="inbox"]' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-ideas',
    title: 'Agents — first run: “More ideas…” opens the gallery',
    looksRightWhen:
      'A dialog “Ideas to start with”: a short lede (each keeps running once set up; a pick is typed out and nothing is sent; your Chief sets up what it needs), then four groups (On a schedule, When something happens, Agents together, and last For builders), everyday jobs first (invoices, social posts, job applications, a place to live, meeting notes, a trip) and the GitHub, error and client-site ideas only under For builders, each row a title and one muted line on what happens. Nothing is in the accent. At the foot, two quiet links: Ready-made agents… and Talk to your team from your phone….',
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
    id: 'agents-ideas-errors',
    title: 'Agents — gallery: picking “Babysit my errors”',
    looksRightWhen:
      'The dialog has closed, and the Chief’s composer holds the whole brief (“Every hour, check this project for new errors … The project: ”). Nothing has been sent.',
    command: 'agents.open',
    steps: [
      { click: '.agent-chat__starters > [data-idea="more"]' },
      { click: '.agents-ideas__idea[data-idea="errors"]' },
    ],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
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
    id: 'agents-first-win-pipeline',
    title: 'Agents — the first win: a nightly pipeline set up',
    looksRightWhen:
      'The greeting, the user’s “Every night at 1am…” brief, the Chief asking for GitHub first and naming ⌘K → Connect GitHub account, the user’s “Done.”, then the Chief’s short plan (Fixer in its own copy, Reviewer, every night at 1am while the app is open) and why it’s running the first one now. Fixer and Reviewer in the sidebar, each its own colour. The starters are gone.',
    command: 'agents.open',
    requires: '[data-agent-id="fixer"]',
    commands: {
      agents_overview: WITH_PIPELINE,
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? PIPELINE_SET_UP : [],
    },
  },
  {
    id: 'agents-first-win-site-preview',
    title: 'Agents — a client brief’s site, handed back with Preview',
    looksRightWhen:
      'The brief, then one result card “Northwind Bakery: first draft”: its summary, Not verified up front, “It says it checked”, and quiet Preview and Ask for changes actions, neither in the accent. The window stays on the chat: Preview opens the project only when pressed.',
    command: 'agents.open',
    requires: '.agent-result',
    commands: {
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? SITE_HANDED_BACK : [],
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
      'The greeting, the user’s request with the PDF chip, then the Chief’s reply leading with the answer, naming dates and what the user must do, and saying plainly which page it couldn’t read. Then one line offering a Research assistant. The starters are gone, and no phone card sits under it: the reply ends on a question to the user, so the offer waits for the next reply rather than standing between them and their answer.',
    command: 'agents.open',
    requires: '.agent-chat__messages',
    commands: {
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? FIRST_WIN : [],
    },
  },
  {
    id: 'agents-first-run-import-choice',
    title: 'Agents — first run, straight from onboarding: the Chief speaks first',
    looksRightWhen:
      'The Chief’s greeting, its three starters and More ideas… directly under it, and only then one calm card, “Already have agents in another assistant?”, with “No thanks, start fresh” and a neutral “Bring my agents”. The import question used to be its own onboarding screen; here it waits under the greeting and nothing above the greeting competes with it.',
    command: 'agents.open',
    requires: '.agent-chat__starters ~ [data-testid="agent-import-choice"]',
    commands: { agents_overview: { ...BASE_OVERVIEW, importChoice: 'undecided' } },
  },
  {
    id: 'agents-first-result-phone-offer',
    title: 'Agents — the first result is back: the Chief offers the phone',
    looksRightWhen:
      'The site handed back on its result card, and under it one calm card: a phone icon, “Use your agents from your phone?”, one muted line (chat, answer and approve from anywhere; no App Store app yet, so ten minutes to an hour), then “Not now” and a neutral “Set up my phone”. The phone used to be four onboarding screens before any result; now it is offered once something came back.',
    command: 'agents.open',
    phoneOffer: true,
    requires: '[data-testid="chief-phone-offer"]',
    commands: {
      agents_overview: { ...BASE_OVERVIEW, importChoice: 'declined' },
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? SITE_HANDED_BACK : [],
    },
  },
];
