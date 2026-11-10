/**
 * Usage: the sidebar's one-glance row and the full Usage view, across the
 * states that matter: one account, three, one out, every account nearly
 * empty, a reset soon with lots left, accounts nobody has read, and a second
 * sign-in of the same account (the owner's two "juliangalluzzois@…" lines).
 * Built on the Agents team fixture (`./agents`); every name and address is
 * fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, now, overview } from './agents';

const H = 3_600_000;
const M = 60_000;

type Acc = Record<string, unknown>;

const account = (id: string, name: string, over: Acc = {}): Acc => ({
  id,
  engine: 'claude',
  name,
  named: id !== 'default',
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  ...over,
});

const win = (kind: string, used: number, resetsIn: number, over: Acc = {}) => ({
  kind,
  usedPercent: used,
  resetsAt: now + resetsIn,
  limited: used >= 100,
  observedAt: now - 6 * M,
  ...over,
});

const line = (id: string, name: string, windows: unknown[], over: Acc = {}): Acc => ({
  engine: 'claude',
  id,
  name,
  thisMac: id === 'default',
  signedIn: true,
  out: false,
  next: id === 'default',
  windows,
  learned: [],
  ...over,
});

const engines = (agents: number) => [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
    agents,
    allOut: false,
  },
  { id: 'codex', label: 'Codex', installed: true, signedIn: false, agents: 0, allOut: false },
];

const inventory = (accounts: Acc[], over: Acc = {}) => ({
  mode: 'normal',
  engines: engines(TEAM.length),
  accounts,
  local: [],
  spare: [],
  backlog: [],
  agents: TEAM.map((a) => ({ id: a.id, name: a.name, engine: 'claude', isMain: a.id === 'chief' })),
  routines: [],
  totals: {
    accounts: accounts.length,
    engines: [],
    read: accounts.length,
    room: accounts.length,
    windows: [],
  },
  now,
  ...over,
});

const spent = [
  { agentId: 'chief', name: 'Chief of Staff', turns: 23, tokens: 4_800_000 },
  { agentId: 'finance', name: 'Finance', turns: 9, tokens: 1_350_000 },
  { agentId: 'leadgen', name: 'Lead Gen', turns: 4, tokens: 410_000 },
];

const changes = [
  {
    kind: 'seven_day',
    from: 32,
    to: 47,
    since: now - 13 * H,
    until: now - 5 * H,
    runs: [],
    nothingHere: true,
  },
  {
    kind: 'seven_day',
    from: 21,
    to: 32,
    since: now - 30 * H,
    until: now - 26 * H,
    runs: [
      { agentId: 'finance', name: 'Finance', routine: 'Monday numbers', turns: 3, tokens: 900_000 },
      { agentId: 'chief', name: 'Chief of Staff', turns: 6, tokens: 640_000 },
    ],
    nothingHere: false,
  },
];

const codexMac = {
  id: 'default',
  engine: 'codex',
  name: 'Signed in on this Mac',
  named: false,
  thisMac: true,
  signedIn: false,
  out: false,
};

function commands(
  accounts: Acc[],
  inv: Acc,
  crossover: Acc = { claude: 'ask', codex: 'ask', away: [] }
) {
  return {
    agents_overview: overview(TEAM),
    agents_messages: messagesFor,
    agents_accounts: accounts,
    agents_usage_overview: inv,
    agents_account_use: accounts,
    agents_account_reorder: accounts,
    agents_account_rename: null,
    agents_account_remove: null,
    agents_account_add: null,
    agents_set_usage_mode: null,
    agents_spare_spend_now: 'Chief of Staff is starting your spare-capacity list (2 waiting).',
    agents_spare_add: null,
    agents_spare_remove: null,
    agents_crossover: crossover,
    agents_set_crossover: crossover,
    agents_usage_sign_in_seen: null,
    agents_usage_check_account: {},
  };
}

/* ------------------------------------------------------------ the states */

const ONE = {
  accounts: [
    account('default', 'sam@example.com', { email: 'sam@example.com', plan: 'Max' }),
    codexMac,
  ],
  inv: inventory([
    line(
      'default',
      'sam@example.com',
      [win('five_hour', 31, 3 * H), win('seven_day', 47, 4 * 24 * H + 2 * H)],
      { plan: 'max', spent, changes }
    ),
  ]),
};

const THREE_ACCOUNTS = [
  account('default', 'sam@example.com', { email: 'sam@example.com', plan: 'Max' }),
  account('a1work', 'Work', { email: 'sam@northwind.example', plan: 'Max' }),
  account('a2side', 'Side project', { email: 'sam.side@example.net', plan: 'Pro' }),
  codexMac,
];

const THREE = {
  accounts: THREE_ACCOUNTS,
  inv: inventory([
    line(
      'default',
      'sam@example.com',
      [win('five_hour', 38, 2 * H), win('seven_day', 61, 50 * H)],
      {
        spent,
        changes,
        pace: [
          {
            estimate: true,
            kind: 'seven_day',
            resetsAt: now + 50 * H,
            reachesAt: now + 40 * H,
            readings: 12,
            spanMinutes: 1900,
          },
        ],
      }
    ),
    line('a1work', 'Work', [win('five_hour', 12, 4 * H), win('seven_day', 22, 80 * H)], {
      orgName: 'Northwind',
      spent: [spent[1]],
    }),
    line('a2side', 'Side project', [win('seven_day', 5, 6 * 24 * H)]),
  ]),
};

const ONE_OUT = {
  accounts: [
    account('default', 'sam@example.com', {
      email: 'sam@example.com',
      plan: 'Max',
      out: true,
      limit: { at: now - 40 * M, resetsAt: now + 3 * H + 20 * M },
    }),
    THREE_ACCOUNTS[1],
    THREE_ACCOUNTS[2],
    codexMac,
  ],
  inv: inventory(
    [
      line(
        'default',
        'sam@example.com',
        [win('five_hour', 100, 3 * H + 20 * M), win('seven_day', 74, 50 * H)],
        {
          out: true,
          outUntil: now + 3 * H + 20 * M,
          next: false,
          spent,
        }
      ),
      line('a1work', 'Work', [win('five_hour', 12, 4 * H), win('seven_day', 22, 80 * H)], {
        next: true,
      }),
      line('a2side', 'Side project', [win('seven_day', 5, 6 * 24 * H)]),
    ],
    {}
  ),
};

const NEAR_EMPTY = {
  accounts: THREE_ACCOUNTS.slice(0, 2).concat([codexMac]),
  inv: inventory(
    [
      line(
        'default',
        'sam@example.com',
        [win('five_hour', 96, 50 * M), win('seven_day', 93, 30 * H)],
        {
          spent,
        }
      ),
      line('a1work', 'Work', [win('five_hour', 40, 3 * H), win('seven_day', 97, 31 * H)]),
    ],
    {
      totals: {
        accounts: 2,
        engines: [],
        read: 2,
        room: 2,
        windows: [],
        nextRoom: {
          engine: 'claude',
          accountId: 'default',
          accountName: 'sam@example.com',
          at: now + 50 * M,
        },
      },
    }
  ),
};

const RESET_SOON = {
  accounts: THREE_ACCOUNTS.slice(0, 2).concat([codexMac]),
  inv: inventory(
    [
      line(
        'default',
        'sam@example.com',
        [win('five_hour', 8, 4 * H), win('seven_day', 38, 9 * H)],
        {
          spent,
        }
      ),
      line('a1work', 'Work', [win('seven_day', 15, 3 * 24 * H)]),
    ],
    {
      mode: 'use_it_all',
      spare: [
        {
          engine: 'claude',
          accountId: 'default',
          accountName: 'sam@example.com',
          next: true,
          kind: 'seven_day',
          usedPercent: 38,
          resetsAt: now + 9 * H,
          observedAt: now - 6 * M,
        },
      ],
      backlog: [
        {
          id: 's1',
          text: 'Research three competitors’ pricing pages',
          addedBy: 'you',
          addedAt: now - 2 * 24 * H,
          state: 'waiting',
        },
        {
          id: 's2',
          text: 'Write tests for the invoice parser',
          agentId: 'finance',
          addedBy: 'Finance',
          addedAt: now - 24 * H,
          state: 'waiting',
        },
        {
          id: 's3',
          text: 'Tidy the onboarding docs',
          addedBy: 'you',
          addedAt: now - 3 * H,
          state: 'waiting',
        },
        {
          id: 's4',
          text: 'Draft next week’s newsletter',
          addedBy: 'you',
          addedAt: now - H,
          state: 'waiting',
        },
      ],
    }
  ),
};

const UNKNOWN = {
  accounts: [
    account('default', 'sam@example.com', { email: 'sam@example.com' }),
    account('a1work', 'Work', { email: 'sam@northwind.example' }),
    account('a3new', 'Account 3', { signedIn: false }),
    codexMac,
  ],
  inv: inventory(
    [
      line('default', 'sam@example.com', [], {
        check: { at: now - 2 * M, outcome: 'failed', why: 'Couldn’t reach Claude' },
      }),
      line('a1work', 'Work', [], {
        check: {
          at: now - 2 * M,
          outcome: 'cant_read',
          why: 'Can’t read its limits between turns',
        },
      }),
      line('a3new', 'Account 3', [], { signedIn: false }),
    ],
    { totals: { accounts: 3, engines: [], read: 0, room: 0, windows: [] } }
  ),
};

/** The owner's case: This Mac's sign-in, and "Personal Account" added with the same Claude account. */
const SAME = {
  accounts: [
    account('default', 'sam@example.com', { email: 'sam@example.com', plan: 'Max' }),
    account('a4dup', 'Personal Account', { email: 'sam@example.com' }),
    codexMac,
  ],
  inv: inventory([
    line('default', 'sam@example.com', [win('seven_day', 22, 5 * 24 * H)], { plan: 'max', spent }),
    line('a4dup', 'Personal Account', [win('seven_day', 22, 5 * 24 * H)], {
      sameAs: 'sam@example.com',
    }),
  ]),
};

/**
 * The owner's real setup: This Mac's Claude Code used to be one account
 * (its week reset Mondays 4 PM) and is now signed in as the personal one,
 * which "Personal Account" already was (Saturdays 10 AM). The Mac recorded
 * no name for the old one, only that its weekly reset moved.
 */
const MON_4PM = (() => {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
  d.setHours(16, 0, 0, 0);
  return d.getTime();
})();
const SAT_10AM = (() => {
  const d = new Date(now);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(10, 0, 0, 0);
  return d.getTime();
})();
const SIGNIN_CHANGED = {
  accounts: [
    account('default', 'me@example.com', { email: 'me@example.com', plan: 'Max' }),
    account('a4dup', 'Personal Account', { email: 'me@example.com' }),
    codexMac,
  ],
  inv: inventory(
    [
      line('default', 'me@example.com', [win('seven_day', 43, SAT_10AM - now)], {
        plan: 'max',
        spent,
      }),
      line('a4dup', 'Personal Account', [win('seven_day', 43, SAT_10AM - now)], {
        sameAs: 'me@example.com',
      }),
    ],
    {
      signInChanges: [
        {
          engine: 'claude',
          key: 'claude:moved:1',
          at: now - 2 * 24 * H,
          nowEmail: 'me@example.com',
          beforeWeeklyReset: MON_4PM,
          nowWeeklyReset: SAT_10AM,
          byReset: true,
        },
      ],
    }
  ),
};

/** Every limit an engine reports, ahead of pace with a run-out estimate, and two accounts' tokens. */
const PACE = {
  accounts: [
    account('default', 'sam@example.com', { email: 'sam@example.com', plan: 'Max' }),
    account('a1work', 'Work', { email: 'sam@northwind.example', plan: 'Max' }),
    codexMac,
  ],
  inv: inventory([
    line(
      'default',
      'sam@example.com',
      [
        win('five_hour', 38, 2 * H + 20 * M),
        win('seven_day', 64, 3 * 24 * H + 12 * H),
        win('seven_day_opus', 30, 3 * 24 * H + 12 * H),
      ],
      {
        plan: 'max',
        spent,
        pace: [
          {
            estimate: true,
            kind: 'seven_day',
            resetsAt: now + 3 * 24 * H + 12 * H,
            reachesAt: now + 30 * H,
            readings: 14,
            spanMinutes: 3 * 24 * 60,
          },
        ],
      }
    ),
    line('a1work', 'Work', [win('five_hour', 5, 4 * H), win('seven_day', 12, 6 * 24 * H)], {
      next: false,
      spent: [{ agentId: 'leadgen', name: 'Lead Gen', turns: 12, tokens: 2_100_000 }],
    }),
  ]),
};

/** The owner's case: the account in use has 44% of its week left, the other all of it. */
const TWO = {
  accounts: [
    account('default', 'sam@example.com', { email: 'sam@example.com', plan: 'Max' }),
    account('a1work', 'Work', { email: 'sam@northwind.example', plan: 'Max' }),
    codexMac,
  ],
  inv: inventory([
    line(
      'default',
      'sam@example.com',
      [
        win('five_hour', 31, 3 * H + 10 * M),
        win('seven_day', 56, 2 * 24 * H + 4 * H),
        win('seven_day_opus', 40, 2 * 24 * H + 4 * H),
      ],
      {
        plan: 'max',
        spent,
        changes,
        pace: [
          {
            estimate: true,
            kind: 'seven_day',
            resetsAt: now + 2 * 24 * H + 4 * H,
            reachesAt: now + 40 * H,
            readings: 14,
            spanMinutes: 3 * 24 * 60,
          },
        ],
      }
    ),
    line('a1work', 'Work', [win('five_hour', 0, 5 * H), win('seven_day', 0, 6 * 24 * H + 2 * H)], {
      orgName: 'Northwind',
      next: false,
    }),
  ]),
};

const OPEN = [{ click: '[data-testid="account-switcher"]' }];

/** The overview, an account's page, and the sidebar row, for one state. */
function trio(
  id: string,
  title: string,
  looksRightWhen: string,
  state: { accounts: Acc[]; inv: Acc },
  detail: { account: string; looksRightWhen: string } | null
): Scenario[] {
  const cmds = commands(state.accounts, state.inv);
  return [
    {
      id: `usage-${id}`,
      title: `Usage — ${title}`,
      looksRightWhen,
      openSelector: AGENTS_TAB,
      steps: OPEN,
      requires: '[data-testid="usage-hero"]',
      commands: cmds,
    },
    ...(detail
      ? [
          {
            id: `usage-${id}-account`,
            title: `Usage — ${title} (an account’s page)`,
            looksRightWhen: detail.looksRightWhen,
            openSelector: AGENTS_TAB,
            steps: [...OPEN, { click: `.usage-row[data-account="${detail.account}"]` }],
            requires: '.usage-account',
            commands: cmds,
          },
        ]
      : []),
    {
      id: `usage-${id}-row`,
      title: `Usage — ${title} (the sidebar row)`,
      looksRightWhen:
        'At the foot of the Agents sidebar: “Usage”, then the total (“72% left · 2 accounts”), the total bar (a segment per account, most room first) and “Refills in …”. Nothing accent-coloured; nothing wraps.',
      openSelector: AGENTS_TAB,
      requires: '[data-testid="account-switcher"]',
      clipSelector: '.workspace-sidebar-footer',
      commands: cmds,
    },
  ];
}

const PAGE =
  'A breadcrumb with a back arrow, “Usage › <name>”. A sheet with a large keycap, the name, a status pill and “1st in the order · Max plan · …”, with “Use this one now” (when it isn’t in use) and ⋯ at the right. Then “Limits” with Limits | Tokens at its right, the limit cards (5-hour, Weekly, per-model) with countdown chips, a big “% left”, the pace-marked bar and the pace sentence, then “Where did my usage go” when there is something to say.';

export const agentsUsageViewScenarios: Scenario[] = [
  ...trio(
    'two',
    'two accounts, 100% and 44%',
    'The hero leads with the total: “All accounts”, a large “72% left across 2 Max accounts”, “Next refill in 2d 4h · sam@example.com, …”. One bar of two segments, Work (full) on the left, sam@example.com (44%) on the right, each with its name, “% left” and a refill chip under it. Then “Accounts” with “Add …” at the right, two rows in order (1 sam@example.com In use, 2 Work), figures aligned. Then “How agents use your limits”, a hugging three-option control and its one line.',
    TWO,
    { account: 'default', looksRightWhen: PAGE }
  ),
  ...trio(
    'one',
    'one account',
    'The hero: “Usage”, “53% left this week”, “Next refill in …”, one full-width segment. One row. No “All accounts”.',
    ONE,
    { account: 'default', looksRightWhen: PAGE }
  ),
  ...trio(
    'three',
    'three accounts',
    'Three segments, most room first (Side project 95%, Work 78%, sam@example.com 39%); the total is their mean. Three rows in order 1, 2, 3: In use, Next, Ready.',
    THREE,
    { account: 'a1work', looksRightWhen: PAGE }
  ),
  ...trio(
    'one-out',
    'one account out',
    'sam@example.com sits last in the bar (empty, 0% left) and its row says “Out of usage until …” in a neutral pill; the total counts it as nothing left.',
    ONE_OUT,
    {
      account: 'default',
      looksRightWhen:
        'The out account’s page: its pill reads “Out of usage until …”; its limit cards say 0% left.',
    }
  ),
  ...trio(
    'near-empty',
    'every account nearly empty',
    'A small total in amber slivers; under the hero one calm warning-washed bar: “Every account is nearly out of usage.” with “Add an account” and “Wait until …”.',
    NEAR_EMPTY,
    null
  ),
  ...trio(
    'reset-soon',
    'a reset soon with lots left',
    'Under “How agents use your limits” (on “Use it all before reset”) a sheet: “62% of sam@example.com’s week resets in 9 h”, the first three waiting items and “and 1 more”, and a neutral “Give agents something to do”.',
    RESET_SOON,
    null
  ),
  ...trio(
    'unknown',
    'no readings yet',
    'The hero says “Your usage shows here after an agent’s first reply.” in secondary ink (no big figure). Every segment is an empty dashed slot, never full. Rows say “Not read yet”; the signed-out one only its “Not signed in” pill.',
    UNKNOWN,
    {
      account: 'a3new',
      looksRightWhen:
        'The unsigned account’s page: a warning-washed bar “Sign in to use it.” with “Sign in”; no limits section.',
    }
  ),
  ...trio(
    'same-account',
    'the same account signed in twice',
    'The bar has ONE segment (the duplicate draws none), with one muted line under it: “Personal Account is the same Claude account as sam@example.com — adds no extra room”. The rows list both; Personal Account’s says “Adds no room” with a “Same account” pill and a dashed bar.',
    SAME,
    {
      account: 'a4dup',
      looksRightWhen:
        'The duplicate’s page: “Same account” pill, a bar “Same Claude account as sam@example.com — adds no extra room.” with “Sign in with a different account” and “Remove”; no limits.',
    }
  ),
  ...trio(
    'signin-changed',
    'this Mac’s sign-in became another account',
    'First thing in the view, a calm bar about this Mac’s sign-in, with “Add it” and “Not now”. Below, the total of one segment and the duplicate line.',
    SIGNIN_CHANGED,
    null
  ),
  ...trio('pace', 'every limit, against pace', 'Two segments, Work (88%) first.', PACE, {
    account: 'default',
    looksRightWhen:
      'sam@example.com’s page: 5-hour, Weekly and “Weekly · Opus” cards. The weekly one is ahead of pace: a now → refills line with a dashed marker “Runs out ~tomorrow · estimate” and “Ahead of pace — …”.',
  }),
  {
    id: 'usage-tokens',
    title: 'Usage — who used an account this week (Tokens)',
    looksRightWhen:
      'On sam@example.com’s page after “Tokens”: “Used by these agents this week”, a table with Agent / Tokens / Turns headings, one row per agent with its key, name, a thin share bar, and right-aligned figures (Chief of Staff 4.8M 23 …), then a line saying these are tokens, not a cost.',
    openSelector: AGENTS_TAB,
    steps: [
      ...OPEN,
      { click: '.usage-row[data-account="default"]' },
      { click: '[data-testid="usage-view-switch"] button:last-child' },
    ],
    requires: '.usage-table',
    commands: commands(TWO.accounts, TWO.inv),
  },
  {
    id: 'usage-add-account-warning',
    title: 'Usage — adding an account warns about the browser first',
    looksRightWhen:
      'The sign-in dialog opens on a plain warning before any terminal: “Your browser will sign in as whoever is logged into claude.ai — sign out there first, or use a private window or another browser profile, to add a different account.” Then the email field, Later and Continue.',
    openSelector: AGENTS_TAB,
    steps: [...OPEN, { click: '[data-add-account="claude"]' }],
    requires: '[data-testid="account-signin-warning"]',
    viewport: { width: 1280, height: 900 },
    commands: {
      ...commands(SIGNIN_CHANGED.accounts, SIGNIN_CHANGED.inv),
      agents_account_add: {
        id: 'a5new',
        engine: 'claude',
        name: 'Account 3',
        named: true,
      },
    },
  },
];
