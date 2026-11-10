import { useEffect } from 'react';
import { BugReportIcon, PlusIcon } from '@/components/icons';
import { onMenuAction } from '../lib/nativeMenu';
import { useOpenModal } from '../contexts/ModalContext';
import { useCommands } from './useCommands';
import { ISSUE_REPORTS_ENABLED } from '../lib/issueReports';

/** Discoverable entry points for the public issue reporting flows. */
export function useIssueReportCommands() {
  const openModal = useOpenModal();
  // Help → Report a Bug… / Request a Feature… (shown when brand.json names the repo).
  useEffect(
    () =>
      onMenuAction((action) => {
        if (!ISSUE_REPORTS_ENABLED) return;
        if (action === 'report_bug') openModal('bugReport');
        else if (action === 'request_feature') openModal('featureRequest');
      }),
    [openModal]
  );

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
