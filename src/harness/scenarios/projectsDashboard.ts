/**
 * The Projects dashboard as the Agents-first app sees it: who works in each
 * project, the list view, and the New project / Import doors. Fictional team
 * and repos.
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT, dashboardProject } from './base';
import { MIN, TEAM, now, overview } from './agents';

const ACME = `${HARNESS_ROOT}/acme-marketing`;
const DOCS = `${HARNESS_ROOT}/docs-astro`;

/** Acme Site is bound to acme-marketing and working there; Finance is working in docs-astro. */
const team = () =>
  TEAM.map((a) => {
    if (a.id === 'acme') {
      return {
        ...a,
        project: ACME,
        copy: {
          id: 'c1',
          path: `${HARNESS_ROOT}/.worktrees/acme-site`,
          branch: 'mogbot/acme-site',
          project: ACME,
          base: 'abc1234',
          baseBranch: 'feat/pricing-page',
          createdAt: now - 30 * MIN,
          deps: true,
        },
        status: {
          state: 'working' as const,
          activity: 'Editing PricingTable.tsx',
          since: now - 4 * MIN,
          work: {
            startedAt: now - 4 * MIN,
            stepCount: 6,
            fileCount: 2,
            doing: 'Editing PricingTable.tsx',
            lastSignAt: now - 2_000,
            steps: [],
            project: ACME,
          },
        },
      };
    }
    if (a.id === 'finance') return { ...a, project: DOCS };
    return a;
  });

const projects = [
  dashboardProject('acme-marketing', { uncommitted_count: 3, git_branch: 'feat/pricing-page' }),
  dashboardProject('portfolio-site', { last_opened: Date.now() - 86_400_000 }),
  dashboardProject('docs-astro', { worktree_count: 2 }),
];

const withTeam = {
  get_dashboard_projects: projects,
  list_projects: projects,
  agents_overview: overview(team()),
  agents_with_projects: team(),
};

export const projectsDashboardScenarios: Scenario[] = [
  {
    id: 'dashboard-team-on-cards',
    startOn: 'projects',
    requires: '.project-card-team',
    title: 'Dashboard — who works in each project',
    looksRightWhen:
      'acme-marketing’s card carries Acme Site’s key and “Acme Site · Editing PricingTable.tsx”; ' +
      'docs-astro carries Finance’s key and “Finance works here”; portfolio-site has no team line. ' +
      'Branch names stay readable at narrow widths.',
    commands: withTeam,
  },
  {
    id: 'dashboard-list-team',
    startOn: 'projects',
    requires: '.project-table-row .project-card-team',
    title: 'Dashboard — list view with who works where',
    looksRightWhen:
      'Each row reads name, branch, changes, last opened; a project with agents shows their keys ' +
      'under its name, the same as on the cards. Changes are a count, not a warning colour.',
    storage: { 'ship-studio-project-view-mode': 'list' },
    commands: withTeam,
  },
  {
    id: 'dashboard-import-picker',
    startOn: 'projects',
    requires: '.import-picker-modal',
    title: 'Dashboard — Import',
    looksRightWhen:
      'Import opens the two choices (GitHub, a folder on this Mac) even before GitHub is ' +
      'connected; the GitHub one says it will connect first.',
    steps: [{ click: '[data-education-id="import-button"]' }],
    commands: { check_github_cli_status: { installed: true, authenticated: false } },
  },
  {
    id: 'dashboard-new-project',
    startOn: 'projects',
    requires: '.modal-content, [role="dialog"]',
    title: 'Dashboard — New project',
    looksRightWhen: 'New project opens in a ModalFrame, the same chrome as every other dialog.',
    steps: [{ click: '[data-education-id="new-project-button"]' }],
    commands: {},
  },
];
