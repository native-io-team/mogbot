/** Public issue reporting surfaces and their distinct submission outcomes. */

import type { Scenario } from '../types';
import { rejectsWith } from '../reject';
import { BRAND_LINKS } from '../../lib/brand';

const completeBugSteps = [
  { fill: 'input[data-issue-field="title"]', value: '[Bug] Toolbar stops updating' },
  {
    fill: 'textarea[data-issue-field="what-happened"]',
    value: 'The preview toolbar stops updating after switching projects.',
  },
  {
    fill: 'textarea[data-issue-field="what-expected"]',
    value: 'The toolbar should reflect the active project.',
  },
  {
    fill: 'textarea[data-issue-field="steps"]',
    value: 'Open two projects\nSwitch from the first project to the second\nCheck the toolbar',
  },
  { click: 'button[data-issue-action="evidence-next"]' },
  { click: '[data-evidence-choice="none"]' },
  { click: 'button[data-issue-action="evidence-next"]' },
];

const chooseBugFromMenu = [{ click: '.settings-menu [data-settings-item="bug-reports"]' }];

const submitBugSteps = [
  ...chooseBugFromMenu,
  ...completeBugSteps,
  { click: 'button[data-issue-action="submit"]' },
];

const editBugBodySteps = [
  ...chooseBugFromMenu,
  ...completeBugSteps,
  { click: 'button[data-issue-action="edit-report-body"]' },
  {
    fill: 'textarea[data-issue-field="report-body"]',
    value: '## Custom report\n\nI rewrote this report body in Markdown.',
  },
  { click: 'button[data-issue-action="save-report-body"]' },
];

const completeFeatureSteps = [
  { click: '.settings-menu [data-settings-item="feature-request"]' },
  { fill: 'input[data-issue-field="title"]', value: '[Feature] Add a project search shortcut' },
  {
    fill: 'textarea[data-issue-field="problem"]',
    value: 'Finding a project takes several clicks when the dashboard is busy.',
  },
  {
    fill: 'textarea[data-issue-field="proposed-solution"]',
    value: 'Add a search field that filters projects from the keyboard.',
  },
  {
    fill: 'textarea[data-issue-field="who-benefits"]',
    value: 'People with many projects who use keyboard navigation.',
  },
  { click: 'button[data-issue-action="evidence-next"]' },
  { click: '[data-evidence-choice="none"]' },
  { click: 'button[data-issue-action="evidence-next"]' },
];

const allIssueReportScenarios: Scenario[] = [
  {
    id: 'issue-report-form',
    command: 'issueReports.bugReport',
    requires: '[data-issue-surface="bug-form"]',
    title: 'Report bug — guided form',
    looksRightWhen:
      'The bug form opens immediately with the issue type set to Bug report and recent app reports visible above the fields.',
    clipSelector: '.issue-report-modal',
    commands: {},
  },
  {
    id: 'issue-report-type-switching',
    openSelector: '[data-settings-menu-trigger]',
    steps: [...chooseBugFromMenu, { select: '[data-issue-type-select]', value: 'feature' }],
    requires: '[data-issue-surface="feature-form"]',
    title: 'Issue type — feature request form',
    looksRightWhen:
      'Changing Issue type replaces the bug fields with the feature request fields in the same open form.',
    clipSelector: '.issue-report-modal',
    commands: {},
  },
  {
    id: 'issue-report-security-route',
    openSelector: '[data-settings-menu-trigger]',
    steps: [...chooseBugFromMenu, { select: '[data-issue-type-select]', value: 'security' }],
    requires: '.issue-report__contact-links',
    title: 'Security vulnerability — private reporting',
    looksRightWhen:
      'The form explains that security reports stay private and offers only the private advisory route, with no public issue submission action.',
    clipSelector: '.issue-report-modal',
    commands: {},
  },
  {
    id: 'issue-report-review',
    openSelector: '[data-settings-menu-trigger]',
    steps: [...chooseBugFromMenu, ...completeBugSteps],
    requires: '[data-issue-surface="review"]',
    title: 'Bug report — public preview',
    looksRightWhen:
      'The full template body and issue title are visible before submission, with the active gh account and a clear public disclosure notice.',
    clipSelector: '.issue-report-modal',
    commands: {},
  },
  {
    id: 'issue-report-edit-body',
    openSelector: '[data-settings-menu-trigger]',
    steps: editBugBodySteps,
    requires: '.issue-report__preview pre',
    title: 'Bug report — custom Markdown body',
    looksRightWhen:
      'The edited Markdown appears in the public preview and is preserved as the report body instead of being regenerated from form fields.',
    clipSelector: '.issue-report-modal',
    commands: {},
  },
  {
    id: 'issue-report-success',
    openSelector: '[data-settings-menu-trigger]',
    steps: submitBugSteps,
    requires: '[data-issue-surface="success"]',
    title: 'Bug report — confirmed issue',
    looksRightWhen:
      'A confirmed API response supplies the real issue number and URL, with the account that created it.',
    clipSelector: '.issue-report-modal',
    commands: {
      submit_github_issue: {
        status: 'created',
        number: 42,
        issueUrl: 'https://github.com/example/app/issues/42',
        login: 'harness-user',
      },
    },
  },
  {
    id: 'issue-report-auth-error',
    openSelector: '[data-settings-menu-trigger]',
    steps: submitBugSteps,
    requires: '[data-issue-surface="review"] .issue-report__error[role="alert"]',
    title: 'Bug report — GitHub authentication error',
    looksRightWhen:
      'A failed authenticated submission keeps the complete draft and offers the browser handoff.',
    clipSelector: '.issue-report-modal',
    commands: {
      submit_github_issue: rejectsWith('Not authenticated with github'),
    },
  },
  {
    id: 'issue-report-automatic-receipt',
    openSelector: '[data-settings-menu-trigger]',
    steps: completeFeatureSteps,
    requires: '.issue-report__automatic-reports',
    title: 'Feature request — related automatic report receipt',
    looksRightWhen:
      'A recent accepted automatic report is clearly separated from a confirmed issue link; the context does not suppress unrelated manual reports.',
    clipSelector: '.issue-report-modal',
    commands: {
      get_automatic_report_status: {
        enabled: true,
        configured: true,
        reason: null,
        receipts: [
          {
            timestamp: new Date(Date.now() - 120_000).toISOString(),
            kind: 'error',
            source: 'frontend-log',
            summary: 'Preview failed to load after switching projects.',
          },
        ],
      },
    },
  },
];

/**
 * Issue reporting exists only when brand.json names a repo to file against
 * (`links.issueRepo`); with it null the menu rows and the form are hidden, so
 * these would photograph a screen that cannot open. Skipped rather than faked.
 */
export const issueReportScenarios: Scenario[] = BRAND_LINKS.issueRepo
  ? allIssueReportScenarios
  : [];
