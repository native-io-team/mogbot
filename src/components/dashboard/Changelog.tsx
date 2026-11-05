/**
 * Changelog component that displays recent releases on the dashboard.
 * When this build has a releases page (`links.releases` in brand.json), users
 * can click any version to rewind/downgrade to it.
 *
 * ⚠️  RELEASE CHECKLIST: Update the CHANGELOG array below when releasing!
 *     Add new version at the TOP with user-facing changes.
 *     Keep ~15 most recent versions.
 */

import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { WarningIcon } from '@/components/icons';
import { trackEvent, trackError } from '../../lib/analytics';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { installVersion, VERSION_INSTALL_ENABLED } from '../../lib/updater';
import { Button } from '../primitives/Button';

interface ChangelogEntry {
  version: string;
  items: string[];
}

// Changelog data - update this with each release!
// Keep ~15 most recent versions for the sidebar.
// Starts empty: the inherited entries were Ship Studio's release history, not
// this app's. While it is empty, "What's new" is hidden everywhere.
const CHANGELOG: ChangelogEntry[] = [];

/** Whether there is anything to show; entry points hide "What's new" when not. */
export const HAS_CHANGELOG: boolean = CHANGELOG.length > 0;

type RewindStage = 'confirm' | 'downloading' | 'installing' | 'done' | 'error';

interface ChangelogProps {
  className?: string;
}

export function Changelog({ className = '' }: ChangelogProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [rewindVersion, setRewindVersion] = useState<string | null>(null);
  const [rewindStage, setRewindStage] = useState<RewindStage>('confirm');
  const [rewindError, setRewindError] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion);
  }, []);

  // Listen for progress events from the backend
  useEffect(() => {
    const unlisten = listen<{ stage: string }>('rewind-progress', (event) => {
      const stage = event.payload.stage;
      if (stage === 'downloading' || stage === 'installing' || stage === 'done') {
        setRewindStage(stage);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleRewind = useCallback(async () => {
    if (!rewindVersion) return;
    setRewindStage('downloading');
    setRewindError(null);

    try {
      await installVersion(rewindVersion);
      void trackEvent('version_rewind_completed', {
        target_version: rewindVersion,
        $screen_name: 'Dashboard',
      });
      setRewindStage('done');
    } catch (err: unknown) {
      trackError('version_rewind', err, 'Dashboard');
      setRewindStage('error');
      setRewindError(formatCommandError(asCommandError(err)));
    }
  }, [rewindVersion]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch (err) {
      trackError('app_restart', err, 'Dashboard');
      setRewindError('Failed to restart. Please restart manually.');
    }
  }, []);

  const closeModal = () => {
    setRewindVersion(null);
    setRewindStage('confirm');
    setRewindError(null);
  };

  const isWorking = rewindStage === 'downloading' || rewindStage === 'installing';

  return (
    <div className={`changelog ${className}`} data-education-id="changelog-sidebar">
      <div className="changelog-header">
        <h3>What's New</h3>
        <span className="changelog-subtitle">Recent updates</span>
      </div>
      <div className="changelog-list">
        {CHANGELOG.map((entry) => {
          const isCurrent = currentVersion === entry.version;
          return (
            <div key={entry.version} className="changelog-entry">
              <div className="changelog-entry-header">
                {isCurrent ? (
                  <span className="changelog-version">
                    v{entry.version}
                    <span className="changelog-current-badge">current</span>
                  </span>
                ) : !VERSION_INSTALL_ENABLED ? (
                  <span className="changelog-version">v{entry.version}</span>
                ) : (
                  <button
                    className="changelog-version changelog-version-link"
                    onClick={() => setRewindVersion(entry.version)}
                  >
                    v{entry.version}
                  </button>
                )}
              </div>
              <ul className="changelog-items">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Rewind confirmation modal */}
      {rewindVersion && (
        <div className="rewind-modal" onClick={() => !isWorking && closeModal()}>
          <div className="rewind-content" onClick={(e) => e.stopPropagation()}>
            <div className="rewind-header">
              <WarningIcon size={18} />
              <h3>
                {rewindStage === 'confirm' && `Install v${rewindVersion}?`}
                {rewindStage === 'downloading' && 'Downloading...'}
                {rewindStage === 'installing' && 'Installing...'}
                {rewindStage === 'done' && 'Ready to restart'}
                {rewindStage === 'error' && 'Installation failed'}
              </h3>
            </div>
            <div className="rewind-body">
              {rewindStage === 'confirm' && (
                <p>
                  This will replace your current version
                  {currentVersion && <> (v{currentVersion})</>} with{' '}
                  <strong>v{rewindVersion}</strong>. The app will restart afterward.
                </p>
              )}
              {rewindStage === 'downloading' && (
                <>
                  <p>Downloading v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'installing' && (
                <>
                  <p>Installing v{rewindVersion}...</p>
                  <div className="rewind-progress">
                    <div className="rewind-progress-bar rewind-progress-indeterminate" />
                  </div>
                </>
              )}
              {rewindStage === 'done' && (
                <p>v{rewindVersion} has been installed. Restart to use it.</p>
              )}
              {rewindStage === 'error' && <p className="rewind-error-text">{rewindError}</p>}
            </div>
            <div className="rewind-actions">
              {rewindStage === 'confirm' && (
                <>
                  <Button variant="secondary" onClick={closeModal}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => void handleRewind()}>
                    Install
                  </Button>
                </>
              )}
              {isWorking && (
                <Button variant="secondary" disabled>
                  Installing…
                </Button>
              )}
              {rewindStage === 'done' && (
                <Button variant="primary" onClick={() => void handleRestart()}>
                  Restart now
                </Button>
              )}
              {rewindStage === 'error' && (
                <>
                  <Button variant="secondary" onClick={closeModal}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => void handleRewind()}>
                    Retry
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
