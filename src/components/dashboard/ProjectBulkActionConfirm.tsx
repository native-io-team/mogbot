/**
 * ProjectBulkActionConfirm — confirmation content for selected project actions.
 *
 * @module components/ProjectBulkActionConfirm
 */

import { ProjectActionConfirmModal } from './ProjectActionConfirmModal';
import {
  describeProjectSelection,
  projectCountLabel,
  type BulkProjectActionConfirm,
} from '../../hooks/useProjectBulkActions';
import type { DashboardProject } from '../../lib/project';

interface ProjectBulkActionConfirmProps<T extends DashboardProject> {
  confirm: BulkProjectActionConfirm<T>;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Renders the shared project confirmation modal for bulk remove/delete operations.
 * @param props - Current confirmation request and completion callbacks.
 */
export function ProjectBulkActionConfirm<T extends DashboardProject>({
  confirm,
  loading,
  onCancel,
  onConfirm,
}: ProjectBulkActionConfirmProps<T>) {
  const isDelete = confirm.action === 'delete';
  const countLabel = projectCountLabel(confirm.projects.length);
  const selection = describeProjectSelection(confirm.projects);

  return (
    <ProjectActionConfirmModal
      title={
        isDelete ? 'Delete the selected files from this Mac?' : 'Remove the selected projects?'
      }
      body={
        isDelete ? (
          <>
            Permanently delete <strong>{countLabel}</strong> from this Mac?
          </>
        ) : (
          <>
            Remove <strong>{countLabel}</strong> from your projects?
          </>
        )
      }
      hint={
        isDelete
          ? `${selection} will be removed from disk. This cannot be undone.`
          : `${selection} will stay on this Mac. To bring ${confirm.projects.length === 1 ? 'it' : 'them'} back: Import, then Local folder.`
      }
      loading={loading}
      confirmLabel={isDelete ? 'Delete files' : 'Remove from projects'}
      loadingLabel={isDelete ? 'Deleting…' : 'Removing…'}
      confirmVariant={isDelete ? 'danger' : 'strong'}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
