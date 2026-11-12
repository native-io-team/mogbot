/**
 * ImportTypePicker component - modal with two import options.
 *
 * Presents:
 * - GitHub Repository — Clone from GitHub (existing flow)
 * - Local Folder — Open an existing project from the computer
 *
 * @module components/ImportTypePicker
 */

import { GitHubIcon, FolderIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { THIS_COMPUTER } from '../../lib/computer';

interface ImportTypePickerProps {
  /** Callback when user selects GitHub import */
  onSelectGitHub: () => void;
  /** Callback when user selects local folder import */
  onSelectLocalFolder: () => void;
  /** Callback to close the picker */
  onClose: () => void;
  /** Signed in to GitHub; when not, the GitHub choice says it signs in first. */
  githubConnected?: boolean;
}

export function ImportTypePicker({
  onSelectGitHub,
  onSelectLocalFolder,
  onClose,
  githubConnected = true,
}: ImportTypePickerProps) {
  return (
    <ModalFrame isOpen onClose={onClose} title="Import project" className="import-picker-modal">
      <div className="import-picker-options">
        <button className="import-picker-card" onClick={onSelectGitHub}>
          <div className="import-picker-icon">
            <GitHubIcon size={28} />
          </div>
          <div className="import-picker-text">
            <span className="import-picker-title">GitHub repository</span>
            <span className="import-picker-subtitle">
              {githubConnected ? 'Clone from GitHub' : 'Connect GitHub first, then clone'}
            </span>
          </div>
        </button>
        <button className="import-picker-card" onClick={onSelectLocalFolder}>
          <div className="import-picker-icon">
            <FolderIcon size={28} />
          </div>
          <div className="import-picker-text">
            <span className="import-picker-title">Local folder</span>
            <span className="import-picker-subtitle">
              Open a project that's already on {THIS_COMPUTER}
            </span>
          </div>
        </button>
      </div>
    </ModalFrame>
  );
}
