/**
 * Project tools: what a project needs on this computer, asked for the first
 * time work becomes a project (see `lib/projectTools`).
 *
 * First a plain list of what's missing and one button. Then the user's own
 * agent installs it in a terminal while the checklist beside it ticks green
 * from the app's own checks (`GuidedSetupPhase`), never from the agent's
 * word. Continue picks up what the user was doing.
 *
 * @module components/setup/ProjectToolsModal
 */

import { useCallback, useEffect, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { GuidedSetupPhase } from './agent-led/GuidedSetupPhase';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { getFullSetupStatus, SETUP_FRIENDLY_NAMES, type FullSetupStatus } from '../../lib/setup';
import {
  areProjectToolsReady,
  getMissingProjectTools,
  getOnboardingTestMode,
  readyAgentsEngine,
} from '../../lib/agentOnboarding';
import { clearPendingProjectAction, takePendingProjectAction } from '../../lib/projectTools';
import { getAgentById } from '../../lib/agent';

/** Plain names for the list; the checklist keeps the tools' own names. */
const PLAIN_NAMES: Record<string, string> = {
  homebrew: 'A package manager, to install the rest',
  node: 'Node.js, which most sites and apps run on',
  npm_fix: 'A permissions fix for Node.js',
  git: 'Git, which keeps every version of your work',
  gh: 'GitHub’s command-line tool',
  gh_auth: 'A GitHub sign-in, where your projects are kept',
};

interface ProjectToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectToolsModal({ isOpen, onClose }: ProjectToolsModalProps) {
  const status = useAsyncState<FullSetupStatus>(getFullSetupStatus);
  const testMode = useAsyncState(getOnboardingTestMode);
  const [started, setStarted] = useState(false);
  const { execute: loadStatus } = status;
  const { execute: loadTestMode } = testMode;

  useEffect(() => {
    if (!isOpen) return;
    void loadStatus();
    void loadTestMode();
  }, [isOpen, loadStatus, loadTestMode]);

  const items = status.data?.items ?? [];
  const engine = readyAgentsEngine(items);
  const ready = items.length > 0 && areProjectToolsReady(items, engine);
  usePolling(loadStatus, {
    intervalMs: 3000,
    enabled: isOpen && started && !ready,
    name: 'projectToolsStatus',
  });

  const close = useCallback(() => {
    clearPendingProjectAction();
    setStarted(false);
    onClose();
  }, [onClose]);

  const finish = useCallback(() => {
    const action = takePendingProjectAction();
    setStarted(false);
    onClose();
    action?.();
  }, [onClose]);

  const engineName = engine
    ? getAgentById(engine === 'claude' ? 'claude-code' : engine).displayName
    : null;
  const missing = getMissingProjectTools(items);

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={close}
      title="Before your first project"
      className={`project-tools-modal${started ? ' is-running' : ''}`}
    >
      <div className="settings-modal-body project-tools">
        {!status.data ? (
          <div className="project-tools__loading">
            {status.error ? <p>Couldn’t check this computer. Close and try again.</p> : <Spinner />}
          </div>
        ) : started && engine ? (
          <GuidedSetupPhase
            agentBinaryId={engine}
            agentDisplayName={engineName ?? 'Your agent'}
            items={items}
            hostChoice={null}
            demoMode={testMode.data?.mock ?? false}
            onVerified={finish}
          />
        ) : (
          <>
            <p className="project-tools__lede">
              Projects (a site, an app) are built on this computer, so it needs a few tools the
              first time. Nothing else needed them until now.
            </p>
            {missing.length > 0 ? (
              <ul className="project-tools__list">
                {missing.map((item) => (
                  <li key={item.id}>{PLAIN_NAMES[item.id] ?? SETUP_FRIENDLY_NAMES[item.id]}</li>
                ))}
              </ul>
            ) : (
              <p className="project-tools__lede">Everything is already here.</p>
            )}
            {engine ? (
              <p className="project-tools__note">
                {engineName} installs them in a terminal and explains each step. This computer
                checks each one itself, and you carry on when they’re all there.
              </p>
            ) : (
              <p className="project-tools__note">
                Set up Claude Code or Codex in Agents first; it does the installing.
              </p>
            )}
            <div className="project-tools__actions">
              <Button variant="ghost" onClick={close}>
                Not now
              </Button>
              {missing.length === 0 ? (
                <Button variant="primary" onClick={finish}>
                  Continue
                </Button>
              ) : (
                <Button variant="primary" disabled={!engine} onClick={() => setStarted(true)}>
                  Set them up
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  );
}
