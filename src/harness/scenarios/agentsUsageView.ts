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

const OPEN = [{ click: '[data-testid="account-switcher"]' }];

function pair(
  id: string,
  title: string,
  looksRightWhen: string,
  state: { accounts: Acc[]; inv: Acc },
  extra: Partial<Scenario> = {}
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
      viewport: { width: 1280, height: 1000 },
      commands: cmds,
      ...extra,
    },
    {
      id: `usage-${id}-row`,
      title: `Usage — ${title} (the sidebar row)`,
      looksRightWhen:
        'At the foot of the Agents sidebar: the engine icon with its status dot, one plain line, the stack as a thin segmented meter (one segment per account, in order) and, muted, the count and soonest reset. Nothing accent-coloured; nothing wraps.',
      openSelector: AGENTS_TAB,
      requires: '[data-testid="account-switcher"]',
      clipSelector: '.workspace-sidebar-footer',
      commands: cmds,
    },
  ];
}

export const agentsUsageViewScenarios: Scenario[] = [
  ...pair(
    'one',
    'one account',
    'A hero sheet: “Your account”, “Plenty of room”, one full-width segment filled to 53% in ink, “sam@example.com · 53% left” under it, and the next reset. Below: the mode control, then one key card with a raised “1” keycap, “sam@example.com”, an “In use” pill, “Max plan · this Mac’s own sign-in”, 5-hour and Weekly bars with “Resets in …”, “Used by these agents this week” and a quiet “Where did my usage go”. No drag handle with one account.',
    ONE
  ),
  ...pair(
    'three',
    'three accounts',
    'Three segments in order, the first (in use) in full ink, the others quieter; under them each name and its room. Three key cards with grips and 1, 2, 3 keycaps: In use, Next, Ready. The first has an amber pace line (an estimate, with what it rests on). Work shows “Northwind”. Each card that isn’t in use has “Use this one now”.',
    THREE
  ),
  ...pair(
    'one-out',
    'one account out',
    'The first key reads “Out of usage until …” (a neutral pill, never amber) with an empty first segment; Work is “In use”; the headline still says there is room.',
    ONE_OUT
  ),
  ...pair(
    'near-empty',
    'every account nearly empty',
    'Headline “Nearly out on every account” in amber; under the hero one calm warning-washed bar: “Every account is nearly out of usage.” with “Add an account” and “Wait until …”. Segments are thin amber slivers.',
    NEAR_EMPTY
  ),
  ...pair(
    'reset-soon',
    'a reset soon with lots left',
    '“Get the most from your limits” leads with a sheet: “62% of sam@example.com’s week resets in 9 h”, “Give agents something to do before it goes?”, the first three waiting items and “and 1 more”, and a neutral “Give agents something to do” key. The mode control shows “Use it all before reset”.',
    RESET_SOON
  ),
  ...pair(
    'unknown',
    'no readings yet',
    'Headline “No usage reading yet”. Every segment is an empty dashed slot, never full. Keys say “No reading yet” / “Not signed in”; the unsigned one has the fix line and a “Sign in” button.',
    UNKNOWN
  ),
  ...pair(
    'same-account',
    'the same account signed in twice',
    'Two keys, but the stack counts one: the second segment is hatched and empty, labelled “Adds no room”. “Personal Account” sits on a dashed sheet with an amber-washed fix line naming why (the same Claude Code account as sam@example.com) and “Sign in with another account”; no “Use this one now”. Summary “1 account · resets …”.',
    SAME
  ),
  {
    id: 'usage-where-did-it-go',
    title: 'Usage — where did my usage go',
    looksRightWhen:
      'Under the in-use key, “Where did my usage go” is open: “Weekly 32% → 47% used” with when, and plainly “Nothing these agents ran explains this. It was used somewhere else: …”; then “Weekly 21% → 32% used” listing “Finance: Monday numbers · 3 turns · 900k tokens” and “Chief of Staff · 6 turns · 640k tokens”, and a quiet note that points aren’t split between runs.',
    openSelector: AGENTS_TAB,
    steps: [...OPEN, { click: '.usage-key[data-state="in_use"] [data-usage-story]' }],
    requires: '.usage-key__story',
    viewport: { width: 1280, height: 1100 },
    commands: commands(ONE.accounts, ONE.inv),
  },
];
