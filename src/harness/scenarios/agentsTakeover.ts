/**
 * Take over (`agents::takeover`): you step into an agent's own session in a
 * terminal and hand it back. Built on the Agents team fixture (`./agents`).
 *
 * The terminal's contents here are a fixture: a few lines standing in for
 * Claude Code's screen, replayed as the session's scrollback. Nothing runs.
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, msg, messagesFor, now, overview } from './agents';
import { workCommands } from './agentsWork';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;
const SINCE = now - 6 * MIN;

const unbound = {
  since: SINCE,
  ptySession: 'takeover-finance',
  cli: 'claude-code',
  trustPrompt: true,
};
const bound = {
  since: SINCE,
  ptySession: 'takeover-acme',
  project: ACME_PATH,
  cli: 'claude-code',
};

/** Finance (or Acme Site, bound to acme-marketing) being driven. */
const drivenTeam = (id: 'finance' | 'acme') =>
  overview(
    TEAM.map((a) =>
      a.id === id
        ? {
            ...a,
            unread: 0,
            ...(id === 'acme' ? { project: ACME_PATH, takeover: bound } : { takeover: unbound }),
            status: { state: 'idle', activity: null, since: null },
          }
        : a
    )
  );

const enc = new TextEncoder();
/** What the terminal replays: a resumed conversation, in the CLI's own colours. */
const SCREEN = [
  '\x1b[2m╭───────────────────────────────────────────────╮\x1b[0m',
  '\x1b[2m│\x1b[0m \x1b[1mClaude Code\x1b[0m · resumed conversation           \x1b[2m│\x1b[0m',
  '\x1b[2m│\x1b[0m cwd: ~/ShipStudio/.shipstudio/agents/finance  \x1b[2m│\x1b[0m',
  '\x1b[2m╰───────────────────────────────────────────────╯\x1b[0m',
  '',
  '\x1b[2m> What’s outstanding this month?\x1b[0m',
  '',
  '⏺ Two invoices are overdue: Northwind ($4,200, 18 days) and Globex ($1,150, 6 days).',
  '',
  '> Draft the Globex reminder too, but softer — they’re a new client.',
  '',
  '⏺ \x1b[1mWrite\x1b[0m(drafts/globex-reminder.md)',
  '  ⎿  Wrote 9 lines to drafts/globex-reminder.md',
  '',
  '⏺ Done. It thanks them for the first project and asks gently whether the invoice reached the',
  '  right person.',
  '',
  '\x1b[2m────────────────────────────────────────────────────────────────────────\x1b[0m',
  '> ',
].join('\r\n');
const BYTES = Array.from(enc.encode(SCREEN));

const FINANCE_WAITING = (args: Record<string, unknown>) =>
  args.agentId === 'finance'
    ? [...messagesFor(args), msg('user', 'Also: did Globex reply?', 2, { agentId: 'finance' })]
    : messagesFor(args);

const pty = {
  pty_session_attach: {
    buffer: BYTES,
    pid: 4242,
    alive: true,
    exitCode: null,
    endOffset: BYTES.length,
  },
  pty_session_detach: null,
  pty_session_resize: null,
  pty_session_write: null,
  pty_session_set_paused: null,
};

const openFinance = { click: '[data-agent-id="finance"]' };
const openAcme = { click: '[data-agent-id="acme"]' };

export const agentsTakeoverScenarios: Scenario[] = [
  {
    id: 'agents-takeover-terminal',
    title: 'Agents — you’re driving Finance in a terminal',
    looksRightWhen:
      'Under Finance’s header, one quiet line: a small terminal icon in Finance’s colour, “You’re driving Finance in a terminal” (hovering it says edits are accepted automatically, Shift-Tab changes it), then “Show chat” and a secondary “Hand back” button at the trailing edge. Under that line, wrapping, the trust hint: “Claude Code will ask whether to trust this folder — choose “Yes, proceed”. Choosing No ends the take-over.” Below it the conversation’s place is taken by a terminal in the app’s own background (the fixture’s resumed Claude Code screen: the earlier question, a Write step, a reply, an empty prompt), with a focus ring around it because the keys go there. No composer. In the sidebar Finance’s row reads “You’re driving Finance”; the header status says the same.',
    openSelector: AGENTS_TAB,
    steps: [openFinance],
    requires: '.agent-chat[data-takeover-terminal] .agent-takeover-terminal .xterm',
    commands: {
      agents_overview: drivenTeam('finance'),
      agents_messages: messagesFor,
      ...pty,
    },
  },
  {
    id: 'agents-takeover-chat',
    title: 'Agents — driving Finance, the chat showing, a message waiting',
    looksRightWhen:
      'The same line under the header, now offering “Show terminal” and “Hand back”. The chat is back with its composer. Your newest message (“Also: did Globex reply?”) is dimmed with “Waiting, sends when you hand Finance back” under it, and no Interrupt link.',
    openSelector: AGENTS_TAB,
    steps: [openFinance, { click: '.agent-takeover__actions .text-button' }],
    requires:
      '.agent-takeover + .agent-chat__scroll, .agent-chat:not([data-takeover-terminal]) .agent-takeover',
    commands: {
      agents_overview: drivenTeam('finance'),
      agents_messages: FINANCE_WAITING,
      ...pty,
    },
  },
  {
    id: 'agents-takeover-project',
    title: 'Agents — driving Acme Site in its project',
    looksRightWhen:
      'Acme Site works in acme-marketing, so its session is a tab in that project’s workspace, not here. The chat stays as it was, with one line under the header: “You’re driving Acme Site in acme-marketing”, “Open in acme-marketing”, and “Hand back”. No trust hint (the fixture’s folder is trusted).',
    openSelector: AGENTS_TAB,
    steps: [openAcme],
    requires: '.agent-takeover',
    commands: {
      agents_overview: drivenTeam('acme'),
      agents_messages: messagesFor,
      ...pty,
    },
  },
  {
    id: 'agents-takeover-handback-busy',
    title: 'Agents — Hand back while the terminal is printing',
    looksRightWhen:
      'A dialog over Finance’s terminal: “Hand Finance back?”, “Finance is in the middle of something in the terminal. Handing back now stops it there.”, the hint “Anything typed in the terminal but not sent is dropped.”, then “Keep driving” and a red “Hand back anyway”.',
    openSelector: AGENTS_TAB,
    steps: [openFinance, { click: '.agent-takeover__actions > button:last-child' }],
    requires: '[aria-modal="true"]',
    commands: {
      agents_overview: drivenTeam('finance'),
      agents_messages: messagesFor,
      agents_hand_back: 'busy',
      ...pty,
    },
  },
  {
    id: 'agents-takeover-ended',
    title: 'Agents — a take-over that ended by itself, explained',
    looksRightWhen:
      'Finance’s chat, nobody driving. The newest line is an error: “Claude Code closed after 2 seconds (exit code 1), so the take-over ended and Finance has its session back. The last thing it showed:” and below it, in a mono block keeping its line breaks, the trust question with “2. No, exit” chosen. No Retry button on it. Above it, an earlier hand-back note: “You handed Finance back after 6 min”.',
    openSelector: AGENTS_TAB,
    steps: [openFinance],
    requires: '.agent-chat__messages',
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance'
          ? [
              ...messagesFor(args),
              msg('note', 'You handed Finance back after 6 min', 30, { agentId: 'finance' }),
              msg(
                'error',
                'Claude Code closed after 2 seconds (exit code 1), so the take-over ended and Finance has its session back. The last thing it showed:\n\nDo you trust the files in this folder?\n\n  1. Yes, proceed\n❯ 2. No, exit',
                1,
                { agentId: 'finance', takeover: true }
              ),
            ]
          : messagesFor(args),
    },
  },
  {
    id: 'agents-takeover-working',
    title: 'Agents — Take over while it works: stop, or wait',
    looksRightWhen:
      'A dialog over Acme Site’s chat: “Acme Site is working”, “Its session is in use, so you can’t step into it while it works. Stop it and take over now, or wait until it’s done.”, the hint “Stopping keeps what it already did, and drops what’s queued for it.”, then “Wait” and a red “Stop and take over”.',
    openSelector: AGENTS_TAB,
    steps: [openAcme, { click: '.agent-working__takeover' }],
    requires: '[aria-modal="true"]',
    commands: workCommands(true),
  },
  {
    id: 'agents-takeover-menu',
    title: 'Agents — Take over in the agent menu',
    looksRightWhen:
      'Finance’s … menu, open: Pin, Mark as unread, Mute notifications, Files, Schedule a check-in…, Edit agent…, then “Take over” with a terminal icon, then Start fresh… and the rest.',
    openSelector: AGENTS_TAB,
    steps: [openFinance, { click: '.agent-chat__menu button' }],
    requires: '[role="menu"]',
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
    },
  },
];
