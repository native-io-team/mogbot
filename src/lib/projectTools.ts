/**
 * Project tools, asked for in context.
 *
 * Onboarding asks only for an agent engine. The tools a project needs on
 * this Mac are asked for the first time work becomes a project:
 * creating or importing one runs through `useProjectToolsGate`, which opens
 * "Set up project tools" when something is missing and carries on with what
 * the user was doing once the app's own checks pass.
 *
 * Only Node and Git are required. GitHub is offered alongside; "Continue
 * without" is remembered, so it is offered once, not on every project.
 *
 * A passing check is kept for the rest of the session (tools don't vanish
 * mid-session), so only the first project start waits on it. It's dropped
 * when a check fails or an agent reports a tool missing.
 *
 * @module lib/projectTools
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { CreateProjectTab } from '../components/dashboard/CreateProject';
import { listen } from '@tauri-apps/api/event';
import { getFullSetupStatus, type SetupItem } from './setup';
import { getMissingOptionalTools, getMissingRequiredTools } from './agentOnboarding';
import { useOpenModal } from '../contexts/ModalContext';
import { logger } from './logger';
import { BRAND } from './brand';

/** Which way a project was being started, for the spinner on that button. */
export type ProjectStart = 'create' | 'import' | 'local';

/** What the user was doing when the dialog opened; run once tools are ready. */
let pending: (() => void) | null = null;
/** The last check passed this session: start projects without asking again. */
let knownReady = false;
/** The start whose check is running, if any. */
let checking: ProjectStart | null = null;
const listeners = new Set<() => void>();

function setChecking(next: ProjectStart | null) {
  checking = next;
  for (const l of listeners) l();
}

/** The start whose check is running: its button shows a spinner. */
export function useProjectToolsChecking(): ProjectStart | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => checking
  );
}

/** The action waiting on the dialog, taken once (the dialog runs it). */
export function takePendingProjectAction(): (() => void) | null {
  const action = pending;
  pending = null;
  return action;
}

/** Dropped when the dialog is cancelled. */
export function clearPendingProjectAction() {
  pending = null;
}

/** Whether there's something waiting to carry on once the dialog is done. */
export function hasPendingProjectAction(): boolean {
  return pending !== null;
}

/** Forget a passing check: the next project start checks again. */
export function forgetProjectToolsCheck() {
  knownReady = false;
}

/** Test seam: back to a fresh session. */
export function resetProjectToolsForTests() {
  pending = null;
  knownReady = false;
  checking = null;
}

const WITHOUT_GITHUB_KEY = `${BRAND.slug}.projectTools.withoutGitHub`;
/** The same choice saved under the app's previous name, before a rename. */
const PREVIOUS_WITHOUT_GITHUB_KEY = BRAND.previous?.slug
  ? `${BRAND.previous.slug}.projectTools.withoutGitHub`
  : null;

/** The user chose "Continue without" GitHub: don't offer it on every project. */
export function declineGitHub() {
  try {
    localStorage.setItem(WITHOUT_GITHUB_KEY, '1');
  } catch {
    /* per-viewer convenience only */
  }
}

function gitHubDeclined(): boolean {
  try {
    if (localStorage.getItem(WITHOUT_GITHUB_KEY) === '1') return true;
    return (
      PREVIOUS_WITHOUT_GITHUB_KEY !== null &&
      localStorage.getItem(PREVIOUS_WITHOUT_GITHUB_KEY) === '1'
    );
  } catch {
    return false;
  }
}

/**
 * Whether a project can start straight away: nothing required is missing,
 * and GitHub is either there or was already declined.
 */
export function canStartProject(items: SetupItem[], declinedGitHub = gitHubDeclined()): boolean {
  if (getMissingRequiredTools(items).length > 0) return false;
  return declinedGitHub || getMissingOptionalTools(items).length === 0;
}

/** The three ways a project starts (new, import, local folder), each gated. */
export function useGatedProjectStarts(starts: {
  createProject: (tab?: CreateProjectTab) => void;
  importProject: () => void;
  importLocalFolder: () => Promise<void>;
}) {
  const gate = useProjectToolsGate();
  const { createProject, importProject, importLocalFolder } = starts;
  return {
    // Never handed an argument: it is wired straight to onClick, and a click
    // event is not a tab.
    handleCreateProject: useCallback(
      () => gate(() => createProject(), 'create'),
      [gate, createProject]
    ),
    /** New Project, opened on From a URL. */
    handleCreateProjectFromUrl: useCallback(
      () => gate(() => createProject('url'), 'create'),
      [gate, createProject]
    ),
    handleImportProject: useCallback(() => gate(importProject, 'import'), [gate, importProject]),
    handleImportLocalFolder: useCallback(
      () => Promise.resolve(gate(() => void importLocalFolder(), 'local')),
      [gate, importLocalFolder]
    ),
  };
}

/**
 * Wrap an action that starts a project: it runs straight away when the
 * project tools are there, and after "Set up project tools" otherwise.
 * When the check itself fails the action runs anyway: a check we couldn't
 * make is no reason to block, and the action reports its own errors.
 */
export function useProjectToolsGate() {
  const openModal = useOpenModal();
  return useCallback(
    (action: () => void, start: ProjectStart = 'create') => {
      if (knownReady) {
        action();
        return;
      }
      if (checking) return; // a second click while the first is checking
      setChecking(start);
      void (async () => {
        try {
          const status = await getFullSetupStatus();
          if (canStartProject(status.items)) {
            knownReady = true;
            action();
            return;
          }
        } catch (err) {
          logger.warn('Project tools check failed; carrying on', { error: String(err) });
          action();
          return;
        } finally {
          setChecking(null);
        }
        pending = action;
        openModal('projectTools');
      })();
    },
    [openModal]
  );
}

/** The backend's event when an agent's create_project found tools missing. */
export const PROJECT_TOOLS_NEEDED_EVENT = 'project-tools-needed';

/**
 * An agent (the Chief, or an assistant over Remote Access) tried to make a
 * project and this Mac is missing what it needs: open "Set up project
 * tools" here so the person can fix it in one click. Mounted once per window;
 * the backend sends it to the main window only.
 */
export function useProjectToolsNeededListener() {
  const openModal = useOpenModal();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    void listen(PROJECT_TOOLS_NEEDED_EVENT, () => {
      forgetProjectToolsCheck();
      openModal('projectTools');
    })
      .then((fn) => {
        if (gone) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) =>
        logger.warn('Could not listen for project tools requests', { error: String(err) })
      );
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [openModal]);
}
