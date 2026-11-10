/**
 * An agent at work in a codebase, seen from Projects (`agents::workplace`):
 * the project it works in is pinned at the top of the sidebar with a line
 * under its row saying who is in it and the step they're on. Fictional team
 * and repos.
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT, dashboardProject } from './base';
import { MIN, TEAM, now, overview } from './agents';

const SITE = `${HARNESS_ROOT}/lumen-site`;
const ACME = `${HARNESS_ROOT}/acme-marketing`;

const turn = (label: string, project: string) => ({
  startedAt: now - 4 * MIN,
  stepCount: 6,
  fileCount: 2,
  doing: label,
  current: { kind: 'command', label, startedAt: now - 2 * MIN, streams: false, canStop: true },
  lastSignAt: now - 2_000,
  steps: [{ at: now - 4 * MIN, kind: 'read', label: 'Read package.json' }],
  project,
});

const team = () =>
  TEAM.map((a) => {
    if (a.id === 'acme') {
      return {
        ...a,
        status: {
          state: 'working' as const,
          activity: 'Running the build',
          since: now - 4 * MIN,
          work: turn('Running the build', SITE),
        },
      };
    }
    if (a.id === 'finance') {
      return {
        ...a,
        status: {
          state: 'working' as const,
          activity: 'Running the tests',
          since: now - 3 * MIN,
          work: turn('Running the tests', ACME),
        },
      };
    }
    return a;
  });

const MEMBER = `${HARNESS_ROOT}/northwind-docs`;

/** Three projects; agents working in two of them (four in one, to show the +N). */
const busyTeam = () =>
  TEAM.map((a) => {
    const at = (project: string, label: string, mins: number) => ({
      ...a,
      status: {
        state: 'working' as const,
        activity: label,
        since: now - mins * MIN,
        work: turn(label, project),
      },
    });
    if (a.id === 'chief')
      return at(SITE, 'Running a Python script to merge the exported invoices', 6);
    if (a.id === 'acme') return at(SITE, 'Thinking', 4);
    if (a.id === 'finance') return at(SITE, 'Running the tests', 3);
    if (a.id === 'leadgen') return at(SITE, 'Reading the pricing page', 2);
    if (a.id === 'native') return at(MEMBER, 'Editing PricingTable.tsx', 2);
    return a;
  });

const busyCommands = {
  get_dashboard_projects: [
    dashboardProject('lumen-site'),
    dashboardProject('acme-marketing'),
    dashboardProject('northwind-docs'),
  ],
  list_pinned_projects: [SITE, ACME, MEMBER],
  agents_overview: overview(busyTeam()),
  agents_with_projects: busyTeam(),
};

export const projectsAtWorkScenarios: Scenario[] = [
  {
    id: 'projects-agents-collapsed',
    title: 'Projects: three projects, agents working in two, rows collapsed',
    looksRightWhen:
      'Collapsed project rows carry only a small stack of agent avatars (max 3, then +N) and the working indicator; no lines under the rows, nothing overlapping.',
    startOn: 'projects',
    requires: '.sidebar-project',
    clipSelector: '.workspace-sidebar',
    commands: busyCommands,
  },
  {
    id: 'projects-agents-expanded',
    title: 'Projects: a project expanded, agents working in it sit among its sessions',
    looksRightWhen:
      'Under Sessions, one row per working agent: avatar, name, then its live step, clipped to one line with an ellipsis. Clicking one opens its chat.',
    startOn: 'projects',
    requires: '.sidebar-project',
    clipSelector: '.workspace-sidebar',
    steps: [{ click: '.sidebar-project-chevron' }],
    commands: busyCommands,
  },
  {
    id: 'projects-agent-at-work',
    title: 'Projects — the project an agent is working in, with what it’s doing',
    looksRightWhen:
      'Projects. The sidebar’s Pinned group starts with lumen-site with one small agent avatar at its right (and no line under the row); acme-marketing (not pinned) appears in the Active group with its own avatar. Expanded, the agents are rows under Sessions.',
    startOn: 'projects',
    requires: '.sidebar-project-at-work',
    clipSelector: '.workspace-sidebar',
    commands: {
      get_dashboard_projects: [dashboardProject('lumen-site'), dashboardProject('acme-marketing')],
      list_pinned_projects: [SITE],
      agents_overview: overview(team()),
      agents_with_projects: team(),
    },
  },
];
