import { describe, expect, it, vi } from 'vitest';
import {
  buildBugReportBody,
  buildFeatureRequestBody,
  hasRequiredBugDetails,
  hasRequiredFeatureDetails,
  issueHandoffUrl,
  issueTitle,
  type BugReportDraft,
  type FeatureRequestDraft,
} from './issueReports';

// Features brand.json can switch off are tested switched on.
vi.mock('./brand', async (importOriginal) => {
  const { withAllLinks } = await import('../test/brandFixture');
  return withAllLinks(await importOriginal<typeof import('./brand')>());
});

const bugDraft: BugReportDraft = {
  title: '[Bug] Toolbar stops updating',
  whatHappened: 'The toolbar stopped updating.',
  whatExpected: 'The toolbar should update.',
  reproductionSteps: 'Open a project\nSwitch projects',
  appVersion: '1.4.0',
  operatingSystem: 'macOS',
  architecture: 'arm64',
  installMethod: '',
  agent: '',
  logs: 'line one\n```\nline three',
  screenshots: 'https://example.com/evidence',
  anythingElse: '',
};

const featureDraft: FeatureRequestDraft = {
  title: '[Feature] Search projects',
  problem: 'Finding a project takes too long.',
  proposedSolution: 'Add keyboard search.',
  alternatives: '',
  whoBenefits: 'People with many projects.',
  anythingElse: '',
  evidenceLinks: 'https://example.com/feature-mockup',
};

describe('issue report drafts', () => {
  it('requires substantive details beyond the template title prefix', () => {
    expect(
      hasRequiredBugDetails({
        ...bugDraft,
        title: '[Bug] ',
      })
    ).toBe(false);
    expect(hasRequiredBugDetails(bugDraft)).toBe(true);
    expect(
      hasRequiredFeatureDetails({
        ...featureDraft,
        title: '[Feature] ',
      })
    ).toBe(false);
    expect(hasRequiredFeatureDetails(featureDraft)).toBe(true);
  });

  it('keeps the canonical title prefixes and emits every bug template section', () => {
    expect(issueTitle('bug', 'Toolbar freezes')).toBe('[Bug] Toolbar freezes');
    expect(issueTitle('bug', '[Bug] Toolbar freezes')).toBe('[Bug] Toolbar freezes');

    const body = buildBugReportBody(bugDraft);
    for (const heading of [
      '## What happened',
      '## What you expected',
      '## Steps to reproduce',
      '## Environment',
      '## Logs',
      '## Screenshots',
      '## Anything else',
    ]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('**App version:** 1.4.0');
    expect(body).toContain('**OS:** macOS');
    expect(body).toContain('**Architecture:** arm64');
    expect(body).toContain('**Install method:** Not provided');
    expect(body).toContain('**Agent (if relevant):** Not provided');
    expect(body).toContain('````text\nline one\n```\nline three\n````');
    expect(body).toContain('https://example.com/evidence');
    const withoutEvidence = buildBugReportBody(bugDraft, false);
    expect(withoutEvidence).not.toContain('## Screenshots');
    expect(withoutEvidence).not.toContain('https://example.com/evidence');
  });

  it('keeps the canonical feature template sections and optional fields explicit', () => {
    expect(issueTitle('feature', 'Search projects')).toBe('[Feature] Search projects');
    const body = buildFeatureRequestBody(featureDraft);
    for (const heading of [
      '## What problem does this solve',
      '## Proposed solution',
      '## Alternatives considered',
      '## Who benefits',
      '## Evidence links',
      '## Anything else',
    ]) {
      expect(body).toContain(heading);
    }
    expect(body).toContain('## Alternatives considered\nNot provided');
    expect(body).toContain('## Anything else\nNot provided');
    expect(body).toContain('https://example.com/feature-mockup');
    const withoutEvidence = buildFeatureRequestBody(featureDraft, false);
    expect(withoutEvidence).not.toContain('## Evidence links');
    expect(withoutEvidence).not.toContain('https://example.com/feature-mockup');
  });
});

describe('issueHandoffUrl', () => {
  it('preserves title and body with the canonical template and label', () => {
    const url = new URL(issueHandoffUrl('bug', 'Toolbar freezes', 'Public body'));

    expect(url.origin + url.pathname).toBe('https://github.com/ship-studio/ship-studio/issues/new');
    expect(url.searchParams.get('title')).toBe('[Bug] Toolbar freezes');
    expect(url.searchParams.get('body')).toBe('Public body');
    expect(url.searchParams.get('template')).toBe('bug_report.md');
    expect(url.searchParams.get('labels')).toBe('bug');
  });

  it('can omit only the body for clipboard handoff while keeping the feature template', () => {
    const url = new URL(issueHandoffUrl('feature', 'Search', 'Long body', false));

    expect(url.searchParams.get('title')).toBe('[Feature] Search');
    expect(url.searchParams.has('body')).toBe(false);
    expect(url.searchParams.get('template')).toBe('feature_request.md');
    expect(url.searchParams.get('labels')).toBe('enhancement');
  });
});
