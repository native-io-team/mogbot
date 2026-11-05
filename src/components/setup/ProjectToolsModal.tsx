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
import { Checkbox } from '../primitives/Checkbox';
import { Spinner } from '../primitives/Spinner';
import { GuidedSetupPhase } from './agent-led/GuidedSetupPhase';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { getFullSetupStatus, SETUP_FRIENDLY_NAMES, type FullSetupStatus } from '../../lib/setup';
import {
  getMissingOptionalTools,
  getMissingRequiredTools,
  getOnboardingTestMode,
  projectToolIds,
  readyAgentsEngine,
} from '../../lib/agentOnboarding';
import {
  clearPendingProjectAction,
  declineGitHub,
  forgetProjectToolsCheck,
  hasPendingProjectAction,
  takePendingProjectAction,
} from '../../lib/projectTools';
import { getAgentById } from '../../lib/agent';

/** Plain names for the list; the checklist keeps the tools' own names. */
const PLAIN_NAMES: Record<string, string> = {
  homebrew: 'A package manager, to install the rest',
  node: 'Node.js, which most sites and apps run on',
  npm_fix: 'A permissions fix for Node.js',
  git: 'Git, which keeps every version of your work',
};

interface ProjectToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectToolsModal({ isOpen, onClose }: ProjectToolsModalProps) {
  const status = useAsyncState<FullSetupStatus>(getFullSetupStatus);
  const testMode = useAsyncState(getOnboardingTestMode);
  /** The items this run sets up and checks, fixed when it starts. */
  const [running, setRunning] = useState<string[] | null>(null);
  const [withGitHub, setWithGitHub] = useState(true);
  const { execute: loadStatus } = status;
  const { execute: loadTestMode } = testMode;

  useEffect(() => {
    if (!isOpen) return;
    void loadStatus();
    void loadTestMode();
  }, [isOpen, loadStatus, loadTestMode]);

  const items = status.data?.items ?? [];
  const engine = readyAgentsEngine(items);
  usePolling(loadStatus, {
    intervalMs: 3000,
    enabled: isOpen && running !== null,
    name: 'projectToolsStatus',
  });

  // Opened by an agent's create_project there's nothing to carry on with,
  // so closing loses nothing; opened by a project start, closing cancels it.
  const waiting = isOpen && hasPendingProjectAction();

  const close = useCallback(() => {
    clearPendingProjectAction();
    setRunning(null);
    onClose();
  }, [onClose]);

  const finish = useCallback(() => {
    const action = takePendingProjectAction();
    setRunning(null);
    onClose();
    action?.();
  }, [onClose]);

  const continueWithout = useCallback(() => {
    declineGitHub();
    finish();
  }, [finish]);

  const engineName = engine
    ? getAgentById(engine === 'claude' ? 'claude-code' : engine).displayName
    : null;
  const required = getMissingRequiredTools(items);
  const optional = getMissingOptionalTools(items);
  const start = (includeGitHub: boolean) => {
    forgetProjectToolsCheck();
    setRunning(projectToolIds(items, includeGitHub));
  };

  return (
    <ModalFrame
      isOpen={isOpen}
      onClose={close}
      title={
        required.length === 0 && optional.length > 0 ? 'Connect GitHub?' : 'Set up project tools'
      }
      className={`project-tools-modal${running ? ' is-running' : ''}`}
    >
      <div className="settings-modal-body project-tools">
        {!status.data ? (
          <div className="project-tools__loading">
            {status.error ? <p>Couldn’t check this computer. Close and try again.</p> : <Spinner />}
          </div>
        ) : running && engine ? (
          <GuidedSetupPhase
            agentBinaryId={engine}
            agentDisplayName={engineName ?? 'Your agent'}
            items={items}
            toolIds={running}
            demoMode={testMode.data?.mock ?? false}
            onVerified={finish}
          />
        ) : required.length > 0 ? (
          <>
            <p className="project-tools__lede">
              Projects (a site, an app) are built on this computer. It needs these first:
            </p>
            <ul className="project-tools__list">
              {required.map((item) => (
                <li key={item.id}>{PLAIN_NAMES[item.id] ?? SETUP_FRIENDLY_NAMES[item.id]}</li>
              ))}
            </ul>
            {optional.length > 0 && (
              <label className="project-tools__option">
                <Checkbox
                  checked={withGitHub}
                  onChange={setWithGitHub}
                  label="Also connect GitHub"
                />
                <span>
                  Also connect GitHub <span className="project-tools__optional">Optional</span>
                  <span className="project-tools__hint">
                    Where projects are backed up and shared for review.
                  </span>
                </span>
              </label>
            )}
            <EngineNote engineName={engineName} />
            <div className="project-tools__actions">
              <Button variant="ghost" onClick={close}>
                {waiting ? 'Cancel' : 'Not now'}
              </Button>
              <Button
                variant="primary"
                disabled={!engine}
                onClick={() => start(optional.length > 0 && withGitHub)}
              >
                Set them up
              </Button>
            </div>
          </>
        ) : optional.length > 0 ? (
          <>
            <p className="project-tools__lede">
              Everything a project needs is here. GitHub is optional: it’s where projects are backed
              up and shared for review, and you can connect it any time.
            </p>
            <EngineNote engineName={engineName} />
            <div className="project-tools__actions">
              <Button variant="ghost" onClick={waiting ? continueWithout : close}>
                {waiting ? 'Continue without' : 'Not now'}
              </Button>
              <Button variant="primary" disabled={!engine} onClick={() => start(true)}>
                Connect GitHub
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="project-tools__lede">Everything a project needs is already here.</p>
            <div className="project-tools__actions">
              <Button variant="primary" onClick={finish}>
                {waiting ? 'Continue' : 'Done'}
              </Button>
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  );
}

function EngineNote({ engineName }: { engineName: string | null }) {
  return engineName ? (
    <p className="project-tools__note">
      {engineName} installs them in a terminal and explains each step. This computer checks each one
      itself, and you carry on when they’re all there.
    </p>
  ) : (
    <p className="project-tools__note">
      Set up Claude Code or Codex in Agents first; it does the installing.
    </p>
  );
}
