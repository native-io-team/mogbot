import { useEffect, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModalProvider, useModal, type ModalId } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import type { BugReportDraft, IssueReportContext } from '../../lib/issueReports';
import { readIssueReportDraft, saveIssueReportDraft } from '../../lib/issueReportDrafts';
import { IssueReportModals } from './IssueReportModals';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { openUrl } from '@tauri-apps/plugin-opener';

// Features brand.json can switch off are tested switched on.
vi.mock('../../lib/brand', async (importOriginal) => {
  const { withAllLinks } = await import('../../test/brandFixture');
  return withAllLinks(await importOriginal<typeof import('../../lib/brand')>());
});

const acceptedReceipt = {
  timestamp: new Date(Date.now() - 120_000).toISOString(),
  kind: 'error',
  source: 'frontend-log',
  summary: 'Preview failed to load after switching projects.',
  issueUrl: 'https://github.com/ship-studio/ship-studio/issues/16',
};

const reportContext: IssueReportContext = {
  appVersion: '1.4.0',
  operatingSystem: 'macOS',
  architecture: 'arm64',
  defaultAgent: 'Codex',
};

const savedBugDraft: BugReportDraft = {
  title: '[Bug] Saved toolbar issue',
  whatHappened: 'A saved report detail.',
  whatExpected: 'The saved expected result.',
  reproductionSteps: 'Open saved project',
  appVersion: '0.9.0',
  operatingSystem: 'Linux',
  architecture: 'x86_64',
  installMethod: 'AppImage',
  agent: 'Claude Code',
  logs: 'Saved log detail.',
  screenshots: '',
  anythingElse: 'Saved note.',
};

function OpenReport({ id, children }: { id: ModalId; children: ReactNode }) {
  const { open } = useModal(id);
  useEffect(() => {
    open();
  }, [open]);
  return <>{children}</>;
}

function renderReport(id: ModalId = 'bugReport') {
  return render(
    <ModalProvider>
      <PaletteContextProvider>
        <OpenReport id={id}>
          <IssueReportModals />
        </OpenReport>
      </PaletteContextProvider>
    </ModalProvider>
  );
}

function mockReportCommands({
  login = 'ship-user',
  status = { enabled: false, configured: false, reason: 'development_build', receipts: [] },
  context = reportContext,
  submit,
}: {
  login?: string | Error;
  status?: unknown;
  context?: IssueReportContext | Promise<IssueReportContext>;
  submit?: (args: Record<string, unknown>) => unknown;
} = {}) {
  mockIPC((command, args) => {
    if (command === 'get_issue_report_context') return context;
    if (command === 'get_automatic_report_status') {
      if (status instanceof Error) throw status;
      return status;
    }
    if (command === 'get_github_username') {
      if (login instanceof Error) throw login;
      return login;
    }
    if (command === 'submit_github_issue') {
      if (!submit) throw new Error('Unexpected issue submission');
      return submit(args as Record<string, unknown>);
    }
    throw new Error(`Unexpected Tauri command: ${command}`);
  });
}

function completeRequiredBugDetails() {
  fireEvent.change(screen.getByLabelText(/Title/), {
    target: { value: '[Bug] Toolbar stops updating' },
  });
  fireEvent.change(screen.getByLabelText(/What happened\?/), {
    target: { value: 'The preview toolbar stops updating after switching projects.' },
  });
  fireEvent.change(screen.getByLabelText(/What did you expect\?/), {
    target: { value: 'The toolbar should reflect the active project.' },
  });
  fireEvent.change(screen.getByLabelText(/Steps to reproduce/), {
    target: { value: 'Open two projects\nSwitch to the second project\nCheck the toolbar' },
  });
}

async function openEvidencePage(choice: 'upload' | 'links' | 'none') {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
  expect(readIssueReportDraft('bug')).toMatchObject({ status: 'saved' });
  fireEvent.click(document.querySelector(`[data-evidence-choice="${choice}"]`)!);
}

async function openReview(choice: 'links' | 'none') {
  await openEvidencePage(choice);
  fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));
  expect(await screen.findByLabelText('Public issue preview')).toBeInTheDocument();
}

async function openBugForm() {
  expect(await screen.findByLabelText(/Title/)).toHaveValue('[Bug] ');
  expect(screen.getByLabelText('Issue type')).toHaveValue('bug');
  expect(document.querySelector('[data-issue-surface="form"]')).toBeInTheDocument();
}

describe('IssueReportModals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('keeps security reports private and shows accepted receipts as soon as the bug form opens', async () => {
    const recentReceipt = {
      timestamp: new Date().toISOString(),
      kind: 'crash',
      source: 'frontend-crash',
      summary: 'The editor closed unexpectedly.',
      issueUrl: 'https://github.com/ship-studio/ship-studio/issues/17',
    };
    mockReportCommands({
      status: {
        enabled: true,
        configured: true,
        reason: null,
        receipts: [acceptedReceipt, recentReceipt],
      },
    });
    renderReport();

    await openBugForm();
    const reports = screen.getByRole('region', { name: 'Recent app reports' });
    expect(reports).toHaveTextContent(/Latest confirmed crash receipt/);
    const details = within(reports).getByRole('button', { name: 'Details' });
    const summaryRow = reports.querySelector<HTMLElement>(
      '.issue-report__automatic-reports-summary'
    )!;
    const detailsPanel = document.getElementById(details.getAttribute('aria-controls')!);
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(summaryRow).toContainElement(details);
    expect(detailsPanel).not.toBeVisible();
    expect(
      within(reports).getByText('Preview failed to load after switching projects.')
    ).not.toBeVisible();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(summaryRow).toContainElement(details);
    expect(detailsPanel).toBeVisible();
    expect(
      within(reports).getByText(/Check whether a recent report covers this same incident/i)
    ).toBeInTheDocument();
    expect(
      within(reports).getByText('Preview failed to load after switching projects.')
    ).toBeInTheDocument();
    expect(within(reports).getByText('The editor closed unexpectedly.')).toBeInTheDocument();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(summaryRow).toContainElement(details);
    expect(detailsPanel).not.toBeVisible();
    fireEvent.click(details);
    const issueLinks = within(reports).getAllByRole('button', { name: /Issue filed/ });
    expect(issueLinks).toHaveLength(2);
    fireEvent.click(issueLinks[0]);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(acceptedReceipt.issueUrl));
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toHaveAttribute(
      'data-issue-action',
      'github-handoff'
    );
    fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: 'security' } });
    expect(
      await screen.findByText(/Security vulnerabilities must be reported privately/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/will never create a public issue/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open private security advisory' })).toBeEnabled();
    const privateHeaderAction = screen.getByRole('button', { name: 'Report on GitHub' });
    expect(privateHeaderAction).toHaveAttribute('data-issue-action', 'contact-security-header');
    expect(privateHeaderAction).toHaveClass('text-button');
    expect(
      privateHeaderAction.querySelector('[data-icon-name="ExternalLinkIcon"]')
    ).toBeInTheDocument();
    expect(document.querySelector('[data-issue-action="github-handoff"]')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review public post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit issue' })).not.toBeInTheDocument();
    fireEvent.click(privateHeaderAction);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        'https://github.com/ship-studio/ship-studio/security/advisories/new'
      )
    );

    fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: 'bug' } });
    await openBugForm();
    expect(screen.getByRole('region', { name: 'Recent app reports' })).toHaveTextContent(
      'Preview failed to load after switching projects.'
    );
    expect(
      screen.getByText(/Check whether a recent report covers this same incident/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Unrelated issues are welcome/i)).toBeInTheDocument();
  });

  it('hides the issue selector until a saved draft is resolved and keeps the empty-receipt state honest', async () => {
    saveIssueReportDraft('bug', savedBugDraft, 'none');
    let resolveStatus!: (value: unknown) => void;
    const status = new Promise((resolve) => {
      resolveStatus = resolve;
    });
    mockReportCommands({ status });
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    expect(screen.queryByLabelText('Issue type')).not.toBeInTheDocument();
    const reports = screen.getByRole('region', { name: 'Recent app reports' });
    expect(reports).toHaveTextContent('Checking recent app reports');

    resolveStatus({ enabled: true, configured: true, reason: null, receipts: [] });
    await waitFor(() => expect(reports).toHaveTextContent('No recent confirmed receipts'));
    fireEvent.click(within(reports).getByText('Details'));
    expect(
      within(reports).getByText(/This list does not describe every report ever sent/i)
    ).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-issue-action="restore-draft"]')!);
    expect(await screen.findByLabelText('Issue type')).toHaveValue('bug');
    expect(screen.getByLabelText(/Title/)).toHaveValue(savedBugDraft.title);
  });

  it('offers only a safe fresh start for invalid drafts and explains disabled report status in details', async () => {
    localStorage.setItem('shipstudio.issueReportDraft.v1.bug', '{broken snapshot');
    mockReportCommands();
    renderReport();

    expect(await screen.findByText('Saved draft needs attention')).toBeInTheDocument();
    expect(screen.queryByLabelText('Issue type')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore draft' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-issue-action="discard-saved-draft"]')).toBeInTheDocument();

    const reports = screen.getByRole('region', { name: 'Recent app reports' });
    expect(reports).toHaveTextContent('Disabled in development');
    fireEvent.click(within(reports).getByText('Details'));
    expect(
      within(reports).getByText(/Automatic reports are disabled in development builds/i)
    ).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-issue-action="discard-saved-draft"]')!);
    expect(await screen.findByLabelText('Issue type')).toHaveValue('bug');
    expect(screen.getByLabelText(/Title/)).toHaveValue('[Bug] ');
  });

  it('shows receipt-status failures in the compact summary and expanded details', async () => {
    mockReportCommands({ status: new Error('receipt lookup failed') });
    renderReport();
    await openBugForm();

    const reports = screen.getByRole('region', { name: 'Recent app reports' });
    expect(reports).toHaveTextContent('Couldn’t load recent reports');
    expect(within(reports).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(within(reports).getByText('Details'));
    expect(await within(reports).findByRole('alert')).toHaveTextContent('receipt lookup failed');
  });

  it('opens the feature modal directly on its feature form', async () => {
    mockReportCommands();
    renderReport('featureRequest');

    expect(await screen.findByLabelText('Issue type')).toHaveValue('feature');
    expect(screen.getByLabelText(/Title/)).toHaveValue('[Feature] ');
    expect(document.querySelector('[data-issue-surface="feature-form"]')).toBeInTheDocument();
    expect(document.querySelector('[data-issue-surface="bug-form"]')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report a bug/ })).not.toBeInTheDocument();
  });

  it('saves a partial draft before the header opens the public GitHub form', async () => {
    const submit = vi.fn();
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    vi.mocked(openUrl).mockClear();

    const reportOnGitHub = screen.getByRole('button', { name: 'Report on GitHub' });
    expect(document.querySelector('.modal-frame-header-actions')).toContainElement(reportOnGitHub);
    expect(reportOnGitHub).toHaveClass('text-button');
    expect(reportOnGitHub.querySelector('[data-icon-name="ExternalLinkIcon"]')).toBeInTheDocument();
    fireEvent.click(reportOnGitHub);

    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    expect(readIssueReportDraft('bug')).toMatchObject({ status: 'saved' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('preserves bug and feature drafts while switching issue types', async () => {
    mockReportCommands();
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();

    fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: 'feature' } });
    expect(await screen.findByLabelText(/Title/)).toHaveValue('[Feature] ');
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: '[Feature] Add keyboard shortcuts' },
    });
    fireEvent.change(screen.getByLabelText(/What problem does this solve\?/), {
      target: { value: 'Keyboard users need a faster way to switch projects.' },
    });
    fireEvent.change(screen.getByLabelText(/Proposed solution/), {
      target: { value: 'Add configurable project switching shortcuts.' },
    });
    fireEvent.change(screen.getByLabelText(/Who benefits\?/), {
      target: { value: 'People who navigate with a keyboard.' },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: 'bug' } });
    expect(await screen.findByLabelText(/Title/)).toHaveValue('[Bug] Toolbar stops updating');
    expect(screen.getByLabelText(/What happened\?/)).toHaveValue(
      'The preview toolbar stops updating after switching projects.'
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: 'feature' } });
    expect(await screen.findByLabelText(/Title/)).toHaveValue('[Feature] Add keyboard shortcuts');
    expect(screen.getByLabelText(/What problem does this solve\?/)).toHaveValue(
      'Keyboard users need a faster way to switch projects.'
    );
    expect(screen.getByLabelText(/Proposed solution/)).toHaveValue(
      'Add configurable project switching shortcuts.'
    );
  });

  it('keeps discussion and community routes outside public issue submission', async () => {
    mockReportCommands();
    renderReport();
    await openBugForm();

    const routes = [
      {
        type: 'discussion',
        guidance: /Open GitHub Discussions to ask a question or start a conversation/i,
        action: 'Open GitHub Discussions',
        url: 'https://github.com/ship-studio/ship-studio/discussions',
      },
      {
        type: 'slack',
        guidance: /Join the community for help and discussion/i,
        action: 'Open community Slack',
        url: 'https://ship.studio/slack',
      },
    ] as const;

    for (const route of routes) {
      fireEvent.change(screen.getByLabelText('Issue type'), { target: { value: route.type } });
      expect(await screen.findByText(route.guidance)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Review public post' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Submit issue' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: route.action }));
      await waitFor(() => expect(openUrl).toHaveBeenCalledWith(route.url));
      vi.mocked(openUrl).mockClear();
    }
  });

  it('requires the report details and gates direct submission on a confirmed account', async () => {
    mockReportCommands({ login: new Error('Not authenticated with github') });
    renderReport();
    await openBugForm();

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/What happened\?/), {
      target: { value: 'The preview toolbar stops updating after switching projects.' },
    });
    fireEvent.change(screen.getByLabelText(/What did you expect\?/), {
      target: { value: 'The toolbar should reflect the active project.' },
    });
    fireEvent.change(screen.getByLabelText(/Steps to reproduce/), {
      target: { value: 'Open two projects\nSwitch to the second project\nCheck the toolbar' },
    });
    expect(continueButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: '[Bug] Toolbar stops updating' },
    });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /No images or links/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));

    const submit = await screen.findByRole('button', { name: 'Submit issue' });
    expect(submit).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/authenticated GitHub CLI account/i);
  });

  it('submits the reviewed payload and opens the URL returned by GitHub', async () => {
    const submit = vi.fn((_args: Record<string, unknown>) => ({
      status: 'created',
      number: 42,
      issueUrl: 'https://github.com/ship-studio/ship-studio/issues/42',
      login: 'ship-user',
    }));
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();
    fireEvent.change(screen.getByLabelText(/Logs \(optional\)/), {
      target: { value: 'Selected log line: preview refresh failed.' },
    });
    await openEvidencePage('links');
    fireEvent.change(screen.getByLabelText(/Evidence links/), {
      target: { value: 'https://example.test/preview.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));
    expect(await screen.findByLabelText('Public issue preview')).toHaveTextContent(
      'https://example.test/preview.png'
    );

    expect(
      screen.getByText(/The browser may be signed into a different GitHub account/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeInTheDocument();
    const reviewFooter = document.querySelector('.issue-report__actions--split')!;
    expect(reviewFooter.querySelectorAll('button')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Back to evidence' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit issue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit evidence' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fill out on GitHub' })).not.toBeInTheDocument();
    const reportOnGitHub = screen.getByRole('button', { name: 'Report on GitHub' });
    expect(document.querySelector('.modal-frame-header-actions')).toContainElement(reportOnGitHub);
    fireEvent.click(reportOnGitHub);
    await waitFor(() => expect(openUrl).toHaveBeenCalled());
    const handoffUrl = new URL(String(vi.mocked(openUrl).mock.calls[0]?.[0]));
    expect(handoffUrl.searchParams.get('title')).toBe('[Bug] Toolbar stops updating');
    expect(handoffUrl.searchParams.get('body')).toContain(
      'Selected log line: preview refresh failed.'
    );
    expect(handoffUrl.searchParams.get('body')).toContain('https://example.test/preview.png');
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to evidence' }));
    expect(screen.getByRole('radio', { name: /Add evidence links/ })).toBeChecked();
    expect(screen.getByDisplayValue('https://example.test/preview.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /No images or links/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));
    expect(await screen.findByLabelText('Public issue preview')).not.toHaveTextContent(
      'https://example.test/preview.png'
    );
    expect(screen.getByLabelText('Public issue preview')).not.toHaveTextContent('## Screenshots');
    const submitButton = await screen.findByRole('button', { name: 'Submit issue' });
    expect(submitButton.querySelector('[data-icon-name="PushIcon"]')).toBeInTheDocument();
    fireEvent.click(submitButton);

    expect(await screen.findByText('Issue #42 was created')).toBeInTheDocument();
    const submittedArgs = submit.mock.calls[0]?.[0];
    expect(submittedArgs).toMatchObject({
      kind: 'bug',
      title: '[Bug] Toolbar stops updating',
      projectPath: null,
      expectedLogin: 'ship-user',
    });
    expect(submittedArgs?.body).toContain(
      'The preview toolbar stops updating after switching projects.'
    );
    expect(submittedArgs?.body).toContain('Selected log line: preview refresh failed.');
    expect(submittedArgs?.body).not.toContain('https://example.test/preview.png');
    vi.mocked(openUrl).mockClear();
    const openIssue = screen.getByRole('button', { name: 'Open issue' });
    expect(openIssue).toHaveAttribute('data-issue-action', 'header-open-issue');
    expect(document.querySelector('.modal-frame-header-actions')).toContainElement(openIssue);
    fireEvent.click(openIssue);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith('https://github.com/ship-studio/ship-studio/issues/42')
    );
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(readIssueReportDraft('bug')).toEqual({ status: 'empty' });
  });

  it('edits the complete Markdown body, keeps Cancel changes local, and submits the saved text', async () => {
    const submit = vi.fn((_args: Record<string, unknown>) => ({
      status: 'created',
      number: 43,
      issueUrl: 'https://github.com/ship-studio/ship-studio/issues/43',
      login: 'ship-user',
    }));
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();
    await openReview('none');

    const preview = screen.getByLabelText('Public issue preview');
    const originalBody = preview.querySelector('pre')?.textContent ?? '';
    const reportTitle = preview.querySelector('h3')?.textContent;
    expect(originalBody).not.toBe('');
    expect(reportTitle).toBe('[Bug] Toolbar stops updating');

    fireEvent.click(preview.querySelector('[data-issue-action="edit-report-body"]')!);
    const bodyEditor = screen.getByRole('textbox', { name: 'Report body' });
    expect(preview).toContainElement(bodyEditor);
    expect(preview.querySelector('h3')).toHaveTextContent(reportTitle ?? '');
    expect(screen.getByRole('button', { name: 'Submit issue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeDisabled();
    fireEvent.change(bodyEditor, { target: { value: 'Unsaved body that should be discarded.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(preview.querySelector('pre')?.textContent).toBe(originalBody);
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: { editedBody: null },
    });
    expect(submit).not.toHaveBeenCalled();

    const customBody = '## Custom Markdown\n\n**Exact edited report body.**\n';
    fireEvent.click(preview.querySelector('[data-issue-action="edit-report-body"]')!);
    fireEvent.change(screen.getByRole('textbox', { name: 'Report body' }), {
      target: { value: customBody },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }));

    expect(preview.querySelector('pre')?.textContent).toBe(customBody);
    expect(preview.querySelector('h3')).toHaveTextContent(reportTitle ?? '');
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: { editedBody: customBody },
    });

    vi.mocked(openUrl).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Report on GitHub' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    const handoffUrl = new URL(String(vi.mocked(openUrl).mock.calls[0]?.[0]));
    expect(handoffUrl.searchParams.get('body')).toBe(customBody);
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Submit issue' }));
    expect(await screen.findByText('Issue #43 was created')).toBeInTheDocument();
    expect(submit.mock.calls[0]?.[0].body).toBe(customBody);
  });

  it('restores a custom body through structured edits until the user reverts it', async () => {
    const customBody = '## Saved Markdown\n\nKeep this text intact.';
    saveIssueReportDraft('bug', savedBugDraft, 'none', customBody);
    mockReportCommands();
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    const restoreChoice = document.querySelector<HTMLButtonElement>(
      '[data-issue-action="restore-draft"]'
    )!;
    const startNewChoice = document.querySelector<HTMLButtonElement>(
      '[data-issue-action="discard-saved-draft"]'
    )!;
    expect(restoreChoice).toHaveClass('issue-report__draft-choice-card');
    expect(startNewChoice).toHaveClass('issue-report__draft-choice-card');
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeDisabled();
    expect(
      screen.queryByText(/Restore or discard the saved draft before opening GitHub/)
    ).toBeNull();
    fireEvent.click(restoreChoice);
    expect(await screen.findByLabelText(/Title/)).toHaveValue(savedBugDraft.title);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));

    let preview = await screen.findByLabelText('Public issue preview');
    expect(preview.querySelector('pre')?.textContent).toBe(customBody);
    fireEvent.click(screen.getByRole('button', { name: 'Back to evidence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to report details' }));
    fireEvent.change(screen.getByLabelText(/What happened\?/), {
      target: { value: 'The structured report details changed after restoration.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));

    preview = await screen.findByLabelText('Public issue preview');
    expect(preview.querySelector('pre')?.textContent).toBe(customBody);
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: {
        editedBody: customBody,
        draft: { whatHappened: 'The structured report details changed after restoration.' },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use generated report text' }));
    expect(preview.querySelector('pre')).toHaveTextContent(
      'The structured report details changed after restoration.'
    );
    expect(preview.querySelector('pre')?.textContent).not.toBe(customBody);
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: { editedBody: null },
    });
    expect(
      screen.queryByRole('button', { name: 'Use generated report text' })
    ).not.toBeInTheDocument();
  });

  it('blocks an empty or oversized edited body from handoff and submission', async () => {
    const submit = vi.fn();
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();
    await openReview('none');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const bodyEditor = screen.getByRole('textbox', { name: 'Report body' });
    const submitButton = screen.getByRole('button', { name: 'Submit issue' });
    const handoffButton = screen.getByRole('button', { name: 'Report on GitHub' });
    expect(submitButton).toBeDisabled();
    expect(handoffButton).toBeDisabled();

    fireEvent.change(bodyEditor, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/body can’t be empty/i);
    expect(submitButton).toBeDisabled();
    expect(handoffButton).toBeDisabled();

    fireEvent.change(bodyEditor, { target: { value: 'x'.repeat(65_537) } });
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/65,536 characters or fewer/i);
    expect(submitButton).toBeDisabled();
    expect(handoffButton).toBeDisabled();
    fireEvent.click(submitButton);
    fireEvent.click(handoffButton);
    expect(submit).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('keeps required copy accessible and Continue saves locally without submitting', async () => {
    const submit = vi.fn();
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();

    for (const fieldName of ['title', 'what-happened', 'what-expected', 'steps']) {
      const field = document.querySelector<HTMLElement>(`[data-issue-field="${fieldName}"]`)!;
      const row = field.closest<HTMLElement>('.issue-report__field')!;
      const heading = row.querySelector<HTMLElement>('.issue-report__field-heading')!;
      const description = row.querySelector<HTMLElement>('.issue-report__field-description')!;
      expect(field).toHaveAttribute('required');
      expect(field).toHaveAttribute('aria-required', 'true');
      expect(field).toHaveAttribute('aria-describedby', description.id);
      expect(description).toHaveTextContent(/^Required\./);
      expect(heading).toContainElement(description);
      expect(
        heading.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    const environmentGrid = document.querySelector<HTMLElement>('.issue-report__environment-grid')!;
    const environmentPairs = Array.from(
      environmentGrid.querySelectorAll<HTMLElement>('.issue-report__environment-pair')
    );
    expect(environmentPairs).toHaveLength(2);
    for (const [pair, fields] of [
      [environmentPairs[0], ['app-version', 'operating-system']],
      [environmentPairs[1], ['architecture', 'agent']],
    ] as const) {
      for (const fieldName of fields) {
        const field = document.querySelector<HTMLElement>(`[data-issue-field="${fieldName}"]`)!;
        expect(pair).toContainElement(field);
        expect(field.tagName).toBe('INPUT');
      }
    }
    const installField = environmentGrid.querySelector<HTMLElement>(
      '[data-issue-field="install-method"]'
    )!;
    expect(installField.closest('.issue-report__environment-pair')).toBeNull();

    expect(await screen.findByText('Draft saved on this device.')).toBeInTheDocument();
    const footer = document.querySelector<HTMLElement>('.issue-report__form-footer')!;
    const draftStatus = document.querySelector<HTMLElement>('.issue-report__draft-status')!;
    const discard = screen.getByRole('button', { name: 'Discard draft' });
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(footer).toContainElement(draftStatus);
    expect(footer).toContainElement(discard);
    expect(footer).toContainElement(continueButton);
    const actionGroup = footer.querySelector('.issue-report__action-group')!;
    expect(actionGroup).toContainElement(discard);
    expect(actionGroup).toContainElement(continueButton);
    expect(
      discard.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(continueButton.querySelector('[data-icon-name="ArrowRightIcon"]')).toBeInTheDocument();

    fireEvent.click(continueButton);
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'none',
      'links',
      'upload',
    ]);
    expect(new Set(radios.map((radio) => (radio as HTMLInputElement).name)).size).toBe(1);
    const noEvidence = screen.getByRole('radio', { name: /No images or links/ });
    expect(noEvidence).toBeChecked();
    expect(noEvidence).toHaveClass('issue-report__evidence-input');
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeInTheDocument();
    const backToDetails = screen.getByRole('button', { name: 'Back to report details' });
    expect(backToDetails).toHaveAttribute('data-issue-action', 'evidence-back');
    expect(backToDetails.querySelector('[data-icon-name="ArrowLeftIcon"]')).toBeInTheDocument();
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: {
        evidenceChoice: 'none',
        draft: {
          title: '[Bug] Toolbar stops updating',
          whatHappened: 'The preview toolbar stops updating after switching projects.',
        },
      },
    });

    const user = userEvent.setup();
    (noEvidence as HTMLInputElement).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Add evidence links/ })).toBeChecked();
    const reviewEvidence = screen.getByRole('button', { name: 'Review public issue' });
    expect(reviewEvidence).toHaveAttribute('data-issue-action', 'evidence-next');
    expect(reviewEvidence.querySelector('[data-icon-name="ArrowRightIcon"]')).toBeInTheDocument();

    fireEvent.click(backToDetails);
    expect(await screen.findByLabelText('Title')).toHaveValue('[Bug] Toolbar stops updating');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Add evidence links/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /No images or links/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));
    expect(await screen.findByLabelText('Public issue preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeInTheDocument();
    const reviewFooter = document.querySelector('.issue-report__actions--split')!;
    expect(reviewFooter.querySelectorAll('button')).toHaveLength(2);
    const reviewBack = screen.getByRole('button', { name: 'Back to evidence' });
    expect(reviewBack).toHaveAttribute('data-issue-action', 'review-back');
    expect(reviewBack.querySelector('[data-icon-name="ArrowLeftIcon"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fill out on GitHub' })).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the entered draft after an uncertain submission result', async () => {
    const submit = vi.fn(() => ({
      status: 'uncertain',
      login: 'ship-user',
      message:
        "GitHub didn't confirm whether it created this issue. Check the issue list before retrying.",
      issueListUrl: 'https://github.com/ship-studio/ship-studio/issues',
    }));
    mockReportCommands({
      submit,
    });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();
    await openReview('none');
    fireEvent.click(await screen.findByRole('button', { name: 'Submit issue' }));

    expect(await screen.findByText('GitHub did not confirm the result')).toBeInTheDocument();
    const checkIssues = screen.getByRole('button', { name: 'Check GitHub issues' });
    expect(checkIssues).toHaveAttribute('data-issue-action', 'header-check-issues');
    expect(document.querySelector('.modal-frame-header-actions')).toContainElement(checkIssues);
    expect(screen.queryByRole('button', { name: 'Report on GitHub' })).not.toBeInTheDocument();
    fireEvent.click(checkIssues);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith('https://github.com/ship-studio/ship-studio/issues')
    );
    expect(submit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'I checked — review draft' }));
    expect(await screen.findByDisplayValue('[Bug] Toolbar stops updating')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('The preview toolbar stops updating after switching projects.')
    ).toBeInTheDocument();
  });

  it('restores a saved bug draft without replacing its environment when context resolves later', async () => {
    let resolveContext!: (context: IssueReportContext) => void;
    const delayedContext = new Promise<IssueReportContext>((resolve) => {
      resolveContext = resolve;
    });
    saveIssueReportDraft('bug', savedBugDraft, 'links');
    mockReportCommands({ context: delayedContext });
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeDisabled();
    expect(
      screen.queryByText(/Restore or discard the saved draft before opening GitHub/)
    ).toBeNull();
    fireEvent.click(document.querySelector('[data-issue-action="restore-draft"]')!);
    expect(await screen.findByLabelText(/Title/)).toHaveValue(savedBugDraft.title);
    resolveContext(reportContext);

    await waitFor(() => {
      expect(screen.getByLabelText('Ship Studio version')).toHaveValue('0.9.0');
      expect(screen.getByLabelText('Architecture')).toHaveValue('x86_64');
      expect(screen.getByLabelText('Agent (if relevant)')).toHaveValue('Claude Code');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Add evidence links/ })).toBeChecked();
  });

  it('discards a saved draft and hydrates fresh app context', async () => {
    saveIssueReportDraft('bug', savedBugDraft, 'links');
    saveIssueReportDraft(
      'feature',
      {
        title: '[Feature] Keep this unrelated draft',
        problem: 'Feature draft problem.',
        proposedSolution: 'Feature draft solution.',
        alternatives: '',
        whoBenefits: 'Feature draft users.',
        anythingElse: '',
        evidenceLinks: '',
      },
      'none'
    );
    mockReportCommands();
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-issue-action="discard-saved-draft"]')!);
    expect(await screen.findByLabelText(/Title/)).toHaveValue('[Bug] ');
    await waitFor(() => {
      expect(screen.getByLabelText('Ship Studio version')).toHaveValue('1.4.0');
      expect(screen.getByLabelText('Architecture')).toHaveValue('arm64');
      expect(screen.getByLabelText('Agent (if relevant)')).toHaveValue('Codex');
    });
    expect(readIssueReportDraft('bug')).toEqual({ status: 'empty' });
    expect(readIssueReportDraft('feature')).toMatchObject({
      status: 'saved',
      snapshot: { draft: { title: '[Feature] Keep this unrelated draft' } },
    });
  });

  it('keeps a saved draft restorable when starting fresh cannot clear storage', async () => {
    const customBody = 'Custom saved issue body';
    saveIssueReportDraft('bug', savedBugDraft, 'links', customBody);
    mockReportCommands();
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    fireEvent.click(document.querySelector('[data-issue-action="discard-saved-draft"]')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/saved draft is still here/i);
    expect(screen.getByText('Continue your report')).toBeInTheDocument();
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: { draft: savedBugDraft, evidenceChoice: 'links', editedBody: customBody },
    });

    fireEvent.click(document.querySelector('[data-issue-action="restore-draft"]')!);
    expect(await screen.findByLabelText(/Title/)).toHaveValue(savedBugDraft.title);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Choose whether to add evidence/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Add evidence links/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Review public issue' }));
    expect(await screen.findByLabelText('Public issue preview')).toHaveTextContent(customBody);
  });

  it('cancels an in-flight autosave when discarding an edited saved draft', async () => {
    saveIssueReportDraft('bug', savedBugDraft, 'links');
    mockReportCommands();
    renderReport();

    expect(await screen.findByText('Continue your report')).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-issue-action="restore-draft"]')!);
    expect(await screen.findByLabelText(/Title/)).toHaveValue(savedBugDraft.title);
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: '[Bug] New unsaved edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(readIssueReportDraft('bug')).toEqual({ status: 'empty' });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(readIssueReportDraft('bug')).toEqual({ status: 'empty' });
    expect(screen.getByLabelText(/Title/)).toHaveValue('[Bug] ');
  });

  it('saves before opening GitHub for image uploads and never submits in the app', async () => {
    const submit = vi.fn();
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();
    await openEvidencePage('upload');
    vi.mocked(openUrl).mockClear();

    expect(screen.getByRole('button', { name: 'Report on GitHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish report on GitHub' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
    const handoffUrl = new URL(String(vi.mocked(openUrl).mock.calls[0]?.[0]));
    expect(handoffUrl.searchParams.get('title')).toBe('[Bug] Toolbar stops updating');
    expect(readIssueReportDraft('bug')).toMatchObject({
      status: 'saved',
      snapshot: { evidenceChoice: 'upload' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks review, GitHub handoff, and close when the device cannot save the draft', async () => {
    const submit = vi.fn();
    mockReportCommands({ submit });
    renderReport();
    await openBugForm();
    completeRequiredBugDetails();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
    expect(screen.getByText(/Check browser storage settings and try again/i)).toBeInTheDocument();
    expect(document.querySelector('.issue-report__header-actions [role="alert"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review public issue' })).not.toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Close without saving latest changes' })
    ).toBeInTheDocument();
  });
});
