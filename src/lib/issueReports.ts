import { invoke } from '@tauri-apps/api/core';
import { BRAND_LINKS } from './brand';

/** `owner/repo` public issues are filed against (`links.issueRepo` in brand.json). */
export const ISSUE_REPO: string | null = BRAND_LINKS.issueRepo;

/**
 * Whether in-app issue reporting exists in this build. Off when brand.json
 * names no issue repo: every entry point (palette, settings menu) hides, and
 * the backend refuses to submit.
 */
export const ISSUE_REPORTS_ENABLED = ISSUE_REPO !== null;

export type IssueKind = 'bug' | 'feature';

export interface IssueReportContext {
  appVersion: string;
  operatingSystem: string;
  architecture: string;
  defaultAgent: string | null;
}

export interface BugReportDraft {
  title: string;
  whatHappened: string;
  whatExpected: string;
  reproductionSteps: string;
  appVersion: string;
  operatingSystem: string;
  architecture: string;
  installMethod: string;
  agent: string;
  logs: string;
  screenshots: string;
  anythingElse: string;
}

export interface FeatureRequestDraft {
  title: string;
  problem: string;
  proposedSolution: string;
  alternatives: string;
  whoBenefits: string;
  anythingElse: string;
  evidenceLinks: string;
}

export interface SubmitGitHubIssueArgs {
  kind: IssueKind;
  title: string;
  body: string;
  projectPath: string | null;
  expectedLogin: string;
}

export type SubmitGitHubIssueResult =
  | { status: 'created'; number: number; issueUrl: string; login: string }
  | { status: 'uncertain'; login: string; message: string; issueListUrl: string };

export async function getIssueReportContext(): Promise<IssueReportContext> {
  return invoke<IssueReportContext>('get_issue_report_context');
}

export async function submitGitHubIssue(
  args: SubmitGitHubIssueArgs
): Promise<SubmitGitHubIssueResult> {
  return invoke<SubmitGitHubIssueResult>('submit_github_issue', {
    kind: args.kind,
    title: args.title,
    body: args.body,
    projectPath: args.projectPath,
    expectedLogin: args.expectedLogin,
  });
}

export function issueTitle(kind: IssueKind, title: string): string {
  const prefix = kind === 'bug' ? '[Bug]' : '[Feature]';
  const trimmed = title.trim();
  if (trimmed.startsWith(prefix)) return trimmed;
  return `${prefix}${trimmed ? ` ${trimmed}` : ' '}`;
}

export function buildBugReportBody(draft: BugReportDraft, includeEvidence = true): string {
  const version = draft.appVersion.trim() || 'Not provided';
  const os = draft.operatingSystem.trim() || 'Not provided';
  const installMethod = draft.installMethod.trim() || 'Not provided';
  const agent = draft.agent.trim() || 'Not provided';
  const logs = draft.logs.trim();

  return [
    '## What happened',
    draft.whatHappened.trim(),
    '',
    '## What you expected',
    draft.whatExpected.trim(),
    '',
    '## Steps to reproduce',
    draft.reproductionSteps.trim(),
    '',
    '## Environment',
    `- **Ship Studio version:** ${version}`,
    `- **OS:** ${os}`,
    `- **Architecture:** ${draft.architecture.trim() || 'Not provided'}`,
    `- **Install method:** ${installMethod}`,
    `- **Agent (if relevant):** ${agent}`,
    '',
    '## Logs',
    logs ? fencedText(logs) : 'Not provided',
    '',
    ...(includeEvidence ? ['## Screenshots', draft.screenshots.trim() || 'Not provided', ''] : []),
    '## Anything else',
    draft.anythingElse.trim() || 'Not provided',
  ].join('\n');
}

export function buildFeatureRequestBody(
  draft: FeatureRequestDraft,
  includeEvidence = true
): string {
  return [
    '## What problem does this solve',
    draft.problem.trim(),
    '',
    '## Proposed solution',
    draft.proposedSolution.trim(),
    '',
    '## Alternatives considered',
    draft.alternatives.trim() || 'Not provided',
    '',
    '## Who benefits',
    draft.whoBenefits.trim(),
    '',
    ...(includeEvidence
      ? ['## Evidence links', draft.evidenceLinks.trim() || 'Not provided', '']
      : []),
    '## Anything else',
    draft.anythingElse.trim() || 'Not provided',
  ].join('\n');
}

export function hasRequiredBugDetails(draft: BugReportDraft): boolean {
  return Boolean(
    draft.title
      .trim()
      .replace(/^\[Bug\]\s*/, '')
      .trim() &&
    draft.whatHappened.trim() &&
    draft.whatExpected.trim() &&
    draft.reproductionSteps.trim()
  );
}

export function hasRequiredFeatureDetails(draft: FeatureRequestDraft): boolean {
  return Boolean(
    draft.title
      .trim()
      .replace(/^\[Feature\]\s*/, '')
      .trim() &&
    draft.problem.trim() &&
    draft.proposedSolution.trim() &&
    draft.whoBenefits.trim()
  );
}

export function issueHandoffUrl(
  kind: IssueKind,
  title: string,
  body: string,
  includeBody = true
): string {
  const url = new URL(`https://github.com/${ISSUE_REPO ?? ''}/issues/new`);
  url.searchParams.set('title', issueTitle(kind, title));
  if (includeBody) url.searchParams.set('body', body);
  url.searchParams.set('template', kind === 'bug' ? 'bug_report.md' : 'feature_request.md');
  url.searchParams.set('labels', kind === 'bug' ? 'bug' : 'enhancement');
  return url.toString();
}

function fencedText(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), ([run]) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}
