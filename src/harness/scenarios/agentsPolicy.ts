/**
 * What each agent can do (`agents/policy.rs`): the "Change Hiring's
 * settings?" card the Chief raises from chat (`propose_settings_change`),
 * the same card once allowed, Edit agent's "What it can do" for an agent
 * with settings of its own, and Settings → Agents → What agents can do.
 * Shapes copied from the Rust serde output, as `fixtures.gen.ts` has them.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, DEFAULTS, ENGINES, messagesFor, msg, overview, TEAM } from './agents';
import { BALANCED_LINES, BALANCED_TEAM, BALANCED_VIEW } from '../fixtures/policy';

const SUMMARY =
  'Hiring: Can now work in client-site (its own copy). Can no longer use your browser. New rule: “Never email candidates directly” (an instruction, not enforced).';

const card = (status: 'pending' | 'allowed') =>
  msg('approval', '', 1, {
    agentId: 'chief',
    approval: {
      requestId: 'settings-1',
      title: 'Change Hiring’s settings?',
      detail: `${SUMMARY}\n\nWhy: You asked for Hiring to help on the client site`,
      summary: SUMMARY,
      status,
      settings: {
        targets: [{ kind: 'agent', agentId: 'hiring' }],
        change: {
          addProjects: ['/Users/sam/Projects/client-site'],
          browser: false,
          addRules: ['Never email candidates directly'],
        },
        version: 4,
        groups: [
          {
            who: 'Hiring',
            agentIds: ['hiring'],
            changes: [
              'Can now work in client-site (its own copy)',
              'Can no longer use your browser',
              'New rule: “Never email candidates directly” (an instruction, not enforced)',
            ],
          },
        ],
        why: 'You asked for Hiring to help on the client site',
        hasRules: true,
      },
    },
  });

const chat = (status: 'pending' | 'allowed') => (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [
        msg(
          'user',
          'Hiring should be able to work on the client site, but keep it off my browser. And it should never email candidates directly.',
          2
        ),
        msg('agent', 'I’ve put the change on a card for you to allow.', 1),
        card(status),
      ]
    : messagesFor(args);

const HIRING_VIEW = {
  ...BALANCED_VIEW,
  agentId: 'hiring',
  preset: undefined,
  sameAsTeam: false,
  lines: BALANCED_LINES.map((l) =>
    l.key === 'projects'
      ? {
          ...l,
          value:
            'Only client-site and marketing-site · its own copy in client-site; changes the others directly',
          team: false,
        }
      : l.key === 'browser'
        ? { ...l, value: 'No', team: false }
        : l.key === 'folders'
          ? { ...l, value: '~/Documents/Candidates (read)', team: false }
          : l.key === 'rules'
            ? { ...l, value: '“Never email candidates directly”', team: false }
            : l
  ),
  effective: {
    ...BALANCED_VIEW.effective,
    projects: {
      scope: 'listed' as const,
      listed: ['/Users/sam/Projects/client-site', '/Users/sam/Projects/marketing-site'],
      how: 'copy' as const,
      elsewhere: 'change' as const,
    },
    folders: [{ path: '/Users/sam/Documents/Candidates', write: false }],
    browser: false,
    ownRules: ['Never email candidates directly'],
    own: ['projects', 'folders', 'browser', 'rules'],
  },
};

/** The team at Bold; Social Posts on Unleashed and Finance on Careful, on their own. */
const LEVELS_TEAM = TEAM.map((a) =>
  a.id === 'social'
    ? { ...a, independence: 'full_send' }
    : a.id === 'finance'
      ? { ...a, independence: 'often' }
      : a
);
const LEVELS_OVERVIEW = { ...overview(LEVELS_TEAM), independence: 'go_hard' };

/** "Do these under your name?" (`ask_plan`): the owner's real plan, one card. */
const PLAN = {
  actions: [
    { kind: 'deploy', target: 'shippy', summary: 'Redeploy shippy’s production on Vercel' },
    { kind: 'issue', target: 'julian/shippy', summary: 'Open an issue about the failed build' },
    { kind: 'comment', target: 'julian/shippy', summary: 'Comment on #12 with the fix' },
    { kind: 'comment', target: 'julian/shippy', summary: 'Comment on #14 pointing to the issue' },
  ],
  why: 'Production is down since this morning’s push',
};
const PLAN_LIST = PLAN.actions.map((a, i) => `${i + 1}. ${a.summary}`).join('\n');

const planChat = (status: 'pending' | 'allowed') => (args: Record<string, unknown>) =>
  args.agentId === 'chief'
    ? [
        msg('user', 'Get shippy back up and tell people on GitHub what happened.', 2),
        msg('agent', 'Here’s the plan. One OK covers all four.', 1),
        msg('approval', '', 1, {
          agentId: 'chief',
          approval: {
            requestId: 'plan-1',
            title: 'Do these under your name?',
            detail: PLAN_LIST,
            summary: `${PLAN_LIST}\n\n${PLAN.why}`,
            status,
            plan: PLAN,
          },
        }),
      ]
    : messagesFor(args);

export const agentsPolicyScenarios: Scenario[] = [
  {
    id: 'agents-level-picker',
    title: 'Agents — one agent’s own level, in Edit agent',
    looksRightWhen:
      'Editing Hiring, which follows the team: “How much it does on its own” with a menu open under its button “Same as team (Bold)”: “Same as team (Bold)” checked first, a divider, then Careful, Steady, Bold, Unleashed. Under the row a muted line for Bold and what always asks. In the sidebar, Social Posts shows a tiny “Unleashed” label and Finance “Careful”; nobody else has one.',
    openSelector: AGENTS_TAB,
    requires: '.agent-level-picker',
    steps: [
      { click: '[data-agent-id="hiring"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-level-picker button' },
    ],
    commands: {
      agents_overview: LEVELS_OVERVIEW,
      agents_messages: messagesFor,
      agents_instructions: 'Screens applications and books interviews.',
      agents_policy: HIRING_VIEW,
    },
  },
  {
    id: 'settings-agents-independence-own',
    title: 'Settings — Independence, with agents set on their own',
    looksRightWhen:
      'The team’s slider on Bold (a neutral thumb), its line and the always-asks line, and under it a muted “Agents set on their own: 2”.',
    command: 'agents.independence',
    requires: '.agent-independence-settings__own',
    clipSelector: 'section[aria-labelledby="agents-settings-independence"]',
    commands: {
      agents_overview: { ...LEVELS_OVERVIEW, engines: ENGINES, defaults: DEFAULTS },
    },
  },
  {
    id: 'agents-plan-card',
    title: 'Agents — “Do these under your name?”, one card for the whole plan',
    looksRightWhen:
      'The Chief’s chat: the user’s ask, the Chief’s one line, then one card titled “Do these under your name?” with a numbered list of four actions, each with where it happens (shippy, julian/shippy) in muted text after it, and a muted “Why: …”. Deny (outlined) and Allow (neutral strong, never the accent). No raw command.',
    openSelector: AGENTS_TAB,
    requires: '.agent-plan',
    clipSelector: '.agent-approval',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: planChat('pending'),
    },
  },
  {
    id: 'agents-plan-card-allowed',
    title: 'Agents — a plan card once allowed',
    looksRightWhen:
      'The same card folded to one quiet line: “Do these under your name? · Allowed · each step runs without asking for an hour”. No buttons.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__row--agent',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: planChat('allowed'),
    },
  },
  {
    id: 'agents-settings-card',
    title: 'Agents — “Change Hiring’s settings?”, proposed from chat',
    looksRightWhen:
      'The Chief’s chat: the user’s request, the Chief’s one line, then a card with a sliders icon titled “Change Hiring’s settings?”: “Hiring” in bold over three plain lines (can now work in client-site in its own copy; can no longer use your browser; the new rule, marked as an instruction), a muted “Why: …” and a muted line that rules are instructions the app doesn’t enforce. Deny (outlined) and Allow (neutral strong, never the accent).',
    openSelector: AGENTS_TAB,
    requires: '.agent-settings-change',
    clipSelector: '.agent-approval',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: chat('pending'),
    },
  },
  {
    id: 'agents-settings-card-allowed',
    title: 'Agents — a settings card once allowed',
    looksRightWhen:
      'The same card resolved: folded to one quiet line, “Change Hiring’s settings? · Changed · from each agent’s next turn” with “Show request”, as every answered card folds. No buttons.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat__row--agent',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: chat('allowed'),
    },
  },
  {
    id: 'agents-policy-editor',
    title: 'Agents — What it can do, in Edit agent',
    looksRightWhen:
      'Editing Hiring: “What it can do” with a menu button “Its own settings”, then one line each: Projects (only client-site and marketing-site, its own copy in client-site), Folders on this Mac (~/Documents/Candidates, read), Apps, Your browser “No”, Independence “Steady · Team default · instructions”, Admin “No”, Rules with “Never email candidates directly” and a Remove. Lines it has of its own say “Its own”; the rest “Team default”. Under them a muted line that the app enforces these except independence and rules, and a “Change in chat” text button.',
    openSelector: AGENTS_TAB,
    requires: '.agent-policy__line',
    clipSelector: '.agent-editor [role="group"][aria-label="What it can do"]',
    steps: [
      { click: '[data-agent-id="hiring"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_instructions: 'Screens applications and books interviews.',
      agents_policy: HIRING_VIEW,
    },
  },
  {
    id: 'settings-agents-policy',
    title: 'Settings — What agents can do, with presets',
    looksRightWhen:
      'Opened from ⌘K “What agents can do…”: a lead that every agent starts from these and that the Chief of Staff can change them in chat; three choices (I trust my agents, Balanced selected with a neutral stronger border, Locked down) with one line each; the team’s lines; the note on what’s enforced; “1 agent has settings of its own: Hiring.” and a secondary “Reset everyone to Balanced”.',
    command: 'agents.policyDefaults',
    requires: '.agent-team-policy__preset[aria-checked="true"]',
    clipSelector: 'section[aria-labelledby="agents-settings-policy"]',
    commands: {
      agents_overview: { ...overview(TEAM), engines: ENGINES, defaults: DEFAULTS },
      agents_policy_team: { ...BALANCED_TEAM, ownSettings: ['Hiring'] },
    },
  },
];
