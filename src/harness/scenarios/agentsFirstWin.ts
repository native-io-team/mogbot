/**
 * The first few minutes: the Chief's three starters (a document, a
 * question, ready-made agents), what each one leaves in the composer, the
 * New agent dialog on a ready-made agent (and the one that needs an email
 * app), a ready-made agent's own first open, and a first result landing.
 * Built on the base layer's fresh Chief (`./base`).
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

export const agentsFirstWinScenarios: Scenario[] = [
  {
    id: 'agents-first-win-document',
    title: 'Agents — first run: “Summarise a document…” picked a file',
    looksRightWhen:
      'The greeting with its three starters still under it, and the composer holding the picked PDF as a chip with the request typed out (“Summarise this for me: the main points, any dates or decisions, and anything I need to do.”). Nothing has been sent: no user bubble, no working line.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > button', text: 'Summarise a document' }],
    requires: '.agent-composer__attachments',
    commands: {
      'plugin:dialog|open': [DOCUMENT],
      agents_inspect_files: inspect,
    },
  },
  {
    id: 'agents-first-win-research',
    title: 'Agents — first run: “Research a question…”',
    looksRightWhen:
      'The composer holds “Research this for me: ” with the caret after it, ready for the question. Nothing has been sent.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > button', text: 'Research a question' }],
    requires: '.agent-chat__messages > .agent-chat__starters',
    commands: {},
  },
  {
    id: 'agents-first-win-ready-made',
    title: 'Agents — first run: “Ready-made agents…” opens New agent on one',
    looksRightWhen:
      'New agent, opened on “Start from”: Blank / Research / Inbox / Weekly Review with Research pressed. Below it the name “Research” on a blue badge, what it does, and its full briefing in “What should it know?”, editable. Create is the only filled button.',
    command: 'agents.open',
    steps: [{ click: '.agent-chat__starters > button', text: 'Ready-made agents' }],
    requires: '.agent-editor__templates',
    commands: {},
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
