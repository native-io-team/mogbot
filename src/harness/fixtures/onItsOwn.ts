/**
 * "What can this agent do on its own?" (`agents/on_its_own.rs`), shaped as
 * the Rust serde output (`agentsOnItsOwn` in `fixtures.gen.ts`), with the
 * Mac's own words for each item.
 */

import type { OnItsOwn, OnItsOwnTeam } from '../../../packages/companion-protocol/src/onItsOwn';

const ALWAYS = 'Always asks before spending money, using your passwords, or deleting for good.';
const BOLD = 'Does local work on this Mac; asks before anything leaves it.';

/** A plan that ends 42 minutes after the harness's page load. */
const planEnds = () => Date.now() + 42 * 60_000;

/** Lead Gen on Bold (the team's): every kind of standing item. */
export function richOnItsOwn(agentId: string, agentName: string): OnItsOwn {
  return {
    agentId,
    agentName,
    level: 'go_hard',
    ownLevel: false,
    levelLine: BOLD,
    alwaysAsks: [ALWAYS],
    items: [
      {
        key: 'rule:r1',
        kind: 'rule',
        text: 'Run npm test',
        detail: 'Always allowed on a card',
        narrow: [{ kind: 'rule', ruleId: 'r1' }],
      },
      {
        key: 'rule:r2',
        kind: 'said',
        text: 'Post to social media · Native OS',
        detail: 'From what you said: “ur always allowed to do those”',
        narrow: [{ kind: 'rule', ruleId: 'r2' }],
      },
      {
        key: 'rule:t1',
        kind: 'team_rule',
        text: 'Open pages on linkedin.com',
        detail: 'Every agent · from what you said: “you can all read LinkedIn”',
        narrow: [{ kind: 'rule', ruleId: 't1' }],
      },
      {
        key: 'plan:g1',
        kind: 'plan',
        text: 'Open an issue about the failed build (done); Comment on #12 with the fix',
        detail: 'A plan you said yes to · also for Acme Site',
        endsAt: planEnds(),
        narrow: [{ kind: 'plan', grantId: 'g1' }],
      },
      {
        key: 'app:c1',
        kind: 'app',
        text: 'Uses Gmail (sam@acme.com)',
        detail: 'Reads without asking; sending or changing asks you each time',
        narrow: [
          { kind: 'app', connectionId: 'c1' },
          { kind: 'app_read_only', connectionId: 'c1' },
        ],
      },
      {
        key: 'app:c2',
        kind: 'app',
        text: 'Uses Linear',
        detail: 'Reads without asking; anything else is refused · needs signing in again',
        narrow: [{ kind: 'app', connectionId: 'c2' }],
      },
      {
        key: 'browser',
        kind: 'browser',
        text: 'Opens pages in your Chrome, where you’re signed in, and in the agents’ own browser',
        detail:
          'Through Claude in Chrome · what it does on a page follows its level; never for text from outside',
        narrow: [{ kind: 'browser' }],
      },
      {
        key: 'account',
        kind: 'account',
        text: 'Spends only your Work account (Claude Code)',
        detail: 'Waits when it runs out; change it in Edit agent',
        narrow: [],
      },
    ],
  };
}

/** An agent with nothing beyond its level. */
export function bareOnItsOwn(agentId: string, agentName: string): OnItsOwn {
  return {
    agentId,
    agentName,
    level: 'go_hard',
    ownLevel: false,
    levelLine: BOLD,
    alwaysAsks: [ALWAYS],
    items: [
      {
        key: 'account',
        kind: 'account',
        text: 'Spends your Claude Code accounts, in your order',
        detail: 'Moves on to the next when one runs out; change it in Edit agent',
        narrow: [],
      },
    ],
  };
}

/** The Chief: admin, Unleashed on its own, and replying in Slack by itself. */
export function chiefOnItsOwn(agentId: string, agentName: string): OnItsOwn {
  return {
    agentId,
    agentName,
    level: 'full_send',
    ownLevel: true,
    levelLine:
      'Sends, posts and pushes too; only stops for money, logins, deleting for good or going live.',
    alwaysAsks: [ALWAYS],
    items: [
      {
        key: 'rule:t1',
        kind: 'team_rule',
        text: 'Open pages on linkedin.com',
        detail: 'Every agent · from what you said: “you can all read LinkedIn”',
        narrow: [{ kind: 'rule', ruleId: 't1' }],
      },
      {
        key: 'admin',
        kind: 'admin',
        text: 'Manages the team: answers other agents’ local requests, pauses them, changes their routines',
        detail: 'Never spending, sending, publishing, pushing or keys: those come to you',
        narrow: [{ kind: 'admin' }],
      },
      {
        key: 'slack',
        kind: 'slack',
        text: 'Replies in Slack by itself, under your name',
        detail: 'Only to what you asked there yourself, in a turn that read nothing from outside',
        narrow: [{ kind: 'exact_text' }],
      },
      {
        key: 'account',
        kind: 'account',
        text: 'Spends your Claude Code accounts, in your order',
        detail: 'Moves on to the next when one runs out; change it in Edit agent',
        narrow: [],
      },
    ],
  };
}

const NAMES: Record<string, string> = {
  chief: 'Chief of Staff',
  leadgen: 'Lead Gen',
  acme: 'Acme Site',
  finance: 'Finance',
};

/** `agents_on_its_own`: Lead Gen rich, the Chief an admin, the rest bare. */
export function onItsOwnFor(args: Record<string, unknown>): OnItsOwn {
  const id = typeof args.agentId === 'string' ? args.agentId : '';
  const name = NAMES[id] ?? 'This agent';
  if (id === 'leadgen') return richOnItsOwn(id, name);
  if (id === 'chief') return chiefOnItsOwn(id, name);
  return bareOnItsOwn(id, name);
}

export const TEAM_ON_ITS_OWN: OnItsOwnTeam = {
  level: 'go_hard',
  levelLine: BOLD,
  alwaysAsks: [ALWAYS],
  teamRules: [
    {
      key: 'rule:t1',
      kind: 'team_rule',
      text: 'Open pages on linkedin.com',
      detail: 'Every agent · from what you said: “you can all read LinkedIn”',
      narrow: [{ kind: 'rule', ruleId: 't1' }],
    },
  ],
  agents: [
    { agentId: 'chief', name: 'Chief of Staff', level: 'full_send', ownLevel: true, standing: 2 },
    { agentId: 'leadgen', name: 'Lead Gen', level: 'go_hard', ownLevel: false, standing: 6 },
    { agentId: 'acme', name: 'Acme Site', level: 'go_hard', ownLevel: false, standing: 0 },
    { agentId: 'finance', name: 'Finance', level: 'often', ownLevel: true, standing: 0 },
  ],
};
