/**
 * Dismissible warning banner shown when editing the main branch.
 *
 * Displayed below the workspace header to warn users they're editing
 * the default branch directly. Can be dismissed for the session,
 * or permanently hidden for the project via checkbox.
 *
 * @module components/MainBranchBanner
 */

import { useState, useEffect } from 'react';
import { WarningIcon, CloseIcon, BranchIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { getHideMainBranchWarning, setHideMainBranchWarning } from '../../lib/project';
import '../../styles/features/main-branch-banner.css';

interface MainBranchBannerProps {
  /** Absolute path to the project directory */
  projectPath: string;
  /** The branch being edited (`main` or `master`), named as it is. */
  branchName: string;
  /** Callback to create a new branch */
  onCreateBranch?: () => void;
  /**
   * Whether the project has a GitHub connection. The Branches pane only exists
   * for a GitHub-connected project (see `useWorkspaceLayout`'s tab
   * projection), so without this the button used to swallow the click with no
   * modal, tab change, or toast — right after the banner offered it as the fix
   * (issue #612).
   */
  isGitHubConnected?: boolean;
}

export function MainBranchBanner({
  projectPath,
  branchName,
  onCreateBranch,
  isGitHubConnected = true,
}: MainBranchBannerProps) {
  const createBranchDisabledReason = isGitHubConnected
    ? undefined
    : 'Connect this project to GitHub to create and switch branches';
  const [isDismissed, setIsDismissed] = useState(false);
  const [shouldHide, setShouldHide] = useState<boolean | null>(null);
  const [hideForProject, setHideForProject] = useState(false);

  // Load persisted preference on mount
  useEffect(() => {
    getHideMainBranchWarning(projectPath)
      .then(setShouldHide)
      .catch(() => setShouldHide(false));
  }, [projectPath]);

  // Still loading preference
  if (shouldHide === null) {
    return null;
  }

  // Permanently hidden for this project
  if (shouldHide) {
    return null;
  }

  // Dismissed for current session
  if (isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (hideForProject) {
      // Save preference to persist across sessions
      void setHideMainBranchWarning(projectPath, true);
    }
    setIsDismissed(true);
  };

  return (
    <div className="main-branch-banner">
      <div className="main-branch-banner-content">
        <WarningIcon size={16} />
        <span className="main-branch-banner-text">
          You're editing <strong>{branchName}</strong> directly.
          {/* Whether pushing deploys anything is the host's business (Hosting
              answers it per commit); the banner only says where work lands. */}
          <span className="main-branch-banner-text-extra">
            {' '}
            Pushing sends changes straight to it.
          </span>
        </span>
        {onCreateBranch && (
          <Button
            variant="default"
            className="main-branch-banner-action"
            onClick={onCreateBranch}
            disabled={createBranchDisabledReason !== undefined}
            title={createBranchDisabledReason}
            leftIcon={<BranchIcon size={14} />}
          >
            Create branch
          </Button>
        )}
      </div>
      <label className="main-branch-banner-checkbox">
        <input
          type="checkbox"
          checked={hideForProject}
          onChange={(e) => setHideForProject(e.target.checked)}
        />
        <span>Don't show again</span>
      </label>
      <IconButton
        variant="ghost"
        size="compact"
        onClick={handleDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        icon={<CloseIcon size={14} />}
      />
    </div>
  );
}
