/**
 * Agents bound to a project, the Chief's audit trail, and live state on
 * delegation lines. Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, msg, messagesFor, now, overview, status } from './agents';
import { workspaceCommands } from './workspace';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;

/** Acme Site works in acme-marketing; everyone else as in the team fixture. */
const boundTeam = (over: Record<string, Record<string, unknown>> = {}) =>
  TEAM.map((a) => ({
    ...a,
    ...(a.id === 'acme' ? { project: ACME_PATH, status: status('idle') } : {}),
    ...over[a.id],
  }));

const changes = (minutesAgo: number, files: Record<string, unknown>[], extra = {}) =>
  msg('changes', `Changed ${files.length} files in acme-marketing`, minutesAgo, {
    agentId: 'acme',
    changes: {
      project: ACME_PATH,
      branch: 'feat/pricing-page',
      from: 'a1b2c3',
      to: 'd4e5f6',
      files,
      fileCount: files.length,
      added: files.reduce((n, f) => n + Number(f.added ?? 0), 0),
      removed: files.reduce((n, f) => n + Number(f.removed ?? 0), 0),
      ...extra,
    },
  });

const ACME_BOUND_CHAT = [
  msg('note', 'Created by Chief of Staff', 300, {
    agentId: 'acme',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('note', 'Instructions updated by Chief of Staff', 120, {
    agentId: 'acme',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('user', 'The pricing cards overlap on mobile. Can you fix it?', 30, { agentId: 'acme' }),
  msg(
    'agent',
    'Fixed. The cards now stack below 640px and the “Most popular” badge no longer covers the price. I also removed the old pricing grid helper nothing used.',
    24,
    { agentId: 'acme' }
  ),
  changes(24, [
    { path: 'src/components/PricingTable.tsx', status: 'modified', added: 38, removed: 12 },
    { path: 'src/styles/pricing.css', status: 'modified', added: 21, removed: 4 },
    { path: 'src/components/PricingCard.tsx', status: 'added', added: 64 },
    { path: 'src/lib/pricingGrid.ts', status: 'deleted', added: 0, removed: 41 },
    { path: 'public/badges/popular.svg', status: 'modified' },
  ]),
  msg('user', 'And the footer year is still 2024.', 6, { agentId: 'acme' }),
  msg('agent', 'Updated to 2026.', 5, { agentId: 'acme' }),
  changes(5, [{ path: 'src/components/Footer.tsx', status: 'modified', added: 1, removed: 1 }]),
];

/* ------------------------------------------- a copy of the project per task */

const COPY = {
  id: 'copy_pricing',
  path: `${HARNESS_ROOT}/.worktrees/acme-marketing/acme-site-pricing-cards-9f2c`,
  branch: 'acme-site/pricing-cards-9f2c',
};

/** Acme Site with its own open copy of acme-marketing. */
export const copyTeam = (state: 'idle' | 'working' = 'idle') =>
  boundTeam({
    acme: {
      copy: {
        ...COPY,
        project: ACME_PATH,
        base: 'a1b2c3',
        baseBranch: 'main',
        createdAt: now - 30 * MIN,
        deps: true,
      },
      status:
        state === 'working'
          ? { state: 'working', activity: 'Editing Footer.tsx', since: now - 0.5 * MIN }
          : status('idle'),
    },
  });

const copyCard = (
  minutesAgo: number,
  files: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
) =>
  msg('changes', `Changed ${files.length} files in a copy of acme-marketing`, minutesAgo, {
    agentId: 'acme',
    changes: {
      ...extra,
      project: ACME_PATH,
      from: 'base-tree',
      to: 'copy-tree',
      files,
      fileCount: files.length,
      added: files.reduce((n, f) => n + Number(f.added ?? 0), 0),
      removed: files.reduce((n, f) => n + Number(f.removed ?? 0), 0),
      copy: COPY,
    },
  });

const PRICING_FILES = [
  { path: 'src/components/PricingTable.tsx', status: 'modified', added: 38, removed: 12 },
  { path: 'src/styles/pricing.css', status: 'modified', added: 21, removed: 4 },
  { path: 'src/components/PricingCard.tsx', status: 'added', added: 64 },
];

export const ACME_COPY_CHAT = [
  msg('user', 'The pricing cards overlap on mobile. Can you fix it?', 30, { agentId: 'acme' }),
  msg(
    'agent',
    'Fixed. The cards now stack below 640px and the “Most popular” badge no longer covers the price.',
    24,
    {
      agentId: 'acme',
      work: {
        startedAt: now - 29 * MIN,
        endedAt: now - 24 * MIN,
        stepCount: 4,
        fileCount: 3,
        files: ['PricingTable.tsx', 'pricing.css', 'PricingCard.tsx'],
        steps: [
          { at: now - 29 * MIN, kind: 'project', label: 'Started a copy of acme-marketing' },
          { at: now - 28 * MIN, kind: 'read', label: 'Read PricingTable.tsx' },
          { at: now - 26 * MIN, kind: 'edit', label: 'Edited PricingTable.tsx' },
          { at: now - 25 * MIN, kind: 'command', label: 'Ran pnpm build' },
        ],
      },
    }
  ),
  copyCard(24, PRICING_FILES.slice(0, 2)),
  msg('user', 'Make the badge a pill too.', 8, { agentId: 'acme' }),
  msg('agent', 'Done: the badge is a pill, and the card gained its own component.', 6, {
    agentId: 'acme',
  }),
  copyCard(6, PRICING_FILES),
];

/** The newest card with what Keep won't bring over, and why it couldn't save. */
const ACME_COPY_LEFT_OUT_CHAT = [
  ...ACME_COPY_CHAT.slice(0, -1),
  copyCard(6, PRICING_FILES, {
    leftOut: [
      { path: '.env.local', why: 'secrets' },
      { path: 'public/hero.mov', why: 'tooLarge' },
      { path: '.env', why: 'ignored' },
    ],
  }),
];

const ACME_COPY_OFF_BRANCH_CHAT = [
  ...ACME_COPY_CHAT.slice(0, -1),
  copyCard(6, PRICING_FILES, {
    warning: 'The copy isn’t on its own branch any more — open it to check.',
  }),
];

const CHANGE_DIFF = {
  filePath: 'src/components/Footer.tsx',
  isNewFile: false,
  isDeleted: false,
  isBinary: false,
  additions: 1,
  deletions: 1,
  content: [
    'diff --git a/src/components/Footer.tsx b/src/components/Footer.tsx',
    'index 3f2a1c4..9b8d7e2 100644',
    '--- a/src/components/Footer.tsx',
    '+++ b/src/components/Footer.tsx',
    '@@ -12,7 +12,7 @@ export function Footer() {',
    '       <nav className="footer__links">{links}</nav>',
    '       <p className="footer__legal">',
    '-        © 2024 Acme Inc. All rights reserved.',
    '+        © 2026 Acme Inc. All rights reserved.',
    '       </p>',
    '     </footer>',
    '   );',
  ].join('\n'),
};

const peer = (id: string, name: string) => ({ peer: { id, name } });

/** The Chief's chat after building a team and handing out work. */
const CHIEF_AUDIT_CHAT = [
  msg('user', 'Set up an agent for the books, and one for the Acme site.', 200),
  msg(
    'note',
    'Created Finance · Invoices, expenses and the books.',
    199,
    peer('finance', 'Finance')
  ),
  msg(
    'note',
    'Created Acme Site · Owns the Acme marketing site · works in acme-marketing',
    199,
    peer('acme', 'Acme Site')
  ),
  msg('agent', 'Done. Finance and Acme Site are set up and briefed.', 198),
  msg(
    'user',
    'Social Posts isn’t pulling its weight. Remove it, and chase the overdue invoices.',
    30
  ),
  msg('note', 'Deleted Social Posts', 29),
  msg(
    'sent_to_agent',
    'Northwind ($4,200) and Globex ($1,150) are overdue. Draft a firmer reminder for each and send them once you have the OK.',
    28,
    peer('finance', 'Finance')
  ),
  msg('note', 'Updated Acme Site’s instructions', 20, peer('acme', 'Acme Site')),
  msg(
    'sent_to_agent',
    'Check every footer link on staging and fix what’s broken.',
    19,
    peer('acme', 'Acme Site')
  ),
  msg(
    'sent_to_agent',
    'Find five agencies in Lisbon worth an intro.',
    15,
    peer('leadgen', 'Lead Gen')
  ),
  msg(
    'agent',
    'Finance is drafting the reminders, Acme Site is on the footer links, and Lead Gen is looking for Lisbon agencies.',
    14
  ),
];

/** Finance, working on the brief the Chief just sent. */
const FINANCE_DRIVEN_CHAT = [
  msg('note', 'Created by Chief of Staff', 199, {
    agentId: 'finance',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('user', 'What’s outstanding this month?', 60, { agentId: 'finance' }),
  msg('agent', 'Two invoices are overdue: Northwind ($4,200) and Globex ($1,150).', 59, {
    agentId: 'finance',
  }),
  msg(
    'from_agent',
    'Northwind ($4,200) and Globex ($1,150) are overdue. Draft a firmer reminder for each and send them once you have the OK.',
    1,
    { agentId: 'finance', ...peer('chief', 'Chief of Staff') }
  ),
];

const LEADGEN_FAILED_CHAT = [
  msg('from_agent', 'Find five agencies in Lisbon worth an intro.', 15, {
    agentId: 'leadgen',
    ...peer('chief', 'Chief of Staff'),
  }),
  msg(
    'error',
    'Claude Code is out of usage until 3:00 PM, so AI generation isn’t available right now.',
    14,
    { agentId: 'leadgen' }
  ),
];

const auditTeam = () =>
  overview(
    boundTeam({
      finance: { status: status('waiting', 'Waiting for your OK'), pendingApprovals: 1 },
      acme: { status: status('working', 'Reading src/components/Footer.tsx') },
      leadgen: { status: status('idle'), lastActivityAt: now - 14 * MIN },
    }).filter((a) => a.id !== 'social')
  );

/** The Chief working on acme-marketing through its session, then asking to push. */
const session = (event: string, extra: Record<string, unknown> = {}) => ({
  agentId: 'chief',
  session: {
    project: ACME_PATH,
    event,
    ...(event === 'screenshot' ? {} : { sessionId: 'pty-acme-1', tab: 1, cli: 'claude' }),
    ...extra,
  },
});
const CHIEF_SESSION_CHAT = [
  msg('user', 'On the Acme site, make the hero headline bigger and show me.', 14),
  msg('agent', 'On it.', 14),
  msg('session', 'Make the hero headline bigger on the home page.', 14, session('started')),
  msg(
    'session',
    'Bumped the hero headline from 48px to 64px (40px on phones) and tightened its line height so it still fits on two lines at 1280px. Only src/components/Hero.tsx changed.',
    12,
    session('reply')
  ),
  msg('session', 'desktop', 12, {
    ...session('screenshot'),
    attachments: [
      {
        name: 'acme-marketing-desktop.jpg',
        path: 'attachments/m-att1/Hero crop.jpg',
        mime: 'image/jpeg',
        size: 27_238,
      },
    ],
  }),
  msg(
    'agent',
    'Done: the headline is 64px now (40px on phones) and still two lines. Screenshot above. Want it pushed?',
    12
  ),
  msg('user', 'Also make the subheading grey. Then push.', 4),
  msg('session', 'Make the hero subheading text grey (the muted text colour).', 4, session('sent')),
  msg(
    'session',
    'The subheading now uses the muted text colour. Committed nothing yet; Hero.tsx has the change.',
    3,
    session('reply')
  ),
  msg('approval', '', 2, {
    approval: {
      requestId: 'req-push',
      title: 'Publish acme-marketing',
      summary:
        'Publishes 1 change to acme/marketing: “Bigger hero headline”. Saves the unsaved edit to Hero.tsx first.',
      detail:
        'Branch feat/pricing-page → origin (https://github.com/acme/marketing.git)\n\nCommits:\n9f3c2e1 Bigger hero headline\n\nCommitted first:\n M src/components/Hero.tsx',
      status: 'pending',
    },
  }),
];

const CAPABILITIES = {
  seenAt: now - 5 * MIN,
  lines: [
    {
      what: 'Projects',
      detail:
        'Create projects, work in them, screenshot their previews, publish with your OK, and check whether it went live.',
    },
    { what: 'The team', detail: 'Create, brief, message and manage the other agents.' },
    {
      what: 'Chrome',
      detail: 'Browse in your Chrome: open pages, click, fill in forms and read what’s showing.',
    },
    {
      what: 'On this Mac',
      detail:
        'Run commands, read and edit files, use the web, send you files and schedule routines.',
    },
    { what: 'Connectors', detail: 'Gmail, Google Calendar, Sanity and Figma' },
    {
      what: 'Needs sign-in',
      detail: 'Webflow and Google Drive. Connect them in Claude Code to use them here.',
    },
  ],
};

const openAcme = {
  openSelector: AGENTS_TAB,
  steps: [{ click: '[data-agent-id="acme"]' }],
};

/**
 * The walkthrough that found it: the user asks the Chief, the Chief hands it
 * to Acme Site, Acme Site's new session in demo-site stops on Claude Code's
 * folder-trust dialog. The card is in both chats.
 */
const DEMO_PATH = `${HARNESS_ROOT}/demo-site`;
const trustCard = (agentId: string, statusOver: Record<string, unknown> = {}) =>
  msg('approval', '', 1, {
    agentId,
    approval: {
      requestId: 'req-trust-demo',
      title: 'Let Claude Code work in demo-site?',
      detail:
        'Claude Code asks once per folder before it reads, edits and runs files in it. Allow, and demo-site stays trusted, the way Claude Code records it when you accept its own dialog.',
      status: 'pending',
      prompt: {
        kind: 'trust',
        project: DEMO_PATH,
        sessionId: 'pty-demo-1',
        tab: 1,
        question: 'Quick safety check: Is this a project you created or one you trust?',
        options: [
          { label: 'No, exit', keys: ['enter'], role: 'deny' },
          { label: 'Yes, I trust this folder', keys: ['down', 'enter'], role: 'allow' },
        ],
        owner: { id: 'acme', name: 'Acme Site' },
        chats: ['acme', 'chief'],
      },
      ...statusOver,
    },
  });
const CHIEF_DELEGATED_PROMPT = [
  msg('user', 'Have Acme Site change the demo-site heading to “Bake better bread”.', 3),
  msg('agent', 'Handed to Acme Site.', 3),
  msg('sent_to_agent', 'Change the main heading in demo-site to “Bake better bread”.', 3, {
    peer: { id: 'acme', name: 'Acme Site' },
  }),
  trustCard('chief'),
  msg(
    'from_agent',
    'demo-site is waiting for Claude Code to be allowed in the folder. It needs your OK first.',
    1,
    { peer: { id: 'acme', name: 'Acme Site' } }
  ),
];
const ACME_PROMPTS = [
  msg('from_agent', 'Change the main heading in demo-site to “Bake better bread”.', 3, {
    agentId: 'acme',
    peer: { id: 'chief', name: 'Chief of Staff' },
  }),
  msg('session', 'Change the main heading in demo-site to “Bake better bread”.', 2, {
    agentId: 'acme',
    session: {
      project: DEMO_PATH,
      event: 'started',
      sessionId: 'pty-demo-1',
      tab: 1,
      cli: 'claude',
    },
  }),
  trustCard('acme', { status: 'allowed', choice: 'Yes, I trust this folder' }),
  msg('approval', '', 0.5, {
    agentId: 'acme',
    approval: {
      requestId: 'req-edit-demo',
      title: 'Edit index.html?',
      detail: 'Edit index.html',
      status: 'pending',
      prompt: {
        kind: 'permission',
        project: DEMO_PATH,
        sessionId: 'pty-demo-1',
        tab: 1,
        question: 'Do you want to make this edit to index.html?',
        options: [
          { label: 'Yes', keys: ['1'], role: 'allow' },
          // As decisions.rs words them: no key hints, no "session".
          {
            label: 'Allow all edits until Claude Code is closed',
            keys: ['2'],
            role: 'other',
          },
          { label: 'No, and say what to do instead', keys: ['3'], role: 'deny' },
        ],
        owner: { id: 'acme', name: 'Acme Site' },
        chats: ['acme'],
      },
    },
  }),
];
const promptTeam = () =>
  overview(
    TEAM.map((a) =>
      a.id === 'chief' || a.id === 'acme'
        ? {
            ...a,
            status: a.id === 'acme' ? status('waiting', 'Waiting for your OK') : status('idle'),
            pendingApprovals: 1,
          }
        : a
    )
  );

export const agentsProjectScenarios: Scenario[] = [
  {
    id: 'agents-session-prompt-chief',
    title: 'Agents — a delegated session’s question, answerable in the Chief’s chat',
    looksRightWhen:
      'The Chief’s chat: the user’s ask, “Handed to Acme Site.”, the hand-off line. Acme Site’s question is not a second full card in the conversation: above the composer, the one bar every other agent’s request uses (“Acme Site needs your OK”), its Review panel open, showing the same card in place — a folder icon, “Let Claude Code work in demo-site?”, the muted source “Acme Site · in demo-site” (no tab number, no engine name), the explanation, then Deny / a neutral Allow on the right. Both Chief and Acme Site rows say they need your OK.',
    command: 'agents.open',
    requires: '.agent-requests-panel .agent-approval[data-prompt="trust"]',
    steps: [{ click: '.agent-requests__review' }],
    commands: {
      agents_overview: promptTeam(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief'
          ? CHIEF_DELEGATED_PROMPT
          : args.agentId === 'acme'
            ? [...ACME_PROMPTS.slice(0, 2), trustCard('acme')]
            : messagesFor(args),
      agents_answer_approval: null,
    },
  },
  {
    id: 'agents-session-prompt-owner',
    title: 'Agents — the session’s own chat: trust answered, an edit to allow',
    looksRightWhen:
      'Acme Site’s chat: the Chief’s brief, “Started work in demo-site”, the trust card collapsed to one quiet line “Let Claude Code work in demo-site? · Allowed · Yes, I trust this folder” with a “Show request” link, then a pending card “Edit index.html?” with the muted source “Acme Site · in demo-site”, “Edit index.html” as a plain sentence (not code), and the extra choice “Allow all edits until Claude Code is closed” beside Deny / Allow. No key hints, no “session”.',
    requires: '.agent-approval[data-prompt="permission"]',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    commands: {
      agents_overview: promptTeam(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_PROMPTS : messagesFor(args),
      agents_answer_approval: null,
    },
  },
  {
    id: 'agents-project-bound',
    title: 'Agents — an agent that works in a project, with change cards',
    looksRightWhen:
      'Acme Site’s header has a quiet folder chip “acme-marketing” beside the name. Its chat opens with quiet centred notes “Created by Chief of Staff” and “Instructions updated by Chief of Staff” (the name a link). After each reply sits a compact card on the left: “Changed 5 files in acme-marketing” (no branch, no line counts), then “Open preview” first and “See changes”. No deploy or hosting status anywhere.',
    requires: '.agent-changes',
    ...openAcme,
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-ready',
    title: 'Agents — work done on a copy of the project, ready to keep',
    looksRightWhen:
      'Acme Site’s header chip reads “acme-marketing · copy” (“· copy” muted, inside the one chip). The earlier card is a one-line record: folder icon, “Changed 2 files in a copy of acme-marketing”, “Review changes” on the right, no preview. The newest card: folder icon, “Changes are ready” with “3 files” on the right, the muted line “On a copy of acme-marketing · acme-marketing itself is unchanged”, then, right-aligned: ⋯ (Open a pull request) on the far left, Discard, Preview (globe), a secondary Review changes and a neutral Keep changes last. No branch names, no “merge”, no “worktree” anywhere.',
    requires: '.agent-changes[data-copy="live"]',
    ...openAcme,
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-timeline',
    title: 'Agents — the timeline says it started a copy',
    looksRightWhen:
      'The first reply’s “Worked 5 min · 4 steps · edited 3 files” line is open: the first step is “Started a copy of acme-marketing” at 0:00, then Read PricingTable.tsx, Edited PricingTable.tsx, Ran pnpm build.',
    requires: '.agent-work__steps',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-work__toggle' }],
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-working',
    title: 'Agents — Keep waits while the agent is still working on its copy',
    looksRightWhen:
      'Acme Site is working (“Editing Footer.tsx”). The newest card reads “Changes so far”, its quiet line “Acme Site is working on a copy of acme-marketing”; Keep changes and Discard are disabled; Review and Preview still work.',
    requires: '.agent-changes[data-copy="live"] button[disabled]',
    ...openAcme,
    commands: {
      agents_overview: overview(copyTeam('working')),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-discard',
    title: 'Agents — Discard asks first',
    looksRightWhen:
      'The newest card’s actions are replaced by “Discard these changes? The copy and everything in it go; acme-marketing stays as it is.” and a red Discard button beside Cancel.',
    requires: '.agent-copy[data-state="confirm"]',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-copy__actions button', text: 'Discard' },
    ],
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-conflict',
    title: 'Agents — Keep found an overlap with the project',
    looksRightWhen:
      'After Keep changes, the newest card says “Some of these changes overlap with edits made in acme-marketing since: src/styles/pricing.css (mono). Choose which to keep in the copy, or ask Acme Site to sort it out.”, then a primary “Open the copy”, “Ask Acme Site” and “Not now”. The project itself is untouched (nothing else changes).',
    requires: '.agent-copy[data-state="conflict"]',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-copy__actions button', text: 'Keep changes' },
    ],
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
      agents_copy_keep: { outcome: 'conflict', files: ['src/styles/pricing.css'] },
    },
  },
  {
    id: 'agents-copy-other-branch',
    title: 'Agents — Keep asks before keeping into a different branch',
    looksRightWhen:
      'After Keep changes, the newest card says “acme-marketing has moved on to another version since these changes were started. Keeping them there also brings along anything from the version they started from that it doesn’t have yet.” — no branch names — with Cancel and a neutral “Keep there too” on the right.',
    requires: '.agent-copy[data-state="other-branch"]',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-copy__actions button', text: 'Keep changes' },
    ],
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
      agents_copy_keep: { outcome: 'otherBranch', current: 'feature/pricing', base: 'main' },
    },
  },
  {
    id: 'agents-copy-markers',
    title: 'Agents — Keep refuses while a file still has conflict markers',
    looksRightWhen:
      'After Keep changes, the newest card says “Some files still have conflict markers in them: src/styles/pricing.css (mono). Nothing was kept. Finish choosing in the copy, or ask Acme Site to.”, then a primary “Open the copy”, “Ask Acme Site” and “Not now”.',
    requires: '.agent-copy[data-state="markers"]',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-copy__actions button', text: 'Keep changes' },
    ],
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
      agents_copy_keep: { outcome: 'markers', files: ['src/styles/pricing.css'] },
    },
  },
  {
    id: 'agents-copy-left-out',
    title: 'Agents — the card says what Keep won’t bring over',
    looksRightWhen:
      'The newest card (“Changes are ready”) has a quiet line under the counts: “Not included: .env.local (looks like secrets), public/hero.mov (over 5 MB) · changed .env — not included (git ignores it)”, then the usual copy line and Keep changes / Review / Preview / Discard.',
    requires: '.agent-copy__left-out',
    ...openAcme,
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_LEFT_OUT_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-copy-off-branch',
    title: 'Agents — the copy was moved off its own branch',
    looksRightWhen:
      'The newest card shows an amber line “The copy isn’t on its own branch any more — open it to check.” above the copy line and the Keep / Discard actions.',
    requires: '.agent-copy__warning',
    ...openAcme,
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_OFF_BRANCH_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-project-files',
    title: 'Agents — a change card’s files listed',
    looksRightWhen:
      'The five-file card is expanded: one row per file by its name only (the full path on hover), with green +n and red −n on the right; the deleted file is struck through; the SVG has no counts and no “binary”. Above the files, +124 −58 and no branch name. The toggle reads “Hide changes”, after “Open preview”.',
    requires: '.agent-changes__files',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }, { click: '.agent-changes__toggle-files' }],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT.slice(0, 5) : messagesFor(args),
    },
  },
  {
    id: 'agents-project-diff',
    title: 'Agents — See changes on a one-file change opens its diff',
    looksRightWhen:
      'The app’s own diff modal, titled src/components/ Footer.tsx · Modified, focus on the diff (not Close): +1 −1, then the hunk “export function Footer() {” and old/new line numbers 12–18, one − before 2024 in red and one + before 2026 in green. No diff --git / index / --- / +++ lines.',
    requires: '.diff-modal-content .diff-line-add',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-changes .agent-changes__toggle-files' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme'
          ? ACME_BOUND_CHAT.filter((m) => !m.text.startsWith('Changed 5'))
          : messagesFor(args),
      agents_change_diff: CHANGE_DIFF,
    },
  },
  {
    id: 'agents-project-diff-files',
    title: 'Agents — a five-file change’s diff, stepped to the second file',
    looksRightWhen:
      'The diff modal for the five-file card, moved on once with Next: the title reads src/styles/ pricing.css · Modified, the bar under it reads +1 −1 on the left and “2 of 5” with Previous and Next arrows on the right, both enabled.',
    requires: '.diff-nav',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-changes .agent-changes__toggle-files' },
      { click: '.agent-changes .agent-changes__file' },
      { click: '.diff-nav [aria-label="Next file"]' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT.slice(0, 5) : messagesFor(args),
      agents_change_diff: (args: Record<string, unknown>) => ({
        ...CHANGE_DIFF,
        filePath: String(args.path),
      }),
    },
  },
  {
    id: 'agents-project-editor',
    title: 'Agents — choosing the project an agent works in',
    looksRightWhen:
      'Editing Acme Site: under Model, “Works in” with a menu button reading acme-marketing; the menu is open listing No project, a divider, then acme-marketing (checked), portfolio-site and docs-astro. The hint under it says it works on its own copy of the project and follows the project’s own instructions and settings (no “CLAUDE.md”), and the user’s folder stays as they left it; below it an unchecked “Work directly in the project”.',
    requires: '.agent-project-menu',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-editor__more' },
      { click: '.agent-editor__project' },
    ],
    commands: {
      agents_overview: overview(boundTeam()),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_BOUND_CHAT : messagesFor(args),
      agents_instructions: 'Owns the Acme marketing site.',
      agents_usage: null,
    },
  },
  {
    id: 'agents-chief-audit',
    title: 'Agents — what the Chief did, and how its delegations are going',
    looksRightWhen:
      'The Chief’s chat: quiet centred notes “Created Finance · …”, “Created Acme Site · … · works in acme-marketing”, “Deleted Social Posts” (no link) and “Updated Acme Site’s instructions”, each agent name a link. The newest line with each agent carries its live state after a dot: Finance amber “needs your OK”, Acme Site the pixel loader and “reading src/components/Footer.tsx”, Lead Gen red “didn’t finish”. Older lines with the same agent carry none.',
    command: 'agents.open',
    requires: '.agent-peer__state[data-state="failed"]',
    commands: {
      agents_overview: auditTeam(),
      agents_messages: (args: Record<string, unknown>) => {
        if (args.agentId === 'chief') return CHIEF_AUDIT_CHAT;
        if (args.agentId === 'leadgen') return LEADGEN_FAILED_CHAT;
        return messagesFor(args);
      },
    },
  },
  {
    id: 'agents-brief-in-progress',
    title: 'Agents — the brief an agent is working on, open',
    looksRightWhen:
      'Finance is Working. Its chat ends with “Message from Chief of Staff” (no live state: that is work coming in) already expanded, showing the brief about Northwind and Globex, then the working dots. The first line is a quiet “Created by Chief of Staff” with the name as a link.',
    requires: '.agent-peer__thread',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(
        boundTeam({
          finance: {
            status: {
              state: 'working',
              activity: 'Drafting the reminders',
              since: now - 0.5 * MIN,
            },
          },
        })
      ),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance' ? FINANCE_DRIVEN_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-project-sessions',
    title: 'Agents — the Chief working on a project through its session',
    looksRightWhen:
      'The Chief’s chat: a quiet left-aligned line with a terminal icon “Started work in acme-marketing” and “Open in acme-marketing”; a card titled “acme-marketing” with the reply as plain text and “Open in acme-marketing” right-aligned; a card “acme-marketing · desktop” with the screenshot inline and “Open preview”; the Chief’s own short reply; later “Sent to acme-marketing”, its reply card, and a pending card “Publish acme-marketing” whose body is one plain sentence (“Publishes 1 change to acme/marketing: “Bigger hero headline”. Saves the unsaved edit to Hero.tsx first.”) with a quiet “Details” that reveals the branch, remote and commit, then Deny / Allow and no “Always allow”.',
    command: 'agents.open',
    requires: '.agent-session-card img',
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? CHIEF_SESSION_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-project-push-details',
    title: 'Agents — the publish card, with its details open',
    looksRightWhen:
      'Clipped to the card “Publish acme-marketing”: one plain sentence (“Publishes 1 change to acme/marketing: “Bigger hero headline”. Saves the unsaved edit to Hero.tsx first.”), “Hide details” and, under it, the raw lines (branch → origin, the commit, the file committed first) in the monospace detail box; Deny / Allow, Allow neutral.',
    command: 'agents.open',
    requires: '.agent-approval .agent-approval__detail',
    clipSelector: '.agent-approval',
    steps: [{ click: '.agent-approval .agent-approval__show-all' }],
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? CHIEF_SESSION_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-project-session-shot',
    title: 'Agents — a session’s reply and its screenshot',
    looksRightWhen:
      'The first half of the Chief’s session work: “Started work in acme-marketing” with “Open in acme-marketing”, the reply card, then a card “acme-marketing · desktop” with the screenshot as an inline thumbnail and “Open preview”, then the Chief’s two-sentence reply.',
    command: 'agents.open',
    requires: '.agent-session-card img',
    commands: {
      agents_overview: overview(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? CHIEF_SESSION_CHAT.slice(0, 6) : messagesFor(args),
    },
  },
  {
    id: 'agents-capabilities',
    title: 'Agents — what an agent can do, in its editor',
    looksRightWhen:
      'Editing the Chief of Staff: a quiet “What Chief of Staff can do” group, label column on the left (Projects, The team, Chrome, On this Mac, Connectors, Needs sign-in) and plain sentences on the right, above Permissions. No computer use is claimed.',
    openSelector: AGENTS_TAB,
    requires: '.agent-editor__can-do',
    steps: [
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
    ],
    commands: {
      agents_overview: overview(
        TEAM.map((a) => (a.id === 'chief' ? { ...a, capabilities: CAPABILITIES } : a))
      ),
      agents_messages: messagesFor,
      agents_instructions: 'Keep the team moving.',
      agents_usage: null,
    },
  },
  {
    id: 'agents-waiting-for-slot',
    title: 'Agents — a turn queued behind the cap on concurrent turns',
    looksRightWhen:
      'Finance’s sidebar row reads the queued state (not “Working”), and its chat ends with the dots and “Waiting for a free slot (3 agents already working)”. The header shows only its name and role. Nothing shows a timer.',
    requires: '.agent-chat__row--working',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    commands: {
      agents_overview: overview(
        boundTeam({
          finance: {
            status: {
              state: 'working',
              activity: 'Waiting for a free slot (3 agents already working)',
              since: null,
            },
          },
        })
      ),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'finance' ? FINANCE_DRIVEN_CHAT : messagesFor(args),
    },
  },
  {
    id: 'workspace-project-agents',
    title: 'Workspace — the agents that work in this project, above its sessions',
    looksRightWhen:
      'In the acme-marketing project’s sidebar body: an “Agents” section listing Acme Site (the agent bound to this folder, idle, so nothing at its right), then “Sessions” (the terminal tabs, formerly headed Agents) with “New session ⌘T” at its foot. Clicking Acme Site opens its chat in Agents.',
    project: ACME_PATH,
    requires: '#sidebar-section-team',
    clipSelector: '.workspace-sidebar',
    commands: {
      ...workspaceCommands,
      agents_overview: overview(boundTeam()),
      agents_with_projects: boundTeam().filter((a) => a.project),
      agents_messages: messagesFor,
    },
  },
];
