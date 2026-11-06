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

export const projectsAtWorkScenarios: Scenario[] = [
  {
    id: 'projects-agent-at-work',
    title: 'Projects — the project an agent is working in, with what it’s doing',
    looksRightWhen:
      'Projects. The sidebar’s Pinned group starts with lumen-site, with a working indicator at its right and under it one quiet line “Acme Site · Running the build” (name in primary text, the step muted, a small dot before it). acme-marketing (not pinned) appears in the Active group with “Finance · Running the tests” under it. Clicking a line opens that agent’s chat in Agents.',
    startOn: 'projects',
    requires: '.sidebar-project-at-work__link',
    clipSelector: '.workspace-sidebar',
    commands: {
      get_dashboard_projects: [dashboardProject('lumen-site'), dashboardProject('acme-marketing')],
      list_pinned_projects: [SITE],
      agents_overview: overview(team()),
      agents_with_projects: team(),
    },
  },
];
