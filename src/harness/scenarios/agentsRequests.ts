/**
 * Requests from many agents at once, seen from the Chief's chat: what an
 * import from Grok leaves behind. Each imported agent asks for its logins on
 * secure cards in its own chat (`secrets::Request::quiet`, `agents/review.rs`),
 * so sixteen agents arrive with 39 cards between them while the Chief is
 * still working. The Chief's chat says so once, in one bar above the
 * composer, and the bar opens every request in one place.
 *
 * Also the small case (two agents: an email to send and a Stripe key), where
 * the bar names them.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, agent, msg, now, overview, status } from './agents';

const COLORS = ['teal', 'blue', 'orange', 'green', 'purple', 'pink', 'amber', 'red', 'gray'];

/** The sixteen agents Grok had, and the logins each asked for on import. */
const IMPORTED: { id: string; name: string; role: string; logins: [string, string][] }[] = [
  {
    id: 'slack-watch',
    name: 'Slack Watch',
    role: 'Watches the team Slack for anything you’re tagged in.',
    logins: [
      ['slack_bot_token', 'Read the channels you’re in and post summaries to you.'],
      ['slack_user_token', 'Search messages that mention you.'],
      ['notion_token', 'File action items into your Notion tasks.'],
      ['linear_api_key', 'Open issues from Slack threads.'],
    ],
  },
  {
    id: 'community',
    name: 'Ship Studio Community',
    role: 'Answers questions in the community Discord.',
    logins: [['discord_bot_token', 'Read and reply in the community Discord.']],
  },
  {
    id: 'client-dev',
    name: 'Client Sites Dev',
    role: 'Builds and maintains client sites.',
    logins: [
      ['github_token', 'Open pull requests on the client repositories.'],
      ['vercel_token', 'Check deployments for each client site.'],
      ['webflow_api_key', 'Read the Webflow sites being migrated.'],
      ['cloudflare_token', 'Update DNS when a site moves.'],
    ],
  },
  {
    id: 'inbox',
    name: 'Inbox Zero',
    role: 'Triages email and drafts replies.',
    logins: [
      ['gmail_app_password', 'Read and label your inbox.'],
      ['outlook_token', 'Read the client Outlook inbox.'],
      ['superhuman_key', 'Snooze and remind in Superhuman.'],
    ],
  },
  {
    id: 'invoices',
    name: 'Invoices',
    role: 'Sends invoices and chases late payments.',
    logins: [
      ['stripe_key', 'Read payouts and send invoices.'],
      ['quickbooks_token', 'Record payments in QuickBooks.'],
      ['bank_login', 'Read the business account’s transactions.'],
    ],
  },
  {
    id: 'calendar',
    name: 'Calendar',
    role: 'Keeps the calendar sane.',
    logins: [
      ['google_calendar_token', 'Read and move events.'],
      ['calendly_key', 'See who booked what.'],
    ],
  },
  {
    id: 'twitter',
    name: 'X Posts',
    role: 'Drafts posts in your voice.',
    logins: [
      ['x_api_key', 'Draft and schedule posts.'],
      ['typefully_key', 'Queue drafts in Typefully.'],
    ],
  },
  {
    id: 'leads',
    name: 'Agency Leads',
    role: 'Finds and qualifies agency leads.',
    logins: [
      ['apollo_key', 'Search for leads.'],
      ['hubspot_token', 'Log leads in HubSpot.'],
      ['gmail_app_password', 'Send the first email.'],
    ],
  },
  {
    id: 'seo',
    name: 'SEO Reports',
    role: 'Weekly SEO report for each client.',
    logins: [
      ['search_console_token', 'Read Search Console for each site.'],
      ['ahrefs_key', 'Check backlinks and rankings.'],
      ['ga4_token', 'Read traffic from Google Analytics.'],
    ],
  },
  {
    id: 'hiring',
    name: 'Hiring Pipeline',
    role: 'Screens candidates and books interviews.',
    logins: [
      ['ashby_key', 'Read applications.'],
      ['google_calendar_token', 'Book interviews.'],
    ],
  },
  {
    id: 'travel',
    name: 'Travel',
    role: 'Books and tracks trips.',
    logins: [['tripit_login', 'Read upcoming trips.']],
  },
  {
    id: 'news',
    name: 'Morning Brief',
    role: 'A brief every weekday at 8.',
    logins: [
      ['feedly_token', 'Read your feeds.'],
      ['readwise_token', 'Pull your highlights.'],
    ],
  },
  {
    id: 'support',
    name: 'Support Desk',
    role: 'First reply on support tickets.',
    logins: [
      ['intercom_token', 'Read and reply to conversations.'],
      ['zendesk_token', 'Read the old ticket archive.'],
      ['stripe_key', 'Look up a customer’s plan.'],
    ],
  },
  {
    id: 'design',
    name: 'Design Review',
    role: 'Reviews Figma files against the design system.',
    logins: [
      ['figma_token', 'Read the Figma files you share.'],
      ['github_token', 'Comment on pull requests with design notes.'],
    ],
  },
  {
    id: 'shopify',
    name: 'Store Ops',
    role: 'Keeps the Shopify store stocked and priced.',
    logins: [
      ['shopify_admin_token', 'Read orders and update stock.'],
      ['klaviyo_key', 'Draft the weekly email.'],
      ['shipstation_key', 'Check shipments.'],
    ],
  },
  {
    id: 'home',
    name: 'Home Admin',
    role: 'Bills, renewals and the household calendar.',
    logins: [['utility_login', 'Read the monthly bill.']],
  },
];

const KIND_OF = (name: string) =>
  name.endsWith('_password') || name.endsWith('_login')
    ? 'password'
    : name.endsWith('_token')
      ? 'token'
      : 'api_key';

/** A login card as `request_secret_quiet` writes it, `minutesAgo` back. */
const loginCard = (agentId: string, name: string, purpose: string, i: number) =>
  msg('approval', '', 9 - i * 0.01, {
    agentId,
    approval: {
      requestId: `login-${agentId}-${name}`,
      title: `Secure input · ${name}`,
      detail: purpose,
      status: 'pending',
      secret: {
        name,
        purpose,
        kind: KIND_OF(name),
        fields: [{ label: 'Value', env: name.toUpperCase() }],
        reference: `secret:${agentId}/${name}`,
        quiet: true,
      },
    },
  });

const IMPORTED_CHATS: Record<string, ReturnType<typeof msg>[]> = Object.fromEntries(
  IMPORTED.map((a) => [
    a.id,
    [
      msg(
        'note',
        'Imported from Grok. It starts when you message it; its routines are paused.',
        10,
        {
          agentId: a.id,
        }
      ),
      ...a.logins.map(([name, purpose], i) => loginCard(a.id, name, purpose, i)),
    ],
  ])
);

export const IMPORTED_REQUESTS = IMPORTED.reduce((n, a) => n + a.logins.length, 0);

/** The Chief two steps into a turn, so its working line sits above the bar. */
const CHIEF_WORK = {
  startedAt: now - MIN,
  stepCount: 2,
  fileCount: 0,
  doing: 'Looking at your projects',
  steps: [
    { at: now - 50_000, kind: 'read', label: 'Read the team list' },
    { at: now - 20_000, kind: 'tool', label: 'Looked at your projects' },
  ],
};

const chief = (working: boolean) => ({
  ...TEAM[0],
  minutesAgo: 1,
  lastActivityAt: now - MIN,
  status: working
    ? { ...status('working', 'Looking at your projects'), work: CHIEF_WORK }
    : status('idle'),
});

const importedTeam = (working: boolean) =>
  overview([
    chief(working),
    ...IMPORTED.map((a, i) =>
      agent(a.id, a.name, {
        role: a.role,
        color: COLORS[i % COLORS.length],
        shape: i % 12,
        minutesAgo: 10,
        pendingApprovals: a.logins.length,
        preview: `Needs your OK: Secure input · ${a.logins[0][0]}`,
      })
    ),
  ]);

const CHIEF_IMPORT_CHAT = [
  msg('note', 'Imported 16 agents from Grok', 10),
  msg(
    'agent',
    'They’re all here. Each one has asked for the logins it used with Grok, on secure cards in its own chat; nothing runs until you message it.',
    9
  ),
  msg('user', 'Great. Which of them should work on the Acme site?', 1),
];

const importedMessages = (args: Record<string, unknown>) => {
  const id = String(args.agentId);
  if (id === 'chief') return CHIEF_IMPORT_CHAT;
  return IMPORTED_CHATS[id] ?? [];
};

/** Two agents waiting: Lead Gen's email and Finance's Stripe key. */
const smallTeam = () =>
  overview(
    TEAM.map((a) =>
      a.id === 'finance'
        ? { ...a, pendingApprovals: 1, status: status('idle') }
        : a.id === 'leadgen'
          ? { ...a, pendingApprovals: 1 }
          : a
    )
  );

const SMALL_CHATS: Record<string, ReturnType<typeof msg>[]> = {
  chief: [
    msg('user', 'Morning. What’s on fire?', 6),
    msg('agent', 'Nothing’s on fire. Lead Gen and Finance are each waiting on one answer.', 5),
  ],
  leadgen: [
    msg('approval', '', 30, {
      agentId: 'leadgen',
      approval: {
        requestId: 'lg-email',
        title: 'Send an email · Gmail',
        detail: 'To: dana@northwind.co',
        status: 'pending',
        tool: 'mcp__gmail__send_email',
        input: {
          to: 'dana@northwind.co',
          subject: 'Quick idea for Northwind’s site',
          body: 'Hi Dana, saw your new pricing page…',
        },
      },
    }),
  ],
  finance: [
    msg('approval', '', 20, {
      agentId: 'finance',
      approval: {
        requestId: 'fin-stripe',
        title: 'Secure input · stripe_key',
        detail: 'Read last month’s payouts from Stripe to reconcile against the bank export.',
        status: 'pending',
        secret: {
          name: 'stripe_key',
          purpose: 'Read last month’s payouts from Stripe to reconcile against the bank export.',
          kind: 'api_key',
          fields: [{ label: 'API key', env: 'STRIPE_KEY' }],
          reference: 'secret:finance/stripe_key',
        },
      },
    }),
  ],
};

const REVIEW_BUTTON = '[data-bar="requests"] .agent-requests__review';

export const agentsRequestsScenarios: Scenario[] = [
  {
    id: 'agents-requests-import',
    title: 'Agents — 16 imported agents asking for 39 logins, from the Chief’s chat',
    looksRightWhen:
      'The Chief’s chat ends on its working line (“Looking at your projects · 2 steps”) and nothing under it: no stack of per-agent chips. Above the composer, one bar with an amber dot: “16 agents need your OK” and “39 logins to add”, with a quiet “Logins by app” (opens What your team needs, one row per app) and a Review button on the right. The bar is one fixed height and stays put when you type.',
    command: 'agents.open',
    requires: '[data-bar="requests"] .agent-bar',
    commands: {
      agents_overview: importedTeam(true),
      agents_messages: importedMessages,
      agents_logins_team: { needs: [], done: 0, total: 0 },
    },
  },
  {
    id: 'agents-requests-import-open',
    title: 'Agents — reviewing every imported agent’s requests in one place',
    looksRightWhen:
      'Opened from the bar: one panel rising from it, the reading column’s width, headed “Needs your OK” with “16 agents · 39 logins”. Agents in name order, all folded so the whole list shows: each a row with its avatar, name and a quiet line (“4 logins: Slack bot token, Slack user token…”), a chevron, and an “Open chat” link. It scrolls inside itself; the composer stays where it was. No focus ring (opened by a click).',
    command: 'agents.open',
    requires: '.agent-requests-panel__toggle',
    steps: [{ click: REVIEW_BUTTON }],
    commands: {
      agents_overview: importedTeam(true),
      agents_messages: importedMessages,
    },
  },
  {
    id: 'agents-requests-import-agent',
    title: 'Agents — one imported agent opened in the review panel',
    looksRightWhen:
      'As agents-requests-import-open with Slack Watch opened (chevron turned): its four secure cards under its row, spanning the text column, each with Deny and a neutral Save. The other agents stay folded below.',
    command: 'agents.open',
    requires: '.agent-requests-panel .agent-secret',
    steps: [
      { click: REVIEW_BUTTON },
      { click: '.agent-requests-panel__toggle', text: 'Slack Watch' },
    ],
    commands: {
      agents_overview: importedTeam(true),
      agents_messages: importedMessages,
    },
  },
  {
    id: 'agents-requests-two',
    title: 'Agents — two agents waiting, from the Chief’s chat',
    looksRightWhen:
      'One bar above the composer naming them: “Finance and Lead Gen need your OK” with “2 requests, 1 of them a login”, and Review. No chips at the foot of the chat.',
    openSelector: AGENTS_TAB,
    requires: '[data-bar="requests"] .agent-bar',
    commands: {
      agents_overview: smallTeam(),
      agents_messages: (args: Record<string, unknown>) => SMALL_CHATS[String(args.agentId)] ?? [],
    },
  },
  {
    id: 'agents-requests-two-open',
    title: 'Agents — two agents’ requests opened from the bar',
    looksRightWhen:
      'The panel lists Finance (“1 login: stripe_key”) and Lead Gen (“Send an email · Gmail”), both expanded since there are only two: the secure card and the Allow / Deny card with the email, answerable in place.',
    openSelector: AGENTS_TAB,
    requires: '.agent-requests-panel .agent-approval',
    steps: [{ click: REVIEW_BUTTON }],
    commands: {
      agents_overview: smallTeam(),
      agents_messages: (args: Record<string, unknown>) => SMALL_CHATS[String(args.agentId)] ?? [],
    },
  },
];
