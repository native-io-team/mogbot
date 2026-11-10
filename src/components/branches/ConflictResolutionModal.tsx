/**
 * Merge conflict resolution modal.
 *
 * Provides a user-friendly interface for resolving git merge conflicts
 * without requiring users to understand git internals.
 *
 * @module components/ConflictResolutionModal
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ConflictedFile,
  getConflictInfo,
  resolveConflict,
  abortMerge,
  completeMerge,
} from '../../lib/conflicts';
import { WarningIcon, CopyIcon, ChevronIcon, GitMergeIcon } from '@/components/icons';
import { trackEvent, trackError } from '../../lib/analytics';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useAsyncState } from '../../hooks/useAsyncState';
import { describeClipboardError, useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';

interface ConflictResolutionModalProps {
  projectPath: string;
  onClose: () => void;
  onResolved: () => void;
  /**
   * Sends a prompt to the agent terminal. When provided, the callout gains a
   * "Send to Agent" button that hands the whole merge to the agent and closes
   * the modal (leaving the merge in progress for the agent to finish).
   */
  onSendToAgent?: (prompt: string) => void;
}

/** Maximum lines to show before truncating with "and X more lines" */
const MAX_PREVIEW_LINES = 20;

export function ConflictResolutionModal({
  projectPath,
  onClose,
  onResolved,
  onSendToAgent,
}: ConflictResolutionModalProps) {
  const { showToast } = useOptionalToast();
  // Wrapped in useCallback so downstream useCallback deps stay stable.
  const onToast = useCallback(
    (message: string, type?: 'success' | 'error') => showToast(message, type),
    [showToast]
  );
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
  const [isApplying, setIsApplying] = useState(false);
  const [showMoreInfo, setShowMoreInfo] = useState(false);

  const {
    data: filesData,
    isLoading,
    error: loadError,
    execute: fetchConflicts,
    setData: setFiles,
  } = useAsyncState<ConflictedFile[]>(() => getConflictInfo(projectPath), { initial: [] });
  const files = filesData ?? [];
  const error = loadError ? loadError.message : null;
  const { copy } = useCopyToClipboard({
    onCopy: () => onToast?.('Copied to clipboard', 'success'),
    onError: (err) =>
      onToast?.(`Failed to copy to clipboard (${describeClipboardError(err)})`, 'error'),
  });

  const loadConflicts = useCallback(async () => {
    const conflictInfo = await fetchConflicts();
    if (conflictInfo && conflictInfo.length === 0) {
      onToast?.('No conflicts found', 'success');
      onResolved();
      onClose();
    }
    if (conflictInfo === null) {
      trackError('conflict_load', loadError ?? new Error('unknown'), 'Conflict Resolution');
    }
  }, [fetchConflicts, onToast, onResolved, onClose, loadError]);

  // Load conflict info on mount
  useEffect(() => {
    void loadConflicts();
  }, [loadConflicts]);

  const currentFile = files[currentFileIndex];
  const currentConflict = currentFile?.conflicts[currentConflictIndex];

  // Calculate total conflicts and current position
  const totalConflicts = files.reduce((sum, f) => sum + f.conflicts.length, 0);
  const currentConflictNumber =
    files.slice(0, currentFileIndex).reduce((sum, f) => sum + f.conflicts.length, 0) +
    currentConflictIndex +
    1;

  const handleResolve = useCallback(
    async (resolution: 'current' | 'incoming') => {
      if (!currentFile || isApplying) return;

      setIsApplying(true);
      try {
        await resolveConflict(projectPath, currentFile.filePath, currentConflictIndex, resolution);
        void trackEvent('conflict_resolved', {
          resolution,
          $screen_name: 'Conflict Resolution',
        });

        // Reload conflicts to get updated state
        const updatedFiles = await getConflictInfo(projectPath);
        setFiles(updatedFiles);

        if (updatedFiles.length === 0) {
          // All conflicts resolved - complete the merge
          await completeMerge(projectPath);
          void trackEvent('merge_completed', {
            total_conflicts: totalConflicts,
            $screen_name: 'Conflict Resolution',
          });
          onToast?.('All conflicts resolved!', 'success');
          onResolved();
          onClose();
          return;
        }

        // Find next conflict to resolve
        // First check if current file still has conflicts
        const updatedCurrentFile = updatedFiles.find((f) => f.filePath === currentFile.filePath);

        if (updatedCurrentFile && updatedCurrentFile.conflicts.length > 0) {
          // Stay on this file, reset to first conflict (since indices shift after resolution)
          const newFileIndex = updatedFiles.findIndex((f) => f.filePath === currentFile.filePath);
          setCurrentFileIndex(newFileIndex);
          setCurrentConflictIndex(0);
        } else {
          // Move to next file
          if (currentFileIndex < updatedFiles.length) {
            setCurrentFileIndex(Math.min(currentFileIndex, updatedFiles.length - 1));
            setCurrentConflictIndex(0);
          }
        }
      } catch (e) {
        trackError('conflict_resolve', e, 'Conflict Resolution');
        onToast?.(formatCommandError(asCommandError(e)) || 'Failed to resolve conflict', 'error');
      } finally {
        setIsApplying(false);
      }
    },
    // setFiles is the stable useAsyncState setter; including it would add
    // churn with no behavior change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      currentFile,
      currentFileIndex,
      currentConflictIndex,
      totalConflicts,
      projectPath,
      onClose,
      onResolved,
      onToast,
      isApplying,
    ]
  );

  const handleAbort = useCallback(async () => {
    if (isApplying) return;

    setIsApplying(true);
    try {
      await abortMerge(projectPath);
      void trackEvent('merge_aborted', { $screen_name: 'Conflict Resolution' });
      onToast?.('Merge cancelled', 'success');
      onClose();
    } catch (e) {
      trackError('merge_abort', e, 'Conflict Resolution');
      onToast?.(formatCommandError(asCommandError(e)) || 'Couldn’t cancel the merge', 'error');
    } finally {
      setIsApplying(false);
    }
  }, [projectPath, onClose, onToast, isApplying]);

  // Close handler - abort merge when closing without resolving
  const handleClose = useCallback(() => {
    if (isApplying) return;
    void handleAbort();
  }, [isApplying, handleAbort]);

  const handleCopyForClaude = useCallback(() => {
    if (!currentFile || !currentConflict) return;

    const prompt = `I have a merge conflict in ${currentFile.filePath} that I need help resolving.

**Current version (${currentFile.oursBranch}):**
\`\`\`
${currentConflict.currentContent}
\`\`\`

**Incoming version (${currentFile.theirsBranch}):**
\`\`\`
${currentConflict.incomingContent}
\`\`\`

${currentConflict.contextBefore ? `**Context before:**\n\`\`\`\n${currentConflict.contextBefore}\n\`\`\`\n` : ''}
${currentConflict.contextAfter ? `**Context after:**\n\`\`\`\n${currentConflict.contextAfter}\n\`\`\`\n` : ''}
Please help me understand what each version does and recommend which one to keep, or suggest a manual merge if both changes are needed.`;

    void copy(prompt);
  }, [currentFile, currentConflict, copy]);

  // Hand the whole merge to the agent: it has file access, so the prompt
  // lists the conflicted files and asks it to resolve and complete the merge.
  // Closes via onClose directly (NOT handleClose) so the in-progress merge is
  // left intact for the agent instead of being aborted.
  const handleSendToAgent = useCallback(() => {
    if (!onSendToAgent) return;

    const fileList = (filesData ?? []).map((f) => `- ${f.filePath}`).join('\n');
    const prompt = `This project has git merge conflicts that I need you to resolve.

Conflicted files:
${fileList}

Please:
1. Open each conflicted file and resolve the conflict markers (<<<<<<< / ======= / >>>>>>>), preserving the intent of both sides where possible
2. Stage the resolved files
3. Complete the merge with a commit

If a resolution is genuinely ambiguous, show me the options and ask before choosing.`;

    onSendToAgent(prompt);
    onToast?.('Sent to your agent — continue in the terminal', 'success');
    onClose();
  }, [onSendToAgent, filesData, onToast, onClose]);

  const truncateContent = (content: string): { text: string; truncated: number } => {
    const lines = content.split('\n');
    if (lines.length <= MAX_PREVIEW_LINES) {
      return { text: content, truncated: 0 };
    }
    return {
      text: lines.slice(0, MAX_PREVIEW_LINES).join('\n'),
      truncated: lines.length - MAX_PREVIEW_LINES,
    };
  };

  if (isLoading) {
    return (
      <ModalFrame
        isOpen
        onClose={handleClose}
        ariaLabel="Conflict resolution"
        showCloseButton={false}
        className="conflict-content"
      >
        <div className="conflict-loading">
          <Spinner size="lg" />
          <p>Reading the conflicts…</p>
        </div>
      </ModalFrame>
    );
  }

  if (error) {
    return (
      <ModalFrame
        isOpen
        onClose={handleClose}
        ariaLabel="Conflict resolution"
        showCloseButton={false}
        className="conflict-content"
      >
        <div className="conflict-error">
          <WarningIcon size={32} />
          <p>{error}</p>
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
        </div>
      </ModalFrame>
    );
  }

  // Files the UI can't text-merge carry no conflict blocks: binary files,
  // and non-regular paths (submodule / file-vs-folder type-change conflicts,
  // issue #528) which arrive with a per-file `unsupportedReason`. Render the
  // notice before the currentConflict guard below — these entries would
  // otherwise fall through to `return null` and leave the modal blank.
  const fileNotice =
    currentFile && !currentConflict
      ? (currentFile.unsupportedReason ??
        (currentFile.isBinary
          ? "This file isn't text, so it can't be merged line by line here. Keep one version in your editor, or hand the merge to your agent."
          : null))
      : null;

  if (currentFile && fileNotice) {
    return (
      <ModalFrame
        isOpen
        onClose={handleClose}
        dismissable={!isApplying}
        showCloseButton={false}
        className="conflict-content"
        ariaLabel="Resolve file conflict"
      >
        <>
          <div className="conflict-header">
            <div className="conflict-header-icon">
              <WarningIcon size={20} />
            </div>
            <div className="conflict-header-text">
              <h2>This conflict can&apos;t be resolved here</h2>
              <p className="conflict-file-info">
                <span className="conflict-file-name">{currentFile.filePath}</span>
              </p>
            </div>
          </div>
          <div className="conflict-binary">
            <p>{fileNotice}</p>
            <div className="conflict-binary-actions">
              <Button variant="danger" onClick={() => void handleAbort()} disabled={isApplying}>
                Cancel the merge
              </Button>
              {onSendToAgent && (
                <Button variant="secondary" onClick={handleSendToAgent}>
                  Send to agent
                </Button>
              )}
            </div>
          </div>
        </>
      </ModalFrame>
    );
  }

  if (!currentFile || !currentConflict) {
    return null;
  }

  const currentTruncated = truncateContent(currentConflict.currentContent);
  const incomingTruncated = truncateContent(currentConflict.incomingContent);

  // Check for deleted content
  const isCurrentDeleted = !currentConflict.currentContent.trim();
  const isIncomingDeleted = !currentConflict.incomingContent.trim();
  const truncatedAny = currentTruncated.truncated > 0 || incomingTruncated.truncated > 0;
  const hasMore = truncatedAny || !!currentConflict.contextBefore || !!currentConflict.contextAfter;

  return (
    <ModalFrame
      isOpen
      onClose={handleClose}
      ariaLabel={`Resolve conflicts in ${currentFile.filePath}`}
      dismissable={!isApplying}
      showCloseButton={false}
      className="conflict-content conflict-content-wide"
    >
      <>
        {/* Header */}
        <div className="conflict-header">
          <div className="conflict-header-icon">
            <GitMergeIcon size={18} />
          </div>
          <div className="conflict-header-text">
            <h2>This file has conflicting changes</h2>
            <p className="conflict-file-info">
              <span className="conflict-file-name">{currentFile.filePath}</span>
              <span className="conflict-progress">
                {totalConflicts > 1 && `Conflict ${currentConflictNumber} of ${totalConflicts}`}
              </span>
            </p>
          </div>
        </div>

        <p className="conflict-explanation">
          Both branches changed the same lines. Choose which version to keep.
        </p>

        {/* Binary file handling */}
        {currentFile.isBinary ? (
          <div className="conflict-binary">
            <p>
              This file isn&apos;t text, so it can&apos;t be merged line by line here. Keep one
              version in your editor, or hand the merge to your agent.
            </p>
          </div>
        ) : (
          <>
            {/* Side-by-side panels */}
            <div className="conflict-panels">
              {/* Current (Ours) panel */}
              <div className="conflict-panel">
                <div className="conflict-panel-header yours">
                  Yours
                  <span className="conflict-branch-name">{currentFile.oursBranch}</span>
                </div>
                <div className="conflict-panel-content">
                  {isCurrentDeleted ? (
                    <span className="conflict-deleted">(deleted)</span>
                  ) : (
                    <>
                      <pre>{currentTruncated.text}</pre>
                      {currentTruncated.truncated > 0 && (
                        <div className="conflict-truncated">
                          …and {currentTruncated.truncated} more lines
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Incoming (Theirs) panel */}
              <div className="conflict-panel">
                <div className="conflict-panel-header theirs">
                  Theirs
                  <span className="conflict-branch-name">{currentFile.theirsBranch}</span>
                </div>
                <div className="conflict-panel-content">
                  {isIncomingDeleted ? (
                    <span className="conflict-deleted">(deleted)</span>
                  ) : (
                    <>
                      <pre>{incomingTruncated.text}</pre>
                      {incomingTruncated.truncated > 0 && (
                        <div className="conflict-truncated">
                          …and {incomingTruncated.truncated} more lines
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="conflict-actions">
              <button
                className="conflict-btn yours"
                onClick={() => void handleResolve('current')}
                disabled={isApplying}
              >
                {isApplying ? 'Keeping…' : 'Keep yours'}
              </button>
              <button
                className="conflict-btn theirs"
                onClick={() => void handleResolve('incoming')}
                disabled={isApplying}
              >
                {isApplying ? 'Keeping…' : 'Keep theirs'}
              </button>
            </div>

            {/* Need parts of both: the agent can combine them. One way there:
                Send when there's a session to send to, else Copy. */}
            <div className="conflict-callout">
              <span>Need parts of both? Your agent can combine them.</span>
              {onSendToAgent ? (
                <Button variant="secondary" size="compact" onClick={handleSendToAgent}>
                  Send to agent
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="compact"
                  leftIcon={<CopyIcon size={12} />}
                  onClick={handleCopyForClaude}
                >
                  Copy a prompt
                </Button>
              )}
            </div>

            {hasMore && (
              <div className="conflict-more-info">
                <button
                  type="button"
                  className="conflict-more-toggle"
                  aria-expanded={showMoreInfo}
                  onClick={() => setShowMoreInfo(!showMoreInfo)}
                >
                  <span className={`conflict-toggle-chevron ${showMoreInfo ? 'expanded' : ''}`}>
                    <ChevronIcon size={12} />
                  </span>
                  {truncatedAny
                    ? 'The whole of both, and the lines around them'
                    : 'The lines around them'}
                </button>

                {showMoreInfo && (
                  <div className="conflict-more-content">
                    {currentConflict.contextBefore && (
                      <div className="conflict-context">
                        <div className="conflict-context-label">Before</div>
                        <pre>{currentConflict.contextBefore}</pre>
                      </div>
                    )}
                    {truncatedAny && (
                      <div className="conflict-diff">
                        <div className="conflict-diff-section">
                          <div className="conflict-diff-label">Yours, in full</div>
                          <pre>{currentConflict.currentContent || '(empty)'}</pre>
                        </div>
                        <div className="conflict-diff-section">
                          <div className="conflict-diff-label">Theirs, in full</div>
                          <pre>{currentConflict.incomingContent || '(empty)'}</pre>
                        </div>
                      </div>
                    )}
                    {currentConflict.contextAfter && (
                      <div className="conflict-context">
                        <div className="conflict-context-label">After</div>
                        <pre>{currentConflict.contextAfter}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="conflict-footer">
          <Button variant="danger" onClick={() => void handleAbort()} disabled={isApplying}>
            Cancel the merge
          </Button>
          <span className="conflict-footer-note">Closing this cancels the merge too.</span>
        </div>
      </>
    </ModalFrame>
  );
}
