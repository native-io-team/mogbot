/**
 * Project tools, asked for in context.
 *
 * Onboarding asks only for an agent engine. The tools a project needs on
 * this computer (a package manager, Node, Git, a GitHub sign-in) are asked
 * for the first time work becomes a project: creating or importing one runs
 * through `useProjectToolsGate`, which opens the Project tools dialog when
 * something is missing and carries on with what the user was doing once the
 * app's own checks pass.
 *
 * @module lib/projectTools
 */

import { useCallback } from 'react';
import { getFullSetupStatus } from './setup';
import { getMissingProjectTools } from './agentOnboarding';
import { useOpenModal } from '../contexts/ModalContext';
import { logger } from './logger';

/** What the user was doing when the dialog opened; run once tools are ready. */
let pending: (() => void) | null = null;

/** The action waiting on the dialog, taken once (the dialog runs it). */
export function takePendingProjectAction(): (() => void) | null {
  const action = pending;
  pending = null;
  return action;
}

/** Dropped when the dialog is closed without finishing. */
export function clearPendingProjectAction() {
  pending = null;
}

/** The three ways a project starts (new, import, local folder), each gated. */
export function useGatedProjectStarts(starts: {
  createProject: () => void;
  importProject: () => void;
  importLocalFolder: () => Promise<void>;
}) {
  const gate = useProjectToolsGate();
  const { createProject, importProject, importLocalFolder } = starts;
  return {
    handleCreateProject: useCallback(() => gate(createProject), [gate, createProject]),
    handleImportProject: useCallback(() => gate(importProject), [gate, importProject]),
    handleImportLocalFolder: useCallback(
      () => Promise.resolve(gate(() => void importLocalFolder())),
      [gate, importLocalFolder]
    ),
  };
}

/**
 * Wrap an action that starts a project: it runs straight away when the
 * project tools are there, and after the Project tools dialog otherwise.
 * When the check itself fails the action runs anyway: a check we couldn't
 * make is no reason to block, and the action reports its own errors.
 */
export function useProjectToolsGate() {
  const openModal = useOpenModal();
  return useCallback(
    (action: () => void) => {
      void (async () => {
        try {
          const status = await getFullSetupStatus();
          if (getMissingProjectTools(status.items).length === 0) {
            action();
            return;
          }
        } catch (err) {
          logger.warn('Project tools check failed; carrying on', { error: String(err) });
          action();
          return;
        }
        pending = action;
        openModal('projectTools');
      })();
    },
    [openModal]
  );
}
