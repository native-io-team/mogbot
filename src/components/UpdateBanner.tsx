/**
 * Sidebar update indicator and release-specific update modal.
 *
 * Shown only once an update has downloaded in the background and passed its
 * signature check (`lib/updateStore`): "A new version is ready", with
 * "Restart to update". Hovering or focusing reveals the release's titles;
 * selecting them opens the full notes. Later hides it for that version.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  dismissUpdate,
  getUpdateSnapshot,
  installAndRestart,
  startAutomaticUpdateChecks,
  subscribeUpdates,
} from '../lib/updateStore';
import { agentsBusy } from '../lib/agents';
import { usePolling } from '../hooks/usePolling';
import { CloseIcon, ErrorIcon, ResetIcon } from '@/components/icons';
import { Button } from './primitives/Button';
import { IconButton } from './primitives/IconButton';
import { ModalFrame } from './primitives/ModalFrame';
import { Spinner } from './primitives/Spinner';
import '../styles/features/update-banner.css';

export interface ReleaseNote {
  title: string;
  detail?: string;
}

function cleanInlineMarkdown(value: string): string {
  return (
    value
      .replace(/^#{1,6}\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      // Unbalanced leftovers (a bold marker split across lines, a stray
      // backtick) must never reach the UI verbatim.
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Parse only the available version's bullets from the updater's Markdown body. */
export function parseReleaseNotes(body: string | undefined, version: string): ReleaseNote[] {
  if (!body?.trim()) return [];

  const lines = body.split(/\r?\n/);
  const versionHeading = new RegExp(`^#{1,6}\\s+.*v?${version.replace(/\./g, '\\.')}\\b`, 'i');
  const matchingHeadingIndex = lines.findIndex((line) => versionHeading.test(line.trim()));
  const start = matchingHeadingIndex >= 0 ? matchingHeadingIndex + 1 : 0;
  const notes: ReleaseNote[] = [];
  // Some releases ship prose instead of bullets. Without this, every such line
  // was dropped and the modal claimed there was nothing to say.
  const hasBullets = lines.slice(start).some((line) => /^(?:[-*+]|•)\s+/.test(line.trim()));

  let previousLineWasBlank = true;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s+/.test(line)) {
      if (notes.length > 0 || matchingHeadingIndex >= 0) break;
      previousLineWasBlank = true;
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|•)\s+(.+)$/);
    if (bullet) {
      const content = bullet[1].trim();
      const emphasized = content.match(/^\*\*(.+?)\*\*\s*(?:[-–—:]\s*)?(.*)$/);
      if (emphasized) {
        notes.push({
          title: cleanInlineMarkdown(emphasized[1]),
          detail: cleanInlineMarkdown(emphasized[2]) || undefined,
        });
      } else {
        const separated = content.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        notes.push({
          title: cleanInlineMarkdown(separated?.[1] ?? content),
          detail: separated ? cleanInlineMarkdown(separated[2]) : undefined,
        });
      }
      previousLineWasBlank = false;
      continue;
    }

    if (!line) {
      previousLineWasBlank = true;
      continue;
    }

    // A wrapped continuation line belongs to the note above it. In a
    // bullet-less body a blank line starts a new note instead.
    if (notes.length > 0 && (hasBullets || !previousLineWasBlank)) {
      const current = notes[notes.length - 1];
      current.detail = cleanInlineMarkdown([current.detail, line].filter(Boolean).join(' '));
      previousLineWasBlank = false;
      continue;
    }

    if (!hasBullets) {
      const separated = line.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      notes.push({
        title: cleanInlineMarkdown(separated?.[1] ?? line),
        detail: separated ? cleanInlineMarkdown(separated[2]) : undefined,
      });
    }
    previousLineWasBlank = false;
  }

  return notes;
}

export function UpdateBanner() {
  const update = useSyncExternalStore(subscribeUpdates, getUpdateSnapshot);
  const [modalOpen, setModalOpen] = useState(false);
  const [waitingForAgents, setWaitingForAgents] = useState(false);

  // Idempotent: the first sidebar to mount in the main window starts them.
  useEffect(() => startAutomaticUpdateChecks(), []);

  const version = update.info?.version ?? '';
  const releaseNotes = useMemo(
    () => parseReleaseNotes(update.info?.body, version),
    [update.info, version]
  );

  // A restart mid-turn cuts an agent off, so the update waits for working
  // agents to finish. Clicking again while it waits restarts now.
  const handleRestart = useCallback(async () => {
    if (!waitingForAgents && (await agentsBusy().catch(() => 0)) > 0) {
      setWaitingForAgents(true);
      return;
    }
    setWaitingForAgents(false);
    setModalOpen(false);
    await installAndRestart();
  }, [waitingForAgents]);

  usePolling(
    async () => {
      if ((await agentsBusy()) === 0) {
        setWaitingForAgents(false);
        await installAndRestart();
      }
    },
    // Restarts the app once agents are done, whether or not anyone is looking.
    {
      intervalMs: 3000,
      enabled: waitingForAgents,
      name: 'update-wait-for-agents',
      whileHidden: true,
    }
  );

  const handleLater = useCallback(() => {
    setWaitingForAgents(false);
    setModalOpen(false);
    dismissUpdate();
  }, []);

  const { phase } = update;
  const shown = phase === 'ready' || phase === 'installing' || phase === 'error';
  if (!shown || !update.info || update.dismissed) return null;

  const label =
    phase === 'installing'
      ? 'Installing…'
      : phase === 'error'
        ? 'Update needs attention'
        : waitingForAgents
          ? 'After agents finish'
          : 'Restart to update';
  const actionLabel =
    phase === 'installing'
      ? `Installing version ${version}`
      : phase === 'error'
        ? `Try updating to version ${version} again`
        : waitingForAgents
          ? `Restarting for version ${version} once agents finish. Restart now`
          : `Restart to update to version ${version}`;

  return (
    <>
      <div className={`update-indicator update-indicator--${phase}`}>
        <button
          type="button"
          className="update-indicator-details"
          onClick={() => setModalOpen(true)}
          disabled={phase === 'installing'}
          aria-label={`View what's new in version ${version}`}
        >
          <span className="update-indicator-details-inner">
            <span className="update-indicator-version">
              Version {version} is ready — view changes
            </span>
            {releaseNotes.length > 0 && (
              <span className="update-indicator-notes">
                {releaseNotes.map((note, index) => (
                  <span className="update-indicator-note" key={`${note.title}-${index}`}>
                    {note.title}
                  </span>
                ))}
              </span>
            )}
          </span>
        </button>
        <div className="update-indicator-summary">
          <button
            type="button"
            className="update-indicator-update-action"
            onClick={() => (phase === 'error' ? setModalOpen(true) : void handleRestart())}
            disabled={phase === 'installing'}
            aria-label={actionLabel}
          >
            <span className="update-indicator-icon" aria-hidden="true">
              {phase === 'installing' ? (
                <Spinner size="sm" />
              ) : phase === 'error' ? (
                <ErrorIcon size={14} />
              ) : (
                <ResetIcon size={14} />
              )}
            </span>
            <span className="update-indicator-label">{label}</span>
          </button>
          {phase !== 'installing' && (
            <IconButton
              variant="ghost"
              size="default"
              className="update-indicator-dismiss"
              icon={<CloseIcon size={14} />}
              onClick={handleLater}
              title="Not now: hide until the next version"
              aria-label="Not now: hide until the next version"
            />
          )}
        </div>
      </div>

      <ModalFrame
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`What's new in ${version}`}
        className="update-details-modal"
        dismissable={phase !== 'installing'}
        showCloseButton={phase !== 'installing'}
      >
        <div className="update-details-body">
          {releaseNotes.length > 0 ? (
            <ul className="update-details-list">
              {releaseNotes.map((note, index) => (
                <li key={`${note.title}-${index}`}>
                  <h3>{note.title}</h3>
                  {note.detail && <p>{note.detail}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="update-details-empty">This version is ready to install.</p>
          )}

          {phase === 'error' && update.error && (
            <p className="update-details-error" role="alert">
              {update.error}
            </p>
          )}
        </div>

        <div className="update-details-actions">
          {phase !== 'installing' && (
            <Button variant="secondary" onClick={handleLater}>
              Later
            </Button>
          )}
          {phase === 'installing' ? (
            <Button variant="primary" disabled leftIcon={<Spinner size="sm" />}>
              Installing…
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void handleRestart()}>
              {phase === 'error' ? 'Try again' : 'Restart to update'}
            </Button>
          )}
        </div>
      </ModalFrame>
    </>
  );
}
