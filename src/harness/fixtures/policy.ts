/**
 * What each agent can do (`agents/policy.rs`), as the Mac serializes it: a
 * Balanced team, and the presets. Shapes and words copied from the Rust
 * output (`policy::agent_view`, `policy::team_view`), the same as
 * `packages/companion-protocol/src/fixtures.gen.ts`. Fictional throughout.
 */

import type {
  AgentPolicyView,
  PolicyLine,
  TeamPolicyView,
} from '../../../packages/companion-protocol/src/policy';

const line = (
  key: PolicyLine['key'],
  label: string,
  value: string,
  enforced: PolicyLine['enforced'] = 'app',
  team = true
): PolicyLine => ({ key, label, value, enforced, team });

export const BALANCED_LINES: PolicyLine[] = [
  line(
    'projects',
    'Projects',
    'Every project · its own copy where it’s set to work; changes the others directly'
  ),
  line('folders', 'Folders on this Mac', 'None beyond its own and its projects'),
  line('apps', 'Apps', 'Every app you’ve connected'),
  line('browser', 'Your browser', 'Yes'),
  line('independence', 'Independence', 'Steady', 'prompt'),
  line('admin', 'Admin', 'No'),
  line('outward_text', 'Sent under your name', 'As its independence allows'),
  line('rules', 'Rules', 'None', 'prompt'),
];

export const BALANCED_VIEW: AgentPolicyView = {
  agentId: '',
  preset: 'balanced',
  sameAsTeam: true,
  lines: BALANCED_LINES,
  effective: {
    projects: { scope: 'all', how: 'copy', elsewhere: 'change' },
    folders: [],
    apps: { mode: 'all' },
    browser: true,
    independence: 'judgement',
    admin: false,
    teamRules: [],
    ownRules: [],
    outwardTextNeedsOk: false,
    own: [],
  },
};

export const PRESETS: TeamPolicyView['presets'] = [
  {
    id: 'trusted',
    label: 'I trust my agents',
    blurb: 'Change projects directly, every app, your browser, at Bold.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'Its own copy of the project it works in, your apps and browser, at Steady.',
  },
  {
    id: 'locked',
    label: 'Locked down',
    blurb: 'Read projects only, no apps, no browser, at Careful.',
  },
];

export const BALANCED_TEAM: TeamPolicyView = {
  preset: 'balanced',
  presets: PRESETS,
  lines: BALANCED_LINES.filter((l) => l.key !== 'admin'),
  team: {
    projects: { scope: 'all', how: 'copy', elsewhere: 'change' },
    folders: [],
    apps: { mode: 'all' },
    browser: true,
    rules: [],
    outwardTextNeedsOk: false,
  },
  ownSettings: [],
};
