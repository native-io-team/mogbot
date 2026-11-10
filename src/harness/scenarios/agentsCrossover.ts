/**
 * Carrying on with the other engine (`agents/crossover.rs`): the card that
 * asks the first time every Claude Code account is out, the quiet line and
 * the account row while Finance carries on with Codex, and the choice in
 * Settings → Agents → Usage. Shapes are serde's (camelCase, absent
 * optionals left out). Every name is fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, msg, now, overview } from './agents';
import { FULL_INVENTORY, usageCommands } from './agentsUsage';

const H = 3_600_000;
const BACK = now + 3 * H;
/** The reset as the card's Rust side writes it ("<time>"). */
const AT = new Date(BACK).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Finance's one Claude account is out; Codex is signed in with room. */
const OUT_ACCOUNTS = [
  {
    id: 'default',
    engine: 'claude',
    name: 'sam@example.com',
    named: false,
    thisMac: true,
    signedIn: true,
    email: 'sam@example.com',
    plan: 'Max',
    limit: { at: now - 20 * 60_000, resetsAt: BACK },
    out: true,
  },
  {
    id: 'default',
    engine: 'codex',
    name: 'sam@example.com',
    named: false,
    thisMac: true,
    signedIn: true,
    email: 'sam@example.com',
    plan: 'plus',
    out: false,
  },
];

const ASK = {
  requestId: 'xo1',
  title: `Your Claude Code account is out until ${AT}. Carry on with Codex until then?`,
  detail: '',
  summary:
    "Codex can't open Claude Code's conversation, so Finance starts there from your chat and its memory. When Claude Code has room again, Finance goes back to it and is told what happened meanwhile. Claude in Chrome stays with Claude Code; on Codex it uses your Chrome through the app's own extension. Always: whenever every Claude Code account is out. Change it in Settings → Agents → Usage.",
  status: 'pending',
  crossover: { from: 'claude', to: 'codex', until: BACK, resume: true },
};

const ASKING_CHAT = [
  msg('user', 'Draft the reminder to Globex and send it to me first.', 4, { agentId: 'finance' }),
  msg('approval', '', 3, { agentId: 'finance', approval: ASK }),
  msg('error', 'You’ve hit your 5-hour limit · resets 4pm', 3, {
    agentId: 'finance',
    failure: { kind: 'usage_limit', resetsAt: BACK },
  }),
];

const CARRIED_CHAT = [
  msg('user', 'Draft the reminder to Globex and send it to me first.', 12, { agentId: 'finance' }),
  msg(
    'note',
    `Carried on with Codex (Claude Code is out until ${AT}). Claude in Chrome stays with Claude Code; on Codex it uses your Chrome through the app's own extension.`,
    11,
    { agentId: 'finance' }
  ),
  msg(
    'agent',
    'Here’s the reminder to Globex, in your usual template. Say the word and I’ll send it.',
    10,
    { agentId: 'finance' }
  ),
];

const AWAY_TEAM = TEAM.map((a) =>
  a.id === 'finance'
    ? { ...a, away: { engine: 'codex', since: now - 11 * 60_000, until: BACK } }
    : a
);

const chat = (lines: unknown[]) => (args: Record<string, unknown>) =>
  args.agentId === 'finance' ? lines : messagesFor(args);

export const agentsCrossoverScenarios: Scenario[] = [
  {
    id: 'agents-crossover-card',
    title: 'Agents — every Claude Code account is out: carry on with Codex? (asked once)',
    looksRightWhen:
      'Finance’s chat: the user’s message, then one card with the Codex icon: “Your Claude Code account is out until <time>. Carry on with Codex until then?”, a paragraph that Codex starts from the chat and memory, goes back with a recap, and that Claude in Chrome stays with Claude Code while Codex uses the app’s own Chrome extension; three answers right-aligned: Wait and Just this time outlined, Always strong but neutral (never the accent). Under it the usage-limit error line with its Retry at <time>. Readable in both themes.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '.agent-crossover',
    clipSelector: '.agent-chat__scroll',
    commands: {
      agents_overview: overview(),
      agents_messages: chat(ASKING_CHAT),
      agents_accounts: OUT_ACCOUNTS,
    },
  },
  {
    id: 'agents-crossover-carried',
    title: 'Agents — Finance carrying on with Codex while Claude Code is out',
    looksRightWhen:
      'Finance’s chat: the user’s message, then one quiet line “Carried on with Codex (Claude Code is out until <time>).” with what stays with Claude Code, then Finance’s reply. At the sidebar’s foot the account row reads “Claude out” and, in amber, “on Codex” (until when is in its tooltip), with an amber dot, never red or accent.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '[data-testid="account-switcher"]',
    commands: {
      agents_overview: overview(AWAY_TEAM),
      agents_messages: chat(CARRIED_CHAT),
      agents_accounts: OUT_ACCOUNTS,
    },
  },
  {
    id: 'agents-crossover-row',
    title: 'Agents — the account row while agents carry on with Codex',
    looksRightWhen:
      'The account row at the foot of the sidebar: the Claude icon with an amber dot, “Claude out” and, in amber, “on Codex” (until when is in its tooltip). It truncates before it wraps.',
    openSelector: AGENTS_TAB,
    requires: '[data-testid="account-switcher"]',
    clipSelector: '.workspace-sidebar-footer',
    commands: {
      agents_overview: overview(AWAY_TEAM),
      agents_messages: messagesFor,
      agents_accounts: OUT_ACCOUNTS,
    },
  },
  {
    id: 'settings-agents-usage-crossover',
    title: 'Settings — Agents → Usage: when every account of an engine is out',
    looksRightWhen:
      'Under “How agents use your limits”, two more blocks: “When every Claude Code account is out” with a three-way control (Ask first | Carry on with Codex | Wait for the refill), Carry on pressed, neutral not accent, a muted line that turns move to Codex until Claude Code has room and never for an agent set to one account, then one amber status line “Claude Code out · on Codex until <time>”. Then “When every Codex account is out” with Ask first pressed and its muted line. Readable in both themes.',
    command: 'settings.page.accounts',
    requires: '.usage-panel [data-crossover="claude"] .agents-usage__state',
    clipSelector: '[data-crossover="claude"]',
    commands: {
      agents_overview: overview(AWAY_TEAM),
      agents_desktop_settings: {
        supported: true,
        menuBarIcon: true,
        quickEntry: true,
        shortcut: 'Alt+Space',
        shortcutLabel: '⌥Space',
      },
      ...usageCommands(FULL_INVENTORY),
      agents_crossover: {
        claude: 'carry',
        codex: 'ask',
        away: [{ agentId: 'finance', name: 'Finance', home: 'claude', on: 'codex', until: BACK }],
      },
    },
  },
];
