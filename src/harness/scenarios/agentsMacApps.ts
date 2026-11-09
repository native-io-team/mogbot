/**
 * This Mac's apps (`agents/mac_apps.rs`): the one card an agent's first use
 * of an app raises ("Allow Hiring to use your Messages?", showing the exact
 * words of the message it would send), and the apps it was given as they
 * appear in "What it can reach". Shapes copied from the Rust serde output
 * (camelCase): the card is `mcp::ask_user_with_summary`'s, the rows are
 * `logins::reach`'s for `connections::Kind::MacApp`.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

/** As `connections::Connection::kept` says it for this Mac's apps. */
const KEPT = "This Mac's own app; macOS asks once, in System Settings → Privacy & Security";

/** `mac_apps::card` for a send: what it wants, then what Allow gives. */
const SEND_CARD = {
  requestId: 'mac-messages',
  title: 'Allow Hiring to use your Messages?',
  summary:
    'It wants to send +15551234567 this message:\n\n“Hi Sam, thanks for applying. Are you free for a call on Thursday at 3pm?”\n\nAllow does this now, and lets it read your Messages on this Mac from now on. Anything else it adds, changes or sends follows how much you let it do on its own. Take it back any time in What it can reach. macOS may ask you once too.',
  detail:
    '{\n  "to": "+15551234567",\n  "text": "Hi Sam, thanks for applying. Are you free for a call on Thursday at 3pm?"\n}',
  status: 'pending',
};

const hiringWaiting = () =>
  overview(
    TEAM.map((a) =>
      a.id === 'hiring'
        ? {
            ...a,
            pendingApprovals: 1,
            status: status('waiting'),
            preview: 'Needs your OK: Allow Hiring to use your Messages?' as unknown as null,
          }
        : a
    )
  );

const hiringChat = (args: Record<string, unknown>) =>
  args.agentId === 'hiring'
    ? [
        msg('user', 'Text Sam and ask if Thursday at 3 works for a call.', 4, {
          agentId: 'hiring',
        }),
        msg('approval', '', 3, { agentId: 'hiring', approval: SEND_CARD }),
      ]
    : messagesFor(args);

export const agentsMacAppsScenarios: Scenario[] = [
  {
    id: 'agents-mac-apps-card',
    title: 'Agents — first use of Messages: one card that grants it and shows the words',
    looksRightWhen:
      'Hiring’s chat: the user’s “Text Sam…” then one approval card titled “Allow Hiring to use your Messages?”, leading with “It wants to send +15551234567 this message:” and the exact words in quotes, then one paragraph saying Allow does this now and gives it Messages from now on, later changes follow its independence, and it’s taken back in What it can reach. Allow is neutral (never the accent), Deny beside it; the raw JSON only behind Details.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat',
    steps: [{ click: '[data-agent-id="hiring"]' }],
    commands: {
      agents_overview: hiringWaiting(),
      agents_messages: hiringChat,
    },
  },
  {
    id: 'agents-mac-apps-reach',
    title: 'Agents — this Mac’s apps in What it can reach',
    looksRightWhen:
      'Editing Hiring, the “Apps” section of What it can reach: “Calendar · This Mac — Can read · This Mac’s own app; macOS asks once, in System Settings → Privacy & Security · used 20m ago” and “Messages · This Mac — Can read; asks before it sends or changes anything”, each with a quiet Remove.',
    openSelector: AGENTS_TAB,
    requires: '.agent-reach__section',
    clipSelector: '.agent-reach__section[aria-label="Apps"]',
    steps: [
      { click: '[data-agent-id="hiring"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: overview(),
      agents_messages: messagesFor,
      agents_instructions: 'Screens applications and books interviews.',
      agents_reach: {
        connections: [
          {
            connectionId: 'm1',
            service: 'mac_calendar',
            title: 'Calendar',
            account: 'This Mac',
            access: 'read',
            kept: KEPT,
            needsSignIn: false,
            lastUsedAt: now - 20 * MIN,
          },
          {
            connectionId: 'm2',
            service: 'mac_messages',
            title: 'Messages',
            account: 'This Mac',
            access: 'full',
            kept: KEPT,
            needsSignIn: false,
          },
        ],
        browser: { on: true, sites: [], helperInstalled: true },
        secrets: [],
        blockedApps: [],
      },
      agents_reach_remove: null,
    },
  },
];
