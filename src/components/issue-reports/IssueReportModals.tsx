import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useModal } from '../../contexts/ModalContext';
import { usePaletteContext } from '../CommandPalette/paletteContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { usePolling } from '../../hooks/usePolling';
import {
  getAutomaticReportStatus,
  type AutomaticReportReceipt,
  type AutomaticReportStatus,
} from '../../lib/autoReports';
import { getGitHubUsername } from '../../lib/github';
import {
  buildBugReportBody,
  buildFeatureRequestBody,
  hasRequiredBugDetails,
  hasRequiredFeatureDetails,
  issueHandoffUrl,
  issueTitle,
  getIssueReportContext,
  submitGitHubIssue,
  type BugReportDraft,
  type FeatureRequestDraft,
  type IssueKind,
  type SubmitGitHubIssueArgs,
  type SubmitGitHubIssueResult,
} from '../../lib/issueReports';
import {
  clearIssueReportDraft,
  readIssueReportDraft,
  saveIssueReportDraft,
  type IssueEvidenceChoice,
  type IssueReportDraftRead,
} from '../../lib/issueReportDrafts';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  PlusIcon,
  PushIcon,
  UndoIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import '../../styles/features/issue-reports.css';
import { BRAND_LINKS } from '../../lib/brand';
import { ISSUE_REPO } from '../../lib/issueReports';

// Each is nullable in brand.json; a null route isn't offered.
const SECURITY_URL = BRAND_LINKS.securityAdvisories;
const DISCUSSIONS_URL = BRAND_LINKS.discussions;
const SLACK_URL = BRAND_LINKS.community;

type IssueModalStep = 'form' | 'evidence' | 'review' | 'success' | 'uncertain';
type IssueReportSelection = IssueKind | 'security' | 'discussion' | 'slack';
type DraftWriteState = 'idle' | 'saving' | 'saved' | 'error';

const contactRoutes = {
  security: {
    title: 'Security vulnerability',
    description:
      'Security vulnerabilities must be reported privately. This path opens GitHub’s private security advisory form and will never create a public issue.',
    action: 'Open private security advisory',
    url: SECURITY_URL,
  },
  discussion: {
    title: 'Question or discussion',
    description: 'Open GitHub Discussions to ask a question or start a conversation.',
    action: 'Open GitHub Discussions',
    url: DISCUSSIONS_URL,
  },
  slack: {
    title: 'Community Slack',
    description: 'Join the community for help and discussion.',
    action: 'Open community Slack',
    url: SLACK_URL,
  },
} as const;

type ContactSelection = keyof typeof contactRoutes;

function contactUrl(selection: ContactSelection): string {
  return contactRoutes[selection].url ?? '';
}

const emptyBugDraft: BugReportDraft = {
  title: '[Bug] ',
  whatHappened: '',
  whatExpected: '',
  reproductionSteps: '',
  appVersion: '',
  operatingSystem: '',
  architecture: '',
  installMethod: '',
  agent: '',
  logs: '',
  screenshots: '',
  anythingElse: '',
};

const emptyFeatureDraft: FeatureRequestDraft = {
  title: '[Feature] ',
  problem: '',
  proposedSolution: '',
  alternatives: '',
  whoBenefits: '',
  anythingElse: '',
  evidenceLinks: '',
};

const MAX_ISSUE_BODY_CHARS = 65_536;

export function IssueReportModals() {
  const bugReport = useModal('bugReport');
  const featureRequest = useModal('featureRequest');

  return (
    <>
      {bugReport.isOpen && <PublicIssueModal initialKind="bug" onClose={bugReport.close} />}
      {featureRequest.isOpen && (
        <PublicIssueModal initialKind="feature" onClose={featureRequest.close} />
      )}
    </>
  );
}

function PublicIssueModal({
  initialKind,
  onClose,
}: {
  initialKind: IssueKind;
  onClose: () => void;
}) {
  const { currentProjectPath } = usePaletteContext();
  const [step, setStep] = useState<IssueModalStep>('form');
  const [selectedKind, setSelectedKind] = useState<IssueReportSelection>(initialKind);
  const [bugDraft, setBugDraft] = useState<BugReportDraft>(emptyBugDraft);
  const [featureDraft, setFeatureDraft] = useState<FeatureRequestDraft>(emptyFeatureDraft);
  const [initialDraftReads] = useState<Record<IssueKind, IssueReportDraftRead>>(() => ({
    bug: readIssueReportDraft('bug'),
    feature: readIssueReportDraft('feature'),
  }));
  const [storedDrafts, setStoredDrafts] = useState(initialDraftReads);
  const [draftReady, setDraftReady] = useState<Record<IssueKind, boolean>>(() => ({
    bug: storedDraftsReady(initialDraftReads.bug),
    feature: storedDraftsReady(initialDraftReads.feature),
  }));
  const [draftDirty, setDraftDirty] = useState<Record<IssueKind, boolean>>({
    bug: false,
    feature: false,
  });
  const [draftWriteState, setDraftWriteState] = useState<Record<IssueKind, DraftWriteState>>({
    bug: 'idle',
    feature: 'idle',
  });
  const [evidenceChoices, setEvidenceChoices] = useState<Record<IssueKind, IssueEvidenceChoice>>({
    bug: 'none',
    feature: 'none',
  });
  const [editedBodies, setEditedBodies] = useState<Record<IssueKind, string | null>>({
    bug: null,
    feature: null,
  });
  const [editingBody, setEditingBody] = useState<string | null>(null);
  const [bodyEditError, setBodyEditError] = useState<string | null>(null);
  const [defaultAgentName, setDefaultAgentName] = useState<string | null>(null);
  const [clearDraftError, setClearDraftError] = useState<string | null>(null);
  const [closeSaveError, setCloseSaveError] = useState<string | null>(null);
  const contextHydrationAllowedRef = useRef(draftReady);
  const autosaveTimers = useRef<Record<IssueKind, number | null>>({ bug: null, feature: null });
  const [submission, setSubmission] = useState<SubmitGitHubIssueResult | null>(null);
  const submitInFlight = useRef(false);

  const context = useAsyncState(getIssueReportContext, {
    onSuccess: (reportContext) => {
      setDefaultAgentName(reportContext.defaultAgent);
      if (!contextHydrationAllowedRef.current.bug) return;
      setBugDraft((draft) => ({
        ...draft,
        appVersion: draft.appVersion || reportContext.appVersion,
        operatingSystem: draft.operatingSystem || reportContext.operatingSystem,
        architecture: draft.architecture || reportContext.architecture,
        agent: draft.agent || reportContext.defaultAgent || '',
      }));
    },
  });
  const account = useAsyncState((projectPath: string | null) =>
    getGitHubUsername(projectPath ?? undefined)
  );
  const receipts = useAsyncState(getAutomaticReportStatus);
  const submit = useAsyncState((args: SubmitGitHubIssueArgs) => submitGitHubIssue(args));
  const handoff = useAsyncState(async (url: string) => openUrl(url));
  const clipboard = useCopyToClipboard();
  const loadContext = context.execute;
  const loadAccount = account.execute;
  const loadReceipts = receipts.execute;

  useEffect(() => {
    void loadContext();
    void loadReceipts();
  }, [loadContext, loadReceipts]);

  useEffect(() => {
    void loadAccount(currentProjectPath);
  }, [currentProjectPath, loadAccount]);

  usePolling(() => loadReceipts(), {
    intervalMs: 15_000,
    enabled: true,
    name: 'issue-report-receipts',
  });

  const issueKind: IssueKind | null =
    selectedKind === 'bug' || selectedKind === 'feature' ? selectedKind : null;
  const contactSelection =
    selectedKind === 'security' || selectedKind === 'discussion' || selectedKind === 'slack'
      ? selectedKind
      : null;
  const isBug = issueKind === 'bug';
  const evidenceChoice = issueKind ? evidenceChoices[issueKind] : null;
  const issueDraft = issueKind === 'bug' ? bugDraft : issueKind === 'feature' ? featureDraft : null;
  const title =
    issueKind === 'bug'
      ? issueTitle(issueKind, bugDraft.title)
      : issueKind === 'feature'
        ? issueTitle(issueKind, featureDraft.title)
        : '';
  const generatedBody =
    issueKind === 'bug'
      ? buildBugReportBody(bugDraft, evidenceChoice === 'links')
      : issueKind === 'feature'
        ? buildFeatureRequestBody(featureDraft, evidenceChoice === 'links')
        : '';
  const editedBody = issueKind ? editedBodies[issueKind] : null;
  const body = editedBody ?? generatedBody;
  const bodyValidationMessage = reportBodyValidationMessage(body);
  const isReportBodyValid = bodyValidationMessage === null;
  const canReview =
    issueKind === 'bug'
      ? hasRequiredBugDetails(bugDraft)
      : issueKind === 'feature'
        ? hasRequiredFeatureDetails(featureDraft)
        : false;
  const unresolvedSavedSnapshot =
    issueKind && !draftReady[issueKind] && storedDrafts[issueKind].status === 'saved'
      ? storedDrafts[issueKind].snapshot
      : null;
  const unresolvedSavedTitle = unresolvedSavedSnapshot
    ? issueTitle(unresolvedSavedSnapshot.kind, unresolvedSavedSnapshot.draft.title)
    : null;
  const unresolvedSavedTime = unresolvedSavedSnapshot
    ? relativeTime(unresolvedSavedSnapshot.updatedAt)
    : null;
  const isDraftChoice =
    issueKind !== null &&
    !draftReady[issueKind] &&
    (storedDrafts[issueKind].status === 'saved' || storedDrafts[issueKind].status === 'invalid');
  const fullHandoffUrl = issueKind ? issueHandoffUrl(issueKind, title, body) : '';
  const useClipboardHandoff = fullHandoffUrl.length > 6000;
  const handoffUrl =
    issueKind && useClipboardHandoff
      ? issueHandoffUrl(issueKind, title, body, false)
      : fullHandoffUrl;
  const modalTitle = modalTitleFor(selectedKind, step);

  useEffect(() => {
    if (!issueKind || !draftReady[issueKind] || !draftDirty[issueKind] || !issueDraft) return;
    const timers = autosaveTimers.current;
    const timeout = window.setTimeout(() => {
      timers[issueKind] = null;
      const result =
        issueKind === 'bug'
          ? saveIssueReportDraft('bug', bugDraft, evidenceChoice, editedBodies[issueKind])
          : saveIssueReportDraft('feature', featureDraft, evidenceChoice, editedBodies[issueKind]);
      setDraftWriteState((state) => ({ ...state, [issueKind]: result.ok ? 'saved' : 'error' }));
      if (result.ok) {
        setStoredDrafts((state) => ({ ...state, [issueKind]: readIssueReportDraft(issueKind) }));
        setDraftDirty((state) => ({ ...state, [issueKind]: false }));
      }
    }, 300);
    timers[issueKind] = timeout;
    return () => {
      window.clearTimeout(timeout);
      if (timers[issueKind] === timeout) {
        timers[issueKind] = null;
      }
    };
  }, [
    issueKind,
    draftReady,
    draftDirty,
    issueDraft,
    bugDraft,
    featureDraft,
    evidenceChoice,
    editedBodies,
  ]);

  function setBugDraftAndDirty(action: SetStateAction<BugReportDraft>) {
    setBugDraft(action);
    setDraftDirty((state) => ({ ...state, bug: true }));
    setDraftWriteState((state) => ({ ...state, bug: 'saving' }));
  }

  function setFeatureDraftAndDirty(action: SetStateAction<FeatureRequestDraft>) {
    setFeatureDraft(action);
    setDraftDirty((state) => ({ ...state, feature: true }));
    setDraftWriteState((state) => ({ ...state, feature: 'saving' }));
  }

  function saveCurrentDraft(
    kind: IssueKind,
    draft: BugReportDraft | FeatureRequestDraft,
    selectedEvidence: IssueEvidenceChoice,
    customBody: string | null = editedBodies[kind]
  ) {
    const timer = autosaveTimers.current[kind];
    if (timer !== null) window.clearTimeout(timer);
    autosaveTimers.current[kind] = null;
    const result =
      kind === 'bug'
        ? saveIssueReportDraft('bug', draft as BugReportDraft, selectedEvidence, customBody)
        : saveIssueReportDraft(
            'feature',
            draft as FeatureRequestDraft,
            selectedEvidence,
            customBody
          );
    setDraftWriteState((state) => ({ ...state, [kind]: result.ok ? 'saved' : 'error' }));
    if (result.ok) {
      setStoredDrafts((state) => ({ ...state, [kind]: readIssueReportDraft(kind) }));
      setDraftDirty((state) => ({ ...state, [kind]: false }));
      setCloseSaveError(null);
    }
    return result;
  }

  function reportBodyValidationMessage(value: string): string | null {
    if (value.trim().length === 0) return 'The report body can’t be empty.';
    if (value.length > MAX_ISSUE_BODY_CHARS) {
      return `The report body must be ${MAX_ISSUE_BODY_CHARS.toLocaleString()} characters or fewer.`;
    }
    return null;
  }

  function persistCurrentDraft(): boolean {
    if (!issueKind || !issueDraft || !draftReady[issueKind]) return false;
    return saveCurrentDraft(issueKind, issueDraft, evidenceChoice).ok;
  }

  function startEditingBody() {
    setBodyEditError(null);
    setEditingBody(body);
  }

  function cancelEditingBody() {
    setBodyEditError(null);
    setEditingBody(null);
  }

  function saveEditedBody() {
    if (!issueKind || !issueDraft || editingBody === null) return;
    const validationMessage = reportBodyValidationMessage(editingBody);
    if (validationMessage) {
      setBodyEditError(validationMessage);
      return;
    }
    const result = saveCurrentDraft(issueKind, issueDraft, evidenceChoice, editingBody);
    if (!result.ok) {
      setBodyEditError(result.message);
      return;
    }
    setEditedBodies((state) => ({ ...state, [issueKind]: editingBody }));
    setEditingBody(null);
    setBodyEditError(null);
  }

  function useGeneratedReportBody() {
    if (!issueKind || !issueDraft) return;
    const result = saveCurrentDraft(issueKind, issueDraft, evidenceChoice, null);
    if (!result.ok) {
      setBodyEditError(result.message);
      return;
    }
    setEditedBodies((state) => ({ ...state, [issueKind]: null }));
    setBodyEditError(null);
  }

  function restoreSavedDraft(kind: IssueKind) {
    const result = storedDrafts[kind];
    if (result.status !== 'saved') return;
    if (kind === 'bug') setBugDraft(result.snapshot.draft as BugReportDraft);
    else setFeatureDraft(result.snapshot.draft as FeatureRequestDraft);
    setEvidenceChoices((state) => ({
      ...state,
      [kind]: result.snapshot.evidenceChoice ?? 'none',
    }));
    setEditedBodies((state) => ({ ...state, [kind]: result.snapshot.editedBody ?? null }));
    setClearDraftError(null);
    setDraftReady((state) => ({ ...state, [kind]: true }));
    contextHydrationAllowedRef.current = { ...contextHydrationAllowedRef.current, [kind]: false };
    setDraftDirty((state) => ({ ...state, [kind]: false }));
    setDraftWriteState((state) => ({ ...state, [kind]: 'saved' }));
  }

  function discardSavedDraft(kind: IssueKind) {
    const timer = autosaveTimers.current[kind];
    if (timer !== null) window.clearTimeout(timer);
    autosaveTimers.current[kind] = null;
    const result = clearIssueReportDraft(kind);
    if (!result.ok) {
      setClearDraftError(result.message);
      return;
    }
    setClearDraftError(null);
    setStoredDrafts((state) => ({ ...state, [kind]: { status: 'empty' } }));
    setDraftReady((state) => ({ ...state, [kind]: true }));
    contextHydrationAllowedRef.current = { ...contextHydrationAllowedRef.current, [kind]: true };
    setDraftDirty((state) => ({ ...state, [kind]: false }));
    setDraftWriteState((state) => ({ ...state, [kind]: 'idle' }));
    setEvidenceChoices((state) => ({ ...state, [kind]: 'none' }));
    setEditedBodies((state) => ({ ...state, [kind]: null }));
    if (kind === 'bug') {
      setBugDraft({
        ...emptyBugDraft,
        appVersion: context.data?.appVersion ?? '',
        operatingSystem: context.data?.operatingSystem ?? '',
        architecture: context.data?.architecture ?? '',
        agent: context.data?.defaultAgent ?? '',
      });
    } else setFeatureDraft(emptyFeatureDraft);
  }

  async function submitIssue() {
    if (
      submitInFlight.current ||
      !issueKind ||
      !account.data ||
      editingBody !== null ||
      !isReportBodyValid
    ) {
      return;
    }
    if (!persistCurrentDraft()) return;
    submitInFlight.current = true;
    setSubmission(null);
    const result = await submit.execute({
      kind: issueKind,
      title,
      body,
      projectPath: currentProjectPath,
      expectedLogin: account.data,
    });
    submitInFlight.current = false;
    if (!result) return;

    setSubmission(result);
    account.setData(result.login);
    if (result.status === 'created') {
      const cleared = clearIssueReportDraft(issueKind);
      if (cleared.ok) {
        setStoredDrafts((state) => ({ ...state, [issueKind]: { status: 'empty' } }));
        setDraftWriteState((state) => ({ ...state, [issueKind]: 'idle' }));
        setClearDraftError(null);
      } else {
        setClearDraftError(cleared.message);
      }
    }
    setStep(result.status === 'created' ? 'success' : 'uncertain');
  }

  async function openGitHubHandoff(alreadySaved = false) {
    if (editingBody !== null || !issueKind || !isReportBodyValid) return;
    if (!alreadySaved && !persistCurrentDraft()) return;
    if (useClipboardHandoff) {
      const copied = await clipboard.copy(body);
      if (!copied) return;
    }
    await handoff.execute(handoffUrl);
  }

  const headerActionButton =
    step === 'success' && submission?.status === 'created' ? (
      <TextButton
        onClick={() => void handoff.execute(submission.issueUrl)}
        disabled={handoff.isLoading}
        data-issue-action="header-open-issue"
        rightIcon={<ExternalLinkIcon size={14} />}
      >
        Open issue
      </TextButton>
    ) : step === 'uncertain' && submission?.status === 'uncertain' ? (
      <TextButton
        onClick={() => void handoff.execute(submission.issueListUrl)}
        disabled={handoff.isLoading}
        data-issue-action="header-check-issues"
        rightIcon={<ExternalLinkIcon size={14} />}
      >
        Check GitHub issues
      </TextButton>
    ) : contactSelection === 'security' ? (
      <TextButton
        onClick={() => void handoff.execute(contactUrl('security'))}
        disabled={handoff.isLoading}
        data-issue-action="contact-security-header"
        rightIcon={<ExternalLinkIcon size={14} />}
      >
        Report on GitHub
      </TextButton>
    ) : issueKind ? (
      <TextButton
        onClick={() => void openGitHubHandoff()}
        disabled={
          !draftReady[issueKind] ||
          handoff.isLoading ||
          submit.isLoading ||
          editingBody !== null ||
          !isReportBodyValid
        }
        data-issue-action="github-handoff"
        rightIcon={<ExternalLinkIcon size={14} />}
      >
        {handoff.isLoading ? 'Opening GitHub…' : 'Report on GitHub'}
      </TextButton>
    ) : null;
  const headerActions = headerActionButton ? (
    <div className="issue-report__header-actions">
      {headerActionButton}
      {editingBody !== null && issueKind && (
        <span className="issue-report__header-note">
          Finish or cancel editing before opening GitHub.
        </span>
      )}
      {issueKind && !isReportBodyValid && (
        <span className="issue-report__header-note" role="alert">
          {bodyValidationMessage} Edit the report body to continue.
        </span>
      )}
      {useClipboardHandoff && step !== 'success' && step !== 'uncertain' && (
        <span className="issue-report__header-note">
          {clipboard.isCopied
            ? 'The report body is copied. Paste it into the GitHub form.'
            : 'Long reports are copied before the GitHub form opens.'}
        </span>
      )}
      {clipboard.error && (
        <span className="issue-report__header-note" role="alert">
          {clipboard.error.message}
        </span>
      )}
      {handoff.error && (
        <span className="issue-report__header-note" role="alert">
          {handoff.error.message}
        </span>
      )}
    </div>
  ) : undefined;

  function backToForm() {
    submit.reset();
    setSubmission(null);
    setStep('form');
  }

  function backToEvidence() {
    submit.reset();
    setSubmission(null);
    setStep('evidence');
  }

  function changeIssueType(nextType: IssueReportSelection) {
    if (nextType === selectedKind) return;
    if (
      issueKind &&
      draftReady[issueKind] &&
      draftDirty[issueKind] &&
      issueDraft &&
      !saveCurrentDraft(issueKind, issueDraft, evidenceChoice).ok
    ) {
      return;
    }
    setClearDraftError(null);
    setSelectedKind(nextType);
    setSubmission(null);
    submit.reset();
    handoff.reset();
    account.reset();
    void loadAccount(currentProjectPath);
    setStep('form');
  }

  async function openUploadHandoff() {
    if (editingBody !== null || !isReportBodyValid) return;
    if (!persistCurrentDraft()) return;
    await openGitHubHandoff(true);
  }

  function chooseEvidence(choice: IssueEvidenceChoice) {
    if (!issueKind || !choice) return;
    setEvidenceChoices((state) => ({ ...state, [issueKind]: choice }));
    setDraftDirty((state) => ({ ...state, [issueKind]: true }));
    setDraftWriteState((state) => ({ ...state, [issueKind]: 'saving' }));
  }

  function continueToEvidence() {
    if (!canReview || !persistCurrentDraft()) return;
    setSubmission(null);
    submit.reset();
    setStep('evidence');
  }

  function continueToReview() {
    if (!issueKind || (evidenceChoice !== 'links' && evidenceChoice !== 'none')) return;
    if (!persistCurrentDraft()) return;
    setSubmission(null);
    submit.reset();
    setStep('review');
  }

  function closeModal() {
    let latestDraftSaved = false;
    if (editingBody !== null && issueKind && issueDraft) {
      const validationMessage = reportBodyValidationMessage(editingBody);
      if (validationMessage) {
        setCloseSaveError(validationMessage);
        return;
      }
      const result = saveCurrentDraft(issueKind, issueDraft, evidenceChoice, editingBody);
      if (!result.ok) {
        setCloseSaveError(result.message);
        return;
      }
      setEditedBodies((state) => ({ ...state, [issueKind]: editingBody }));
      setEditingBody(null);
      latestDraftSaved = true;
    }
    if (
      !latestDraftSaved &&
      issueKind &&
      draftReady[issueKind] &&
      draftDirty[issueKind] &&
      issueDraft
    ) {
      const result = saveCurrentDraft(issueKind, issueDraft, evidenceChoice);
      if (!result.ok) {
        setCloseSaveError(result.message);
        return;
      }
    }
    setCloseSaveError(null);
    onClose();
  }

  function closeWithoutLatestChanges() {
    setCloseSaveError(null);
    onClose();
  }

  return (
    <ModalFrame
      isOpen
      onClose={closeModal}
      title={modalTitle}
      className="issue-report-modal"
      headerActions={headerActions}
      dismissable={!submit.isLoading && !handoff.isLoading}
    >
      {closeSaveError && (
        <div className="issue-report__close-save-warning" role="alert">
          <p>
            {closeSaveError} The modal stayed open so you can retry, or close without saving your
            latest changes.
          </p>
          <Button
            variant="secondary"
            onClick={closeWithoutLatestChanges}
            data-issue-action="close-unsaved"
          >
            Close without saving latest changes
          </Button>
        </div>
      )}
      {step === 'form' && (
        <div
          className={`issue-report__body${isDraftChoice ? ' issue-report__body--draft-choice' : ''}`}
          data-issue-surface="form"
        >
          <div className="issue-report__automatic-reports-group">
            {issueKind !== null && (
              <p className="issue-report__automatic-reports-guidance">
                Crashes and unexpected errors may be reported automatically. Check confirmed reports
                below; manually report visual or workflow problems.
              </p>
            )}
            <AutomaticReportNotice
              status={receipts.data}
              isLoading={receipts.isLoading}
              error={receipts.error?.message}
              onRetry={() => void loadReceipts()}
              onOpenReceipt={(url) => void handoff.execute(url)}
            />
          </div>
          {!isDraftChoice && (
            <label className="issue-report__type-field" htmlFor="issue-report-type">
              <span>Issue type</span>
              <select
                id="issue-report-type"
                aria-label="Issue type"
                data-issue-type-select
                value={selectedKind}
                onChange={(event) =>
                  changeIssueType(event.currentTarget.value as IssueReportSelection)
                }
              >
                <optgroup label="Public GitHub issues">
                  <option value="bug">Bug report</option>
                  <option value="feature">Feature request</option>
                </optgroup>
                {(SECURITY_URL || DISCUSSIONS_URL || SLACK_URL) && (
                  <optgroup label="Other ways to get help">
                    {SECURITY_URL && <option value="security">Security vulnerability</option>}
                    {DISCUSSIONS_URL && <option value="discussion">Question or discussion</option>}
                    {SLACK_URL && <option value="slack">Community Slack</option>}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {issueKind && !draftReady[issueKind] && (
            <section className="issue-report__draft-choice" data-issue-surface="restore-draft">
              <h3>
                {unresolvedSavedSnapshot ? 'Continue your report' : 'Saved draft needs attention'}
              </h3>
              <div className="issue-report__draft-choices">
                {unresolvedSavedSnapshot && (
                  <button
                    type="button"
                    className="issue-report__draft-choice-card"
                    onClick={() => restoreSavedDraft(issueKind)}
                    aria-label="Restore draft"
                    aria-describedby={`issue-report-saved-draft-info-${issueKind}`}
                    title={`${unresolvedSavedTitle} · Saved ${unresolvedSavedTime}`}
                    data-issue-action="restore-draft"
                  >
                    <span className="issue-report__draft-choice-icon" aria-hidden="true">
                      <UndoIcon size={24} />
                    </span>
                    <strong>Restore draft</strong>
                    <small id={`issue-report-saved-draft-info-${issueKind}`}>
                      {unresolvedSavedTitle} · Saved {unresolvedSavedTime}
                    </small>
                  </button>
                )}
                <button
                  type="button"
                  className="issue-report__draft-choice-card"
                  onClick={() => discardSavedDraft(issueKind)}
                  data-issue-action="discard-saved-draft"
                >
                  <span className="issue-report__draft-choice-icon" aria-hidden="true">
                    <PlusIcon size={24} />
                  </span>
                  <strong>Start a new report</strong>
                  <small>
                    {unresolvedSavedSnapshot
                      ? 'Discard the saved draft and start fresh.'
                      : 'The saved draft could not be read. Clear it and start fresh.'}
                  </small>
                </button>
              </div>
              {clearDraftError && (
                <p className="issue-report__storage-error" role="alert">
                  {clearDraftError} The saved draft is still here. Try the start-new choice again.
                </p>
              )}
            </section>
          )}
          {issueKind && draftReady[issueKind] && (
            <>
              <p className="issue-report__intro">
                {isBug
                  ? 'Share what happened and how to reproduce it. Only the details shown in the preview will be sent.'
                  : 'Describe the problem and the change you would like to see. Your draft stays private until you submit it.'}
              </p>
              {storedDrafts[issueKind].status === 'unavailable' && (
                <p className="issue-report__storage-error" role="alert">
                  {storedDrafts[issueKind].message} Your report can’t continue until a device draft
                  saves successfully.
                </p>
              )}
              {issueKind === 'bug' ? (
                <BugReportFields
                  draft={bugDraft}
                  setDraft={setBugDraftAndDirty}
                  contextLoading={context.isLoading}
                  contextError={Boolean(context.error)}
                  savedDefaultAgent={defaultAgentName}
                />
              ) : (
                <FeatureRequestFields draft={featureDraft} setDraft={setFeatureDraftAndDirty} />
              )}
              <div className="issue-report__form-footer">
                <div className="issue-report__draft-status" aria-live="polite">
                  {draftWriteState[issueKind] === 'saving' && (
                    <span>Saving draft on this device…</span>
                  )}
                  {draftWriteState[issueKind] === 'saved' && (
                    <span>Draft saved on this device.</span>
                  )}
                  {draftWriteState[issueKind] === 'error' && (
                    <span role="alert">
                      {storedDrafts[issueKind].status === 'unavailable'
                        ? storedDrafts[issueKind].message
                        : 'This device could not save the report draft. Check browser storage settings and try again.'}
                    </span>
                  )}
                  {clearDraftError && (
                    <span role="alert">
                      {clearDraftError}{' '}
                      <TextButton onClick={() => discardSavedDraft(issueKind)}>
                        Try clearing again
                      </TextButton>
                    </span>
                  )}
                </div>
                <div className="issue-report__actions issue-report__action-group">
                  {storedDrafts[issueKind].status === 'saved' && (
                    <TextButton onClick={() => discardSavedDraft(issueKind)}>
                      Discard draft
                    </TextButton>
                  )}
                  <Button
                    variant="primary"
                    disabled={!canReview}
                    onClick={continueToEvidence}
                    data-issue-action="evidence-next"
                    rightIcon={<ArrowRightIcon size={14} />}
                  >
                    Continue
                  </Button>
                </div>
              </div>
            </>
          )}
          {!issueKind && contactSelection ? (
            <ContactRoute
              selection={contactSelection}
              onOpen={() => void handoff.execute(contactUrl(contactSelection))}
              isLoading={handoff.isLoading}
            />
          ) : null}
          {handoff.error && <p className="issue-report__error">{handoff.error.message}</p>}
        </div>
      )}

      {step === 'evidence' && issueKind && (
        <div className="issue-report__body" data-issue-surface="evidence">
          <p className="issue-report__intro">
            Your report details are saved as a private draft on this device. Choose whether to add
            evidence before reviewing the public issue.
          </p>
          <fieldset className="issue-report__evidence-options">
            <legend>Evidence</legend>
            <EvidenceChoice
              value="none"
              selected={evidenceChoice === 'none'}
              onSelect={chooseEvidence}
              title="No images or links"
              description="Continue without screenshots or evidence links."
            />
            <EvidenceChoice
              value="links"
              selected={evidenceChoice === 'links'}
              onSelect={chooseEvidence}
              title="Add evidence links"
              description="Paste links you want included in the public issue preview."
            />
            <EvidenceChoice
              value="upload"
              selected={evidenceChoice === 'upload'}
              onSelect={chooseEvidence}
              title="Upload images on GitHub"
              description="Open the GitHub issue form with your saved report. Add image files there and finish creating the issue in GitHub. Ship Studio will not submit it."
            />
          </fieldset>
          {evidenceChoice === 'links' && (
            <TextField
              field={isBug ? 'screenshots' : 'evidence-links'}
              label="Evidence links (optional)"
              value={isBug ? bugDraft.screenshots : featureDraft.evidenceLinks}
              onChange={(value) => {
                if (isBug) setBugDraftAndDirty((draft) => ({ ...draft, screenshots: value }));
                else setFeatureDraftAndDirty((draft) => ({ ...draft, evidenceLinks: value }));
              }}
              rows={3}
              hint="Add only links you want published with this issue. Review them for private access or identifying information."
            />
          )}
          {evidenceChoice === 'upload' && (
            <div className="issue-report__upload-guidance">
              <p>
                GitHub opens in your browser. Use its image attachment control, review the completed
                issue there, and submit it there. No public issue is created until you finish in
                GitHub.
              </p>
            </div>
          )}
          {draftWriteState[issueKind] === 'error' && (
            <p className="issue-report__storage-error" role="alert">
              This device could not save the report draft. Check browser storage settings and try
              again before continuing.
            </p>
          )}
          <div className="issue-report__actions issue-report__actions--split">
            <Button
              variant="ghost"
              onClick={() => setStep('form')}
              data-issue-action="evidence-back"
              leftIcon={<ArrowLeftIcon size={14} />}
            >
              Back to report details
            </Button>
            {evidenceChoice === 'upload' ? (
              <Button
                variant="primary"
                onClick={() => void openUploadHandoff()}
                disabled={handoff.isLoading || editingBody !== null || !isReportBodyValid}
                data-issue-action="evidence-upload"
              >
                {handoff.isLoading ? 'Opening GitHub…' : 'Finish report on GitHub'}
                <ExternalLinkIcon size={14} />
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={continueToReview}
                disabled={evidenceChoice !== 'links' && evidenceChoice !== 'none'}
                data-issue-action="evidence-next"
                rightIcon={<ArrowRightIcon size={14} />}
              >
                Review public issue
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="issue-report__body" data-issue-surface="review">
          <p className="issue-report__intro">
            This will create a public issue in <strong>{ISSUE_REPO}</strong>. Check the complete
            title and body before sending.
          </p>
          <div className="issue-report__identity" aria-live="polite">
            <span className="issue-report__identity-label">In-app GitHub account</span>
            {account.data ? (
              <span className="issue-report__identity-value">@{account.data}</span>
            ) : account.isLoading ? (
              <span className="issue-report__identity-loading">
                <Spinner size="sm" label="Checking GitHub account" /> Checking sign-in…
              </span>
            ) : (
              <span className="issue-report__identity-error">
                {account.error?.message ?? 'Could not confirm the GitHub CLI account.'}
              </span>
            )}
            <span className="issue-report__identity-note">
              The browser may be signed into a different GitHub account.
            </span>
          </div>

          <section className="issue-report__preview" aria-label="Public issue preview">
            <div className="issue-report__preview-heading">
              <span>Public preview</span>
              <div className="issue-report__preview-controls">
                {editedBody !== null && editingBody === null && (
                  <TextButton
                    onClick={useGeneratedReportBody}
                    disabled={submit.isLoading || handoff.isLoading}
                    data-issue-action="use-generated-report-body"
                  >
                    Use generated report text
                  </TextButton>
                )}
                <span className="issue-report__label-chip">{isBug ? 'bug' : 'enhancement'}</span>
                {editingBody === null && (
                  <TextButton
                    onClick={startEditingBody}
                    disabled={submit.isLoading || handoff.isLoading}
                    data-issue-action="edit-report-body"
                  >
                    Edit
                  </TextButton>
                )}
              </div>
            </div>
            <h3>{title}</h3>
            {editedBody !== null && editingBody === null && (
              <p className="issue-report__custom-body-note">
                This custom body stays unchanged when you edit the report fields.
              </p>
            )}
            {editingBody === null ? (
              <pre>{body}</pre>
            ) : (
              <div className="issue-report__body-editor">
                <TextField
                  field="report-body"
                  label="Report body"
                  value={editingBody}
                  onChange={(value) => {
                    setEditingBody(value);
                    setBodyEditError(null);
                  }}
                  rows={18}
                  required
                  maxLength={MAX_ISSUE_BODY_CHARS}
                  ariaInvalid={Boolean(bodyEditError || reportBodyValidationMessage(editingBody))}
                  hint="Edit the Markdown that will be submitted or opened in GitHub."
                  className="issue-report__body-edit-field"
                />
                {bodyEditError && (
                  <p className="issue-report__storage-error" role="alert">
                    {bodyEditError}
                  </p>
                )}
                <div className="issue-report__actions issue-report__preview-edit-actions">
                  <TextButton onClick={cancelEditingBody} data-issue-action="cancel-report-body">
                    Cancel
                  </TextButton>
                  <Button
                    variant="primary"
                    onClick={saveEditedBody}
                    data-issue-action="save-report-body"
                  >
                    Done editing
                  </Button>
                </div>
              </div>
            )}
            {editingBody === null && bodyValidationMessage && (
              <p className="issue-report__storage-error" role="alert">
                {bodyValidationMessage}
              </p>
            )}
            {editingBody === null && bodyEditError && (
              <p className="issue-report__storage-error" role="alert">
                {bodyEditError}
              </p>
            )}
          </section>

          <AutomaticReportNotice
            status={receipts.data}
            isLoading={receipts.isLoading}
            error={receipts.error?.message}
            onRetry={() => void loadReceipts()}
            onOpenReceipt={(url) => void handoff.execute(url)}
          />
          <p className="issue-report__privacy-note">
            Ship Studio will send only this title and body. It does not collect logs or screenshots
            automatically. Review pasted details for paths, project names, branch names, or secrets.
          </p>
          <div className="issue-report__actions issue-report__actions--split">
            <Button
              variant="ghost"
              onClick={backToEvidence}
              disabled={editingBody !== null}
              data-issue-action="review-back"
              leftIcon={<ArrowLeftIcon size={14} />}
            >
              Back to evidence
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitIssue()}
              disabled={
                !account.data || submit.isLoading || editingBody !== null || !isReportBodyValid
              }
              data-issue-action="submit"
              leftIcon={<PushIcon size={14} />}
            >
              {submit.isLoading ? 'Submitting…' : 'Submit issue'}
            </Button>
          </div>
          {account.error && (
            <div className="issue-report__auth-help" role="alert">
              <p>In-app submission needs an authenticated GitHub CLI account.</p>
              <p>{account.error.message}</p>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void loadAccount(currentProjectPath)}
              >
                Check sign-in again
              </Button>
            </div>
          )}
          {submit.error && (
            <div className="issue-report__error" role="alert">
              <strong>Could not submit the issue.</strong>
              <span>{submit.error.message}</span>
              <span>
                Your draft is still here, so you can fix the issue or use the browser form.
              </span>
            </div>
          )}
        </div>
      )}

      {step === 'success' && submission?.status === 'created' && (
        <div className="issue-report__outcome" data-issue-surface="success">
          <div className="issue-report__outcome-mark" aria-hidden="true">
            ✓
          </div>
          <h3>Issue #{submission.number} was created</h3>
          <p>
            Posted publicly as <strong>@{submission.login}</strong> in {ISSUE_REPO}.
          </p>
          {clearDraftError && (
            <p className="issue-report__storage-error" role="alert">
              The issue was created, but the saved device draft could not be cleared.{' '}
              <TextButton onClick={() => discardSavedDraft(issueKind ?? initialKind)}>
                Clear the saved draft
              </TextButton>
            </p>
          )}
          <div className="issue-report__actions">
            <Button variant="primary" onClick={closeModal}>
              Done
            </Button>
          </div>
        </div>
      )}

      {step === 'uncertain' && submission?.status === 'uncertain' && (
        <div className="issue-report__outcome" data-issue-surface="uncertain">
          <div className="issue-report__uncertain-mark" aria-hidden="true">
            ?
          </div>
          <h3>GitHub did not confirm the result</h3>
          <p>{submission.message}</p>
          <p>
            The request used <strong>@{submission.login}</strong>. Your title and body remain in
            this modal.
          </p>
          <div className="issue-report__actions">
            <Button variant="primary" onClick={backToForm}>
              I checked — review draft
            </Button>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}

function ContactRoute({
  selection,
  onOpen,
  isLoading,
}: {
  selection: Exclude<IssueReportSelection, IssueKind>;
  onOpen: () => void;
  isLoading: boolean;
}) {
  const route = contactRoutes[selection];
  return (
    <section className="issue-report__contact-links" aria-live="polite">
      <h3>{route.title}</h3>
      <p className={selection === 'security' ? 'issue-report__security-note' : undefined}>
        {route.description}
      </p>
      <Button
        variant="secondary"
        onClick={onOpen}
        disabled={isLoading}
        data-issue-action={`contact-${selection}`}
      >
        {isLoading ? 'Opening…' : route.action}
        <ExternalLinkIcon size={14} />
      </Button>
    </section>
  );
}

function EvidenceChoice({
  value,
  selected,
  onSelect,
  title,
  description,
}: {
  value: Exclude<IssueEvidenceChoice, null>;
  selected: boolean;
  onSelect: (choice: IssueEvidenceChoice) => void;
  title: string;
  description: string;
}) {
  return (
    <label className={`issue-report__evidence-choice${selected ? ' is-selected' : ''}`}>
      <input
        type="radio"
        name="issue-report-evidence"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        className="issue-report__evidence-input"
        data-evidence-choice={value}
      />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function BugReportFields({
  draft,
  setDraft,
  contextLoading,
  contextError,
  savedDefaultAgent,
}: {
  draft: BugReportDraft;
  setDraft: Dispatch<SetStateAction<BugReportDraft>>;
  contextLoading: boolean;
  contextError: boolean;
  savedDefaultAgent: string | null;
}) {
  const update = <K extends keyof BugReportDraft>(field: K, value: BugReportDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <div className="issue-report__fields" data-issue-surface="bug-form">
      <TextField
        field="title"
        label="Title"
        value={draft.title}
        onChange={(value) => update('title', value)}
        required
        singleLine
        hint="Add a short title after the [Bug] prefix."
      />
      <TextField
        field="what-happened"
        label="What happened?"
        value={draft.whatHappened}
        onChange={(value) => update('whatHappened', value)}
        required
        hint="What did you do, and what went wrong?"
      />
      <TextField
        field="what-expected"
        label="What did you expect?"
        value={draft.whatExpected}
        onChange={(value) => update('whatExpected', value)}
        required
        hint="Describe the result you expected to see."
      />
      <TextField
        field="steps"
        label="Steps to reproduce"
        value={draft.reproductionSteps}
        onChange={(value) => update('reproductionSteps', value)}
        required
        rows={3}
        hint="One step per line. Include the action that made the problem appear."
      />
      <section
        className="issue-report__environment"
        aria-labelledby="issue-report-environment-title"
      >
        <div className="issue-report__section-heading">
          <h3 id="issue-report-environment-title">Environment</h3>
          <span>
            {contextLoading
              ? 'Detecting app details…'
              : contextError
                ? 'Some details unavailable'
                : 'Review before posting'}
          </span>
        </div>
        {contextError && (
          <p className="issue-report__context-error">
            App details could not be detected. Enter any environment information you know.
          </p>
        )}
        <div className="issue-report__environment-grid">
          <div className="issue-report__environment-pair">
            <TextField
              field="app-version"
              label="Ship Studio version"
              value={draft.appVersion}
              onChange={(value) => update('appVersion', value)}
              singleLine
              hint="Fetched from this app. Add or correct it if needed."
            />
            <TextField
              field="operating-system"
              label="OS"
              value={draft.operatingSystem}
              onChange={(value) => update('operatingSystem', value)}
              singleLine
              hint="Detected OS name; add the version if you know it."
            />
          </div>
          <div className="issue-report__environment-pair">
            <TextField
              field="architecture"
              label="Architecture"
              value={draft.architecture}
              onChange={(value) => update('architecture', value)}
              singleLine
              hint="Detected from the app runtime. Change it if this issue happened elsewhere."
            />
            <TextField
              field="agent"
              label="Agent (if relevant)"
              value={draft.agent}
              onChange={(value) => update('agent', value)}
              singleLine
              hint={
                savedDefaultAgent
                  ? 'Saved default; change if different for this issue.'
                  : 'Optional; enter the agent used for this issue if relevant.'
              }
            />
          </div>
          <TextField
            field="install-method"
            label="Install method"
            value={draft.installMethod}
            onChange={(value) => update('installMethod', value)}
            singleLine
            hint="Optional; enter how you installed or launched Ship Studio."
            placeholder="For example, .dmg, .exe, or pnpm tauri dev"
            className="issue-report__environment-install"
          />
        </div>
      </section>
      <TextField
        field="logs"
        label="Logs (optional)"
        value={draft.logs}
        onChange={(value) => update('logs', value)}
        rows={5}
        hint="Paste only the lines you want to publish. Logs are never collected automatically. Redact paths, project names, branch names, tokens, and other private details."
        className="issue-report__logs-field"
      />
      <TextField
        field="anything-else"
        label="Anything else? (optional)"
        value={draft.anythingElse}
        onChange={(value) => update('anythingElse', value)}
        rows={2}
        hint="Workarounds you tried or related issues."
      />
    </div>
  );
}

function FeatureRequestFields({
  draft,
  setDraft,
}: {
  draft: FeatureRequestDraft;
  setDraft: Dispatch<SetStateAction<FeatureRequestDraft>>;
}) {
  const update = <K extends keyof FeatureRequestDraft>(field: K, value: FeatureRequestDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <div className="issue-report__fields" data-issue-surface="feature-form">
      <TextField
        field="title"
        label="Title"
        value={draft.title}
        onChange={(value) => update('title', value)}
        required
        singleLine
        hint="Add a short title after the [Feature] prefix."
      />
      <TextField
        field="problem"
        label="What problem does this solve?"
        value={draft.problem}
        onChange={(value) => update('problem', value)}
        required
        hint="Describe the task or frustration first."
      />
      <TextField
        field="proposed-solution"
        label="Proposed solution"
        value={draft.proposedSolution}
        onChange={(value) => update('proposedSolution', value)}
        required
        hint="What should Ship Studio do?"
      />
      <TextField
        field="alternatives"
        label="Alternatives considered (optional)"
        value={draft.alternatives}
        onChange={(value) => update('alternatives', value)}
        rows={2}
        hint="What other approaches have you tried or considered?"
      />
      <TextField
        field="who-benefits"
        label="Who benefits?"
        value={draft.whoBenefits}
        onChange={(value) => update('whoBenefits', value)}
        required
        hint="For example, a particular framework, agent, workflow, or all users."
      />
      <TextField
        field="anything-else"
        label="Anything else? (optional)"
        value={draft.anythingElse}
        onChange={(value) => update('anythingElse', value)}
        rows={2}
        hint="Mockups, links, or examples from other tools."
      />
    </div>
  );
}

function TextField({
  field,
  label,
  value,
  onChange,
  required = false,
  singleLine = false,
  rows = 3,
  hint,
  placeholder,
  className,
  maxLength,
  ariaInvalid,
}: {
  field: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  singleLine?: boolean;
  rows?: number;
  hint?: string;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  ariaInvalid?: boolean;
}) {
  const hintId = required || hint ? `issue-report-hint-${field}` : undefined;
  return (
    <div className={`issue-report__field${className ? ` ${className}` : ''}`}>
      <div className="issue-report__field-heading">
        <label htmlFor={`issue-report-${field}`}>{label}</label>
        {(required || hint) && (
          <small id={hintId} className="issue-report__field-description">
            {required && <span className="issue-report__required">Required.</span>}
            {required && hint ? ' ' : null}
            {hint}
          </small>
        )}
      </div>
      {singleLine ? (
        <input
          id={`issue-report-${field}`}
          data-issue-field={field}
          type="text"
          value={value}
          required={required}
          aria-required={required}
          aria-describedby={hintId}
          aria-invalid={ariaInvalid || undefined}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <textarea
          id={`issue-report-${field}`}
          data-issue-field={field}
          value={value}
          rows={rows}
          required={required}
          aria-required={required}
          aria-describedby={hintId}
          aria-invalid={ariaInvalid || undefined}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </div>
  );
}

function AutomaticReportNotice({
  status,
  isLoading,
  error,
  onRetry,
  onOpenReceipt,
}: {
  status: AutomaticReportStatus | null;
  isLoading: boolean;
  error?: string;
  onRetry: () => void;
  onOpenReceipt: (url: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const receipts: AutomaticReportReceipt[] = status?.receipts ?? [];
  const latestReceipt = latestAutomaticReportReceipt(receipts);
  const disabledMessage = status?.reason ? automaticReportsDisabledMessage(status.reason) : null;
  const reportsDisabled =
    status !== null && (status.reason !== null || !status.enabled || !status.configured);
  const disabledSummary =
    status && reportsDisabled ? automaticReportsDisabledSummary(status.reason) : null;
  const latestReceiptSummary = latestReceipt
    ? `Latest confirmed ${latestReceipt.kind === 'crash' ? 'crash' : 'app error'} receipt ${receiptAge(latestReceipt.timestamp)}`
    : null;
  const baseSummary = !status
    ? error
      ? 'Couldn’t load recent reports'
      : isLoading
        ? 'Checking recent app reports…'
        : 'Recent report status unavailable'
    : latestReceiptSummary && disabledSummary
      ? `${disabledSummary} · ${latestReceiptSummary}`
      : (disabledSummary ?? latestReceiptSummary ?? 'No recent confirmed receipts');
  const refreshState =
    error && status ? 'Refresh failed' : isLoading && status ? 'Refreshing' : null;
  const summary = refreshState ? `${baseSummary} · ${refreshState}` : baseSummary;
  const receiptRow = (receipt: AutomaticReportReceipt) => (
    <li key={`${receipt.timestamp}-${receipt.kind}-${receipt.source}`}>
      <div className="issue-report__receipt-summary" title={receipt.source}>
        <span>
          {receipt.kind === 'crash' ? 'Crash' : 'App error'} report accepted{' '}
          {receiptAge(receipt.timestamp)}
        </span>
        <small>{receipt.summary}</small>
      </div>
      {receipt.issueUrl ? (
        <TextButton onClick={() => onOpenReceipt(receipt.issueUrl!)}>
          Issue filed <ExternalLinkIcon size={12} />
        </TextButton>
      ) : (
        <span className="issue-report__receipt-pending">No issue link returned</span>
      )}
    </li>
  );
  return (
    <section className="issue-report__automatic-reports" aria-label="Recent app reports">
      <div className="issue-report__automatic-reports-summary">
        <div className="issue-report__automatic-reports-copy">
          <h3>Recent app reports</h3>
          <span className="issue-report__automatic-reports-status" role="status" aria-live="polite">
            {summary}
          </span>
        </div>
        <div className="issue-report__automatic-reports-actions">
          {error && (
            <Button
              variant="ghost"
              size="compact"
              onClick={onRetry}
              data-issue-action="retry-automatic-reports"
            >
              Try again
            </Button>
          )}
          <Button
            variant="ghost"
            size="compact"
            aria-expanded={detailsOpen}
            aria-controls="issue-report-automatic-report-details"
            onClick={() => setDetailsOpen((open) => !open)}
            data-issue-action="toggle-automatic-report-details"
          >
            Details
          </Button>
        </div>
      </div>
      <div
        id="issue-report-automatic-report-details"
        className="issue-report__automatic-reports-detail-content"
        hidden={!detailsOpen}
      >
        {isLoading && status && <p>Refreshing recent app reports…</p>}
        {!status && isLoading && <p>Checking recent app reports…</p>}
        {disabledMessage && <p>{disabledMessage}</p>}
        {reportsDisabled && !disabledMessage && (
          <p>Automatic report history is unavailable for this build.</p>
        )}
        {status && receipts.length === 0 && !reportsDisabled && (
          <p>
            No confirmed receipts are available in recent history. This list does not describe every
            report ever sent.
          </p>
        )}
        {receipts.length > 0 && (
          <>
            <p className="issue-report__duplicate-guidance">
              Check whether a recent report covers this same incident before filing another.
              Unrelated issues are welcome.
            </p>
            <ul>{receipts.map(receiptRow)}</ul>
          </>
        )}
        {error && (
          <p className="issue-report__report-status-error" role="alert">
            {error}
          </p>
        )}
        {!status && !isLoading && !error && <p>Recent report receipt status is unavailable.</p>}
      </div>
    </section>
  );
}

function latestAutomaticReportReceipt(
  receipts: AutomaticReportReceipt[]
): AutomaticReportReceipt | null {
  return receipts.reduce<AutomaticReportReceipt | null>((latest, receipt) => {
    if (!latest) return receipt;
    const receiptTime = Date.parse(receipt.timestamp);
    const latestTime = Date.parse(latest.timestamp);
    if (
      Number.isFinite(receiptTime) &&
      (!Number.isFinite(latestTime) || receiptTime > latestTime)
    ) {
      return receipt;
    }
    return latest;
  }, null);
}

function receiptAge(timestamp: string): string {
  return Number.isFinite(Date.parse(timestamp)) ? relativeTime(timestamp) : 'time unavailable';
}

function automaticReportsDisabledSummary(reason: AutomaticReportStatus['reason']): string {
  switch (reason) {
    case 'consent_disabled':
      return 'Automatic reports off';
    case 'missing_secret':
      return 'Automatic reports not configured';
    case 'development_build':
      return 'Disabled in development';
    default:
      return 'Automatic reports unavailable';
  }
}

function automaticReportsDisabledMessage(
  reason: NonNullable<AutomaticReportStatus['reason']>
): string {
  switch (reason) {
    case 'consent_disabled':
      return 'Automatic app reports are off. Manual issues are sent only after you review them.';
    case 'missing_secret':
      return 'Automatic reports are not configured in this build. Manual issues still work.';
    case 'development_build':
      return 'Automatic reports are disabled in development builds. Manual issues still work.';
  }
}

function relativeTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  const seconds = Math.round((parsed - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const unit =
    absolute < 60 ? 'second' : absolute < 3600 ? 'minute' : absolute < 86_400 ? 'hour' : 'day';
  const value = Math.round(
    seconds / (unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : 86_400)
  );
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit);
}

function modalTitleFor(kind: IssueReportSelection, step: IssueModalStep): string {
  if (step === 'success') return 'Issue submitted';
  if (step === 'uncertain') return 'Check before retrying';
  switch (kind) {
    case 'bug':
      return 'Report a bug';
    case 'feature':
      return 'Request a feature';
    case 'security':
      return 'Report a security vulnerability';
    case 'discussion':
      return 'Ask a question';
    case 'slack':
      return 'Join the community';
  }
}

function storedDraftsReady(read: IssueReportDraftRead): boolean {
  return read.status !== 'saved' && read.status !== 'invalid';
}
