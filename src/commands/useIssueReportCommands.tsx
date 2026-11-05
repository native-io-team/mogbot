import { BugReportIcon, PlusIcon } from '@/components/icons';
import { useOpenModal } from '../contexts/ModalContext';
import { useCommands } from './useCommands';
import { ISSUE_REPORTS_ENABLED } from '../lib/issueReports';

/** Discoverable entry points for the public issue reporting flows. */
export function useIssueReportCommands() {
  const openModal = useOpenModal();

  useCommands(
    () => [
      {
        id: 'issueReports.bugReport',
        title: 'Report a bug…',
        subtitle: 'GitHub issues',
        icon: <BugReportIcon size={14} />,
        category: 'settings',
        when: () => ISSUE_REPORTS_ENABLED,
        keywords: ['bug', 'issue', 'report', 'feedback', 'github'],
        run: () => openModal('bugReport'),
      },
      {
        id: 'issueReports.featureRequest',
        title: 'Request a feature…',
        subtitle: 'GitHub issues',
        icon: <PlusIcon size={14} />,
        category: 'settings',
        when: () => ISSUE_REPORTS_ENABLED,
        keywords: ['feature', 'idea', 'suggestion', 'request', 'feedback', 'github'],
        run: () => openModal('featureRequest'),
      },
    ],
    [openModal]
  );
}
