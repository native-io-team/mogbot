/**
 * Logins (`agents/logins.rs`): the login card an agent's `request_login`
 * raises, in each phase (choosing, signing in on the Mac from the phone,
 * failed, connected), the honest cards for a service with no connector and
 * for an agent on Codex, "What your team needs" (one row per app across the
 * team, with progress), and "What it can reach" in Edit agent. Shapes copied
 * from the Rust serde output (camelCase), as `fixtures.gen.ts` has them.
 */

import type { Scenario } from '../types';
import {
  AGENTS_TAB,
  MIN,
  TEAM as BASE_TEAM,
  messagesFor,
  msg,
  now,
  overview,
  status,
} from './agents';

/** The shared team, with fictional names for the agents these cards are about. */
const RENAMED: Record<string, string> = {
  hiring: 'Recruiter',
  leadgen: 'Prospector',
  social: 'Publicist',
};
const TEAM = BASE_TEAM.map((a) => (RENAMED[a.id] ? { ...a, name: RENAMED[a.id] } : a));

const CLAUDE_AI = {
  id: 'claude_ai',
  method: 'claude_ai',
  label: 'Connect on claude.ai',
  detail:
    'Connect Gmail in Claude: it opens Claude’s connectors page; turn on Gmail, then come back. The sign-in stays with your Claude account and Recruiter never sees a password.',
};
const BROWSER = (site: string, name = 'Recruiter') => ({
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
  askedAs: 'gmail work',
  accountHint: 'work',
  why: 'Screen new applications that arrive in the recruiter inbox.',
  abilities: [
    { id: 'read', label: 'Read and search your email' },
    { id: 'write', label: 'Draft and send email — it asks you on a card each time' },
  ],
  options: [BROWSER('mail.google.com'), CLAUDE_AI],
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

const recruiterWith = (pending: number) =>
  overview(
    TEAM.map((a) =>
      a.id === 'hiring'
        ? {
            ...a,
            pendingApprovals: pending,
            status: status('idle'),
            preview: (pending
              ? 'Needs your OK: Recruiter needs your Gmail (work)'
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

const recruiterScenario = (
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
    agents_overview: recruiterWith(pending),
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
        connectedGithub ? { outcome: 'Connected · GitHub (sam-acme)' } : {}
      );
    }),
    done: connectedGithub,
  };
  const needs = [
    {
      key: 'google',
      title: 'Google · Gmail + Calendar',
      services: ['gmail', 'google_calendar'],
      options: [BROWSER('mail.google.com', 'Each agent'), CLAUDE_AI],
      noConnector:
        'Google only lets apps it has approved use Gmail’s own connector, so Gmail comes through claude.ai’s connector or your browser.',
      cards: [
        card('hiring', 'Recruiter', 'gmail', 'Gmail', 'waiting', { askedAs: 'gmail work' }),
        card('leadgen', 'Prospector', 'gmail', 'Gmail', 'waiting'),
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
      options: [BROWSER('www.linkedin.com', 'Publicist')],
      noConnector: 'LinkedIn has no connector agents can sign in to.',
      cards: [
        card('social', 'Publicist', 'linkedin', 'LinkedIn', 'waiting', {
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
  recruiterScenario(
    'agents-login-card',
    'Agents — a login card (Gmail: Connect, or use my browser)',
    'Recruiter’s chat: a lock card “Recruiter needs your Gmail (work)”, a muted “Asked for “Gmail work””, the reason, then one quiet line “Read and search your email · Draft and send email — it asks you on a card each time”. One short muted line “Uses your Chrome on this Mac. It asks before anything it sends.”, then a quiet “Other ways” text action (collapsed). Right-aligned: secondary “Not now” and neutral (not accent) “Use my browser”, nothing else. No password field anywhere.',
    loginCard('hiring', 'Recruiter needs your Gmail (work)', GMAIL_LOGIN)
  ),
  recruiterScenario(
    'agents-login-from-phone',
    'Agents — a login started from the phone, signing in on this Mac',
    'The same card mid sign-in: a small spinner and “claude.ai’s connectors are open in this Mac’s browser. Add Gmail there; this card notices when it’s connected.”, a muted phone icon with “Started from your phone”. No other ways in; only a secondary Cancel on the right.',
    loginCard('hiring', 'Recruiter needs your Gmail (work)', {
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
  recruiterScenario(
    'agents-login-opened-quiet',
    'Agents — a sign-in opened in this Mac’s browser, nothing back after 20 s',
    'The Gmail card mid sign-in on this Mac: a spinner and “Claude’s connectors page opened in your browser. Find Gmail, choose Connect, then come back: this card turns on by itself.”, then a muted line “Still not connected. If Claude’s connectors page didn’t open, open it again or copy the link.” with two quiet text actions “Open again · Copy link”. Only a secondary Cancel on the right. Never a spinner alone.',
    loginCard('hiring', 'Recruiter needs your Gmail (work)', {
      ...GMAIL_LOGIN,
      flow: {
        state: 'waiting',
        option: 'claude_ai',
        message:
          'Claude’s connectors page opened in your browser. Find Gmail, choose Connect, then come back: this card turns on by itself.',
        startedAt: now - MIN,
        url: 'https://claude.ai/customize/connectors',
        openedAt: now - MIN,
      },
    })
  ),
  recruiterScenario(
    'agents-login-device-code',
    'Agents — GitHub signing in on the phone with a one-time code',
    'A “Recruiter needs your GitHub” card mid sign-in: spinner and “Type this code at github.com/login/device, on this phone or anywhere.”, then a bordered box “Your code WDJB-MJHT” in mono with a quiet Copy and the link github.com/login/device under it, then a muted phone icon with “Signing in on your phone”. Only a secondary Cancel.',
    loginCard('hiring', 'Recruiter needs your GitHub', {
      service: 'github',
      title: 'GitHub',
      why: 'Open pull requests for the careers page fixes.',
      abilities: [{ id: 'read', label: 'Read repositories, issues and pull requests' }],
      options: [GH, BROWSER('github.com')],
      flow: {
        state: 'waiting',
        option: 'gh',
        message: 'Type this code at github.com/login/device, on this phone or anywhere.',
        startedAt: now - MIN,
        fromPhone: true,
        onPhone: true,
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://github.com/login/device',
      },
    })
  ),
  recruiterScenario(
    'agents-login-phone-sheet',
    'Agents — Linear signing in on the phone’s sign-in sheet',
    'A “Recruiter needs your Linear” card mid sign-in: spinner and “Linear’s sign-in is open on your phone.”, a muted phone icon with “Signing in on your phone”, only a secondary Cancel. No code box.',
    loginCard('hiring', 'Recruiter needs your Linear', {
      service: 'linear',
      title: 'Linear',
      why: 'File the bugs from the interview feedback.',
      abilities: [{ id: 'read', label: 'Read issues and projects' }],
      options: [
        {
          id: 'oauth',
          method: 'oauth',
          label: 'Connect Linear',
          detail:
            'Opens Linear’s own sign-in in this Mac’s browser. The token stays in this Mac’s Keychain; Recruiter never sees a password, and you can disconnect it any time.',
        },
      ],
      flow: {
        state: 'waiting',
        option: 'oauth',
        message: 'Linear’s sign-in is open on your phone.',
        startedAt: now - MIN,
        fromPhone: true,
        onPhone: true,
      },
    })
  ),
  recruiterScenario(
    'agents-login-failed',
    'Agents — a login that didn’t connect',
    'The card with a red error line “Gmail didn’t show up as connected within ten minutes. Try again once it’s added on claude.ai.”, and the lead button still “Use my browser” (neutral, beside Not now), since claude.ai is what failed; Other ways is open, showing “Connect on claude.ai” where its retry is: “Try again” is only ever on the button that retries the failed way in.',
    loginCard('hiring', 'Recruiter needs your Gmail (work)', {
      ...GMAIL_LOGIN,
      flow: {
        state: 'failed',
        option: 'claude_ai',
        message:
          'Gmail didn’t show up as connected within ten minutes. Try again once it’s added on claude.ai. Choose Use my browser instead: it works where you’re already signed in.',
        startedAt: now - MIN,
      },
    })
  ),
  recruiterScenario(
    'agents-login-connected',
    'Agents — a login card once connected',
    'The card folded to its outcome in the done tone: “Connected · Gmail (work@acme.com)”. No buttons, no field.',
    loginCard('hiring', 'Recruiter needs your Gmail (work)', GMAIL_LOGIN, {
      status: 'allowed',
      choice: 'Connected · Gmail (work@acme.com)',
    }),
    0
  ),
  {
    id: 'agents-login-linkedin',
    title: 'Agents — LinkedIn: no connector, so the browser',
    looksRightWhen:
      'Publicist’s chat: “Publicist needs your LinkedIn”, the reason, read and post lines (posting asks each time), a muted honest line “LinkedIn has no connector agents can sign in to.”, then the browser explanation, and a neutral “Use my browser” beside “Not now”. No password field.',
    requires: '.agent-login',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="social"]' }],
    commands: {
      agents_overview: overview(),
      agents_messages: chatFor('social', [
        loginCard('social', 'Publicist needs your LinkedIn', {
          service: 'linkedin',
          title: 'LinkedIn',
          why: 'Post the weekly update to your LinkedIn.',
          abilities: [
            { id: 'read', label: 'Read your feed, profile and messages' },
            { id: 'write', label: 'Post and send messages — it asks you on a card each time' },
          ],
          options: [BROWSER('www.linkedin.com', 'Publicist')],
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
      'Prospector’s chat: “Prospector needs your Gmail” with the read line, and a muted honest line that Gmail comes through a claude.ai connector, which only agents on Claude Code can use, and Prospector runs on Codex. Only “Not now”; no Connect, no password field.',
    requires: '.agent-login',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'leadgen' ? { ...a, engine: 'codex' as const } : a))
      ),
      agents_messages: chatFor('leadgen', [
        loginCard('leadgen', 'Prospector needs your Gmail', {
          service: 'gmail',
          title: 'Gmail',
          why: 'Find replies from the leads it wrote to.',
          abilities: [{ id: 'read', label: 'Read and search your email' }],
          options: [],
          noConnector:
            'Gmail comes through a claude.ai connector, which only agents on Claude Code can use. Prospector runs on Codex. Using your browser needs Claude Code, and Prospector runs on Codex.',
        }),
      ]),
      ...COMMANDS,
    },
  },
  teamScenario(
    'agents-team-logins',
    'Agents — What your team needs (one row per app)',
    'A dialog “What your team needs”: a lede that connecting signs in on this Mac and no agent sees a password; “0 of 3 connected”. Rows, each a bordered panel: “GitHub — Used by Acme Site, Native App and Client Sites QA” with three ticked agents and a neutral “Use GitHub on this Mac for 3”; “Google · Gmail + Calendar — Used by Recruiter, Prospector and Finance”, Recruiter and Prospector ticked with “Not needed” beside each, Finance muted “Not needed”, the honest Google line, a secondary “Use my browser” and neutral “Connect Google for 2”; “LinkedIn” for Publicist with only “Use my browser”.',
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
      'Editing Recruiter, continuing “What it can reach” (no second heading of its own): “Apps”: “Gmail · work@acme.com — Can read; asks before it sends or changes anything · Connected on claude.ai; the sign-in is held there · used 2 hours ago” and “Linear” with an amber “Needs signing in again” line; “Your browser”: Chrome through Claude in Chrome, for www.linkedin.com, every click asks; “Keys in your Keychain”: one key; each row with a quiet Remove.',
    openSelector: AGENTS_TAB,
    requires: '.agent-reach__section',
    clipSelector: '.agent-editor .agent-reach',
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
