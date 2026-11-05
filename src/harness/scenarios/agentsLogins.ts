/**
 * Logins (`agents/logins.rs`): the login card an agent's `request_login`
 * raises, in each phase (choosing, signing in on the Mac from the phone,
 * failed, connected), the honest cards for a service with no connector and
 * for an agent on Codex, "What your team needs" (one row per app across the
 * team, with progress), and "What it can reach" in Edit agent. Shapes copied
 * from the Rust serde output (camelCase), as `fixtures.gen.ts` has them.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const CLAUDE_AI = {
  id: 'claude_ai',
  method: 'claude_ai',
  label: 'Connect Gmail',
  detail:
    'Uses claude.ai’s Gmail connector, which keeps the sign-in with your Claude account. If it isn’t added yet, claude.ai opens in this Mac’s browser to add it. Hiring never sees a password.',
};
const BROWSER = (site: string, name = 'Hiring') => ({
  id: 'browser',
  method: 'browser',
  label: 'Use my browser',
  detail: `${name} works in your own Chrome on this Mac, where you’re already signed in to ${site}, through Claude in Chrome. It asks you here before every click, post, send or payment; it never sees your password.`,
});
const GH = {
  id: 'gh',
  method: 'gh',
  label: 'Use GitHub on this Mac',
  detail:
    'Uses the GitHub CLI’s sign-in on this Mac. It works through `gh` commands; anything that changes GitHub asks you first.',
};

const GMAIL_LOGIN = {
  service: 'gmail',
  title: 'Gmail',
  askedAs: 'gmail native',
  accountHint: 'work',
  why: 'Screen new applications that arrive in the hiring inbox.',
  abilities: [
    { id: 'read', label: 'Read and search your email' },
    { id: 'write', label: 'Draft and send email — it asks you on a card each time' },
  ],
  options: [CLAUDE_AI, BROWSER('mail.google.com')],
  quiet: true,
};

const loginCard = (
  agentId: string,
  title: string,
  login: Record<string, unknown>,
  over: Record<string, unknown> = {}
) =>
  msg('approval', '', 3, {
    agentId,
    approval: {
      requestId: `login-${agentId}`,
      title,
      detail: String(login.why),
      status: 'pending',
      login,
      ...over,
    },
  });

const hiringWith = (pending: number) =>
  overview(
    TEAM.map((a) =>
      a.id === 'hiring'
        ? {
            ...a,
            pendingApprovals: pending,
            status: status('idle'),
            preview: (pending
              ? 'Needs your OK: Hiring needs your Gmail (work)'
              : a.preview) as null,
          }
        : a
    )
  );

const chatFor = (agentId: string, lines: unknown[]) => (args: Record<string, unknown>) =>
  args.agentId === agentId ? lines : messagesFor(args);

const COMMANDS = {
  agents_login_start: null,
  agents_login_cancel: null,
  agents_login_decline: null,
  agents_login_save_key: null,
};

const hiringScenario = (
  id: string,
  title: string,
  looksRightWhen: string,
  card: unknown,
  pending = 1
): Scenario => ({
  id,
  title,
  looksRightWhen,
  requires: '.agent-login',
  openSelector: AGENTS_TAB,
  steps: [{ click: '[data-agent-id="hiring"]' }],
  commands: {
    agents_overview: hiringWith(pending),
    agents_messages: chatFor('hiring', [
      msg('user', 'Go through this week’s applications and shortlist five.', 5, {
        agentId: 'hiring',
      }),
      card,
      msg(
        'agent',
        'I need your work Gmail to read the applications. I’ve asked on a card: you connect it, I never see a password.',
        3,
        { agentId: 'hiring' }
      ),
    ]),
    ...COMMANDS,
  },
});

/* ------------------------------------------------------------ team list */

const card = (
  agentId: string,
  agentName: string,
  service: string,
  title: string,
  state: string,
  extra: Record<string, unknown> = {}
) => ({
  agentId,
  agentName,
  requestId: `t-${agentId}-${service}`,
  service,
  title,
  abilities: [
    {
      id: 'read',
      label:
        service === 'github'
          ? 'Read repositories, issues and pull requests'
          : service === 'linkedin'
            ? 'Read your feed, profile and messages'
            : service === 'gmail'
              ? 'Read and search your email'
              : 'See your calendar',
    },
  ],
  state,
  ...extra,
});

const TEAM_NEEDS = (connectedGithub: boolean) => {
  const github = {
    key: 'github',
    title: 'GitHub',
    services: ['github'],
    options: connectedGithub ? [] : [GH],
    cards: ['acme', 'native', 'clients'].map((id) => {
      const name = TEAM.find((a) => a.id === id)?.name ?? id;
      return card(
        id,
        name,
        'github',
        'GitHub',
        connectedGithub ? 'connected' : 'waiting',
        connectedGithub ? { outcome: 'Connected · GitHub (julian)' } : {}
      );
    }),
    done: connectedGithub,
  };
  const needs = [
    {
      key: 'google',
      title: 'Google · Gmail + Calendar',
      services: ['gmail', 'google_calendar'],
      options: [
        { ...CLAUDE_AI, label: 'Connect Google' },
        BROWSER('mail.google.com', 'Each agent'),
      ],
      noConnector:
        'Google only lets apps it has approved use Gmail’s own connector, so Gmail comes through claude.ai’s connector or your browser.',
      cards: [
        card('hiring', 'Hiring', 'gmail', 'Gmail', 'waiting', { askedAs: 'gmail native' }),
        card('leadgen', 'Lead Gen', 'gmail', 'Gmail', 'waiting'),
        card('finance', 'Finance', 'google_calendar', 'Google Calendar', 'skipped', {
          outcome: 'Not needed',
        }),
      ],
      done: false,
    },
    {
      key: 'linkedin',
      title: 'LinkedIn',
      services: ['linkedin'],
      options: [BROWSER('www.linkedin.com', 'Social Posts')],
      noConnector: 'LinkedIn has no connector agents can sign in to.',
      cards: [
        card('social', 'Social Posts', 'linkedin', 'LinkedIn', 'waiting', {
          abilities: [
            { id: 'read', label: 'Read your feed, profile and messages' },
            { id: 'write', label: 'Post and send messages — it asks you on a card each time' },
          ],
        }),
      ],
      done: false,
    },
  ];
  return connectedGithub ? [...needs, github] : [github, ...needs];
};

const teamScenario = (
  id: string,
  title: string,
  looksRightWhen: string,
  connectedGithub: boolean
): Scenario => ({
  id,
  title,
  looksRightWhen,
  requires: '.team-logins__row',
  openSelector: AGENTS_TAB,
  steps: [
    { key: 'mod+k' },
    { fill: '.command-palette-input', value: 'Set up logins' },
    { click: '.command-palette [role="option"]', text: 'Set up logins' },
  ],
  commands: {
    agents_overview: overview(),
    agents_messages: messagesFor,
    agents_logins_team: {
      needs: TEAM_NEEDS(connectedGithub),
      done: connectedGithub ? 1 : 0,
      total: 3,
    },
    agents_logins_connect: null,
    agents_login_dismiss: null,
  },
});

export const agentsLoginsScenarios: Scenario[] = [
  hiringScenario(
    'agents-login-card',
    'Agents — a login card (Gmail: Connect, or use my browser)',
    'Hiring’s chat: a lock card “Hiring needs your Gmail (work)”, a muted “Asked for as “gmail native””, the reason, then two bullet lines: “Read and search your email” and “Draft and send email — it asks you on a card each time”. A muted line saying it uses claude.ai’s Gmail connector and Hiring never sees a password. Under a hairline, “Use my browser” as a quiet text action with its explanation (every click, post, send or payment asks first). Right-aligned: secondary “Not now”, neutral (not accent) “Connect Gmail”. No password field anywhere.',
    loginCard('hiring', 'Hiring needs your Gmail (work)', GMAIL_LOGIN)
  ),
  hiringScenario(
    'agents-login-from-phone',
    'Agents — a login started from the phone, signing in on this Mac',
    'The same card mid sign-in: a small spinner and “claude.ai’s connectors are open in this Mac’s browser. Add Gmail there; this card notices when it’s connected.”, a muted phone icon with “Started from your phone”. No other ways in; only a secondary Cancel on the right.',
    loginCard('hiring', 'Hiring needs your Gmail (work)', {
      ...GMAIL_LOGIN,
      flow: {
        state: 'waiting',
        option: 'claude_ai',
        message:
          'claude.ai’s connectors are open in this Mac’s browser. Add Gmail there; this card notices when it’s connected.',
        startedAt: now - MIN,
        fromPhone: true,
      },
    })
  ),
  hiringScenario(
    'agents-login-failed',
    'Agents — a login that didn’t connect',
    'The card with a red error line “Gmail didn’t show up as connected within ten minutes. Try again once it’s added on claude.ai.”, the other way in still offered, and a neutral “Try again” beside “Not now”.',
    loginCard('hiring', 'Hiring needs your Gmail (work)', {
      ...GMAIL_LOGIN,
      flow: {
        state: 'failed',
        option: 'claude_ai',
        message:
          'Gmail didn’t show up as connected within ten minutes. Try again once it’s added on claude.ai.',
        startedAt: now - MIN,
      },
    })
  ),
  hiringScenario(
    'agents-login-connected',
    'Agents — a login card once connected',
    'The card folded to its outcome in the done tone: “Connected · Gmail (work@acme.com)”. No buttons, no field.',
    loginCard('hiring', 'Hiring needs your Gmail (work)', GMAIL_LOGIN, {
      status: 'allowed',
      choice: 'Connected · Gmail (work@acme.com)',
    }),
    0
  ),
  {
    id: 'agents-login-linkedin',
    title: 'Agents — LinkedIn: no connector, so the browser',
    looksRightWhen:
      'Social Posts’ chat: “Social Posts needs your LinkedIn”, the reason, read and post lines (posting asks each time), a muted honest line “LinkedIn has no connector agents can sign in to.”, then the browser explanation, and a neutral “Use my browser” beside “Not now”. No password field.',
    requires: '.agent-login',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="social"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: chatFor('social', [
        loginCard('social', 'Social Posts needs your LinkedIn', {
          service: 'linkedin',
          title: 'LinkedIn',
          why: 'Post the weekly update to your LinkedIn.',
          abilities: [
            { id: 'read', label: 'Read your feed, profile and messages' },
            { id: 'write', label: 'Post and send messages — it asks you on a card each time' },
          ],
          options: [BROWSER('www.linkedin.com', 'Social Posts')],
          noConnector: 'LinkedIn has no connector agents can sign in to.',
        }),
      ]),
      ...COMMANDS,
    },
  },
  {
    id: 'agents-login-codex',
    title: 'Agents — a Codex agent asking for Gmail: nothing here can',
    looksRightWhen:
      'Lead Gen’s chat: “Lead Gen needs your Gmail” with the read line, and a muted honest line that Gmail comes through a claude.ai connector, which only agents on Claude Code can use, and Lead Gen runs on Codex. Only “Not now”; no Connect, no password field.',
    requires: '.agent-login',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'leadgen' ? { ...a, engine: 'codex' as const } : a))
      ),
      agents_messages: chatFor('leadgen', [
        loginCard('leadgen', 'Lead Gen needs your Gmail', {
          service: 'gmail',
          title: 'Gmail',
          why: 'Find replies from the leads it wrote to.',
          abilities: [{ id: 'read', label: 'Read and search your email' }],
          options: [],
          noConnector:
            'Gmail comes through a claude.ai connector, which only agents on Claude Code can use. Lead Gen runs on Codex. Using your browser needs Claude Code, and Lead Gen runs on Codex.',
        }),
      ]),
      ...COMMANDS,
    },
  },
  teamScenario(
    'agents-team-logins',
    'Agents — What your team needs (one row per app)',
    'A dialog “What your team needs”: a lede that connecting signs in on this Mac and no agent sees a password; “0 of 3 connected”. Rows, each a bordered panel: “GitHub — Used by Acme Site, Native App and Client Sites QA” with three ticked agents and a neutral “Use GitHub on this Mac for 3”; “Google · Gmail + Calendar — Used by Hiring, Lead Gen and Finance”, Hiring and Lead Gen ticked with “Not needed” beside each, Finance muted “Not needed”, the honest Google line, a secondary “Use my browser” and neutral “Connect Google for 2”; “LinkedIn” for Social Posts with only “Use my browser”.',
    false
  ),
  teamScenario(
    'agents-team-logins-progress',
    'Agents — What your team needs, partly done',
    'As agents-team-logins but “1 of 3 connected”: Google and LinkedIn first, and GitHub last with a green check, no panel fill and a “Show” text action (folded).',
    true
  ),
  {
    id: 'agents-reach-editor',
    title: 'Agents — What it can reach, in Edit agent',
    looksRightWhen:
      'Editing Hiring, below Permissions: “What it can reach” with “Apps”: “Gmail · work@acme.com — Can read; asks before it sends or changes anything · Connected on claude.ai; the sign-in is held there · used 2 hours ago” and “Linear” with an amber “Needs signing in again” line; “Your browser”: Chrome through Claude in Chrome, for www.linkedin.com, every click asks; “Keys in your Keychain”: one key; each row with a quiet Remove.',
    openSelector: AGENTS_TAB,
    requires: '.agent-reach__section',
    clipSelector: '.agent-editor [role="group"][aria-label="What it can reach"]',
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
            connectionId: 'c1',
            service: 'gmail',
            title: 'Gmail',
            account: 'work@acme.com',
            access: 'full',
            kept: 'Connected on claude.ai; the sign-in is held there',
            needsSignIn: false,
            lastUsedAt: now - 120 * MIN,
          },
          {
            connectionId: 'c2',
            service: 'linear',
            title: 'Linear',
            account: 'Linear',
            access: 'read',
            kept: 'Signed in on this Mac; the token is in its Keychain',
            needsSignIn: true,
          },
        ],
        browser: { on: true, sites: ['www.linkedin.com'], helperInstalled: true },
        secrets: [
          {
            secretId: 's1',
            name: 'greenhouse_key',
            purpose: 'Read candidates from Greenhouse',
            variables: ['$GREENHOUSE_KEY'],
          },
        ],
        blockedApps: [],
      },
      agents_reach_remove: null,
    },
  },
];
