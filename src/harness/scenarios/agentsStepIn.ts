/**
 * "Step in" (`agents/step_in.rs`): Finance, in its own browser, hits a
 * Microsoft "verify it's you" step mid-task and asks the user to step in.
 * The card before, the chat while the user is in the tab (the bar above the
 * composer, the card saying so), and the line after Hand back. Shapes copied
 * from the Rust serde output (`StepIn`, camelCase). Fictional accounts.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, messagesFor, msg, overview, TEAM } from './agents';

const now = Date.now();
const MIN = 60_000;

const STEP_IN = {
  reason: 'approve the Microsoft sign-in on your phone',
  site: 'login.microsoftonline.com',
  url: 'https://login.microsoftonline.com/common/oauth2/authorize',
  pageTitle: 'Verify your identity',
  tab: 2,
};

const card = (status: 'pending' | 'allowed', inside: boolean, onPhone?: string) =>
  msg('approval', '', status === 'pending' ? 2 : 9, {
    agentId: 'finance',
    approval: {
      requestId: 'step-1',
      title: `Finance needs you in its browser: ${STEP_IN.reason}`,
      detail:
        'Its tab on login.microsoftonline.com opens on this Mac for you to do this yourself; Hand back when you’re done. It never sees what you type, only where the page ends up.',
      status,
      stepIn: inside
        ? {
            ...STEP_IN,
            inSince: now - 4 * MIN,
            until: now - 4 * MIN + 15 * MIN,
            ...(onPhone ? { onPhone } : {}),
          }
        : STEP_IN,
    },
  });

const chat =
  (status: 'pending' | 'allowed', inside: boolean, onPhone?: string) =>
  (args: Record<string, unknown>) =>
    args.agentId === 'finance'
      ? [
          msg('user', 'Pull last month’s invoices from the Acme billing portal.', 12, {
            agentId: 'finance',
          }),
          msg(
            'agent',
            'The portal sends me to Acme’s Microsoft sign-in, and it wants a tap on your phone to verify it’s you. I can’t do that one, so I’ve asked you to step in.',
            3,
            { agentId: 'finance' }
          ),
          card(status, inside, onPhone),
          ...(status === 'allowed'
            ? [
                msg(
                  'note',
                  'You handed Finance its browser back after 4 min · billing.acme.example',
                  2,
                  {
                    agentId: 'finance',
                  }
                ),
                msg('agent', 'Thanks, I’m in. Downloading October’s 14 invoices now.', 1, {
                  agentId: 'finance',
                }),
              ]
            : []),
        ]
      : messagesFor(args);

const withCard = overview(
  TEAM.map((a) => (a.id === 'finance' ? { ...a, pendingApprovals: 1 } : a))
);

export const agentsStepInScenarios: Scenario[] = [
  {
    id: 'agents-step-in-card',
    title: 'Agents — an agent asks you to step into its browser',
    looksRightWhen:
      'Under Finance’s line, one card “Finance needs you in its browser: approve the Microsoft sign-in on your phone” with a globe; under the title, muted, “login.microsoftonline.com · Verify your identity”; a muted note that its tab opens on this Mac and it never sees what you type. Not now (outlined) and Step in (neutral strong, never the accent).',
    openSelector: AGENTS_TAB,
    requires: '.agent-step-in',
    clipSelector: '.agent-step-in',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: withCard,
      agents_messages: chat('pending', false),
    },
  },
  {
    id: 'agents-step-in-active',
    title: 'Agents — you’re in an agent’s browser',
    looksRightWhen:
      'Above the composer, one bar with a globe: “You’re in Finance’s browser” and, muted, “login.microsoftonline.com · hands back by itself in 11 min”, with Show window and Hand back. The card above only says “You’re in its browser now. Hand back from the bar below when you’re done.”: no buttons (the bar has them), no Step in.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="agent-step-in-bar"]',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: withCard,
      agents_messages: chat('pending', true),
    },
  },
  {
    id: 'agents-step-in-from-phone',
    title: 'Agents — your phone is in an agent’s browser',
    looksRightWhen:
      'Above the composer, one bar with a globe: “Sam’s iPhone is in Finance’s browser” and, muted, the site and when it hands back by itself, with only Hand back (no Show window: the window stays parked on the Mac). The card above says “Sam’s iPhone is in its browser now. Hand back there, or here.” with Hand back.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="agent-step-in-bar"]',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: withCard,
      agents_messages: chat('pending', true, 'Sam’s iPhone'),
    },
  },
  {
    id: 'agents-step-in-handed-back',
    title: 'Agents — handed back',
    looksRightWhen:
      'The card folded to one line, “Finance needs you in its browser: … · Handed back”; under it a quiet line “You handed Finance its browser back after 4 min · billing.acme.example”, then Finance carrying on. No bar above the composer.',
    openSelector: AGENTS_TAB,
    requires: '.agent-step-in',
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: chat('allowed', false),
    },
  },
];
