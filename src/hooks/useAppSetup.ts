/**
 * Hook for application setup, onboarding, and initialization effects.
 *
 * Manages: setup/onboarding checks, HMR recovery, auto-open project,
 * keyboard shortcuts (help modal), and background setup verification.
 *
 * @module hooks/useAppSetup
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { Project } from '../lib/project';
import type { ProjectGitHubStatus } from '../lib/github';
import { getProjectGitHubStatus } from '../lib/github';
import { GITHUB_STATUS_FALLBACK } from './useIntegrationStatus';
import {
  getFullSetupStatus,
  quickSetupCheck,
  markSetupComplete,
  getDefaultAgentId as fetchDefaultAgentId,
} from '../lib/setup';
import { initDefaultAgent } from '../lib/agent';
import { putChiefOnEngine } from '../lib/agentOnboarding';
import { getWindowLabel } from '../lib/window';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';
import { basename } from '../lib/paths';
import { withTimeout } from '../lib/withTimeout';
import type { AppView } from '../lib/types';
import type { WorkspaceTab } from '../components/workspace/workspaceViewState';

/**
 * Boot gates must never hang: each startup await below is capped so a stuck
 * Tauri invoke (e.g. a CLI probe wedged on a broken PATH or network mount)
 * becomes a rejection that routes to onboarding instead of an eternal
 * spinner (#173). Timeouts are generous — these normally settle in <1s.
 *
 * Must comfortably exceed the backend's own worst case (~10s of internally
 * bounded probes in get_full_setup_status, plus Windows' cmd.exe hop per
 * subprocess) — a frontend gate tighter than the backend's own budget dumps
 * fully-set-up users into onboarding (issue #272).
 */
const BOOT_GATE_TIMEOUT_MS = 20_000;
/** CLI status refresh spawns gh/agent subprocesses — give it a bit longer. */
const CLI_REFRESH_TIMEOUT_MS = 20_000;

const BOOT_PROGRESS = {
  initial: 0,
  defaultAgent: 20,
  setupProbe: 50,
  fullSetup: 70,
  cliStatuses: 90,
  complete: 100,
} as const;

/**
 * Where the app lands once setup is known to be done: Agents, except in a
 * window opened for a project, which goes to the workspace by way of
 * 'projects' (the auto-open effect watches for that view).
 */
export function postSetupViewFor(initialProjectPath?: string | null): AppView {
  return initialProjectPath ? 'projects' : 'agents';
}

export interface UseAppSetupParams {
  view: AppView;
  setView: (view: AppView | ((prev: AppView) => AppView)) => void;
  initialProjectPath?: string | null;
  setCurrentProject: (project: Project | null) => void;
  setDevServerPort: (port: number, projectPath?: string) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setIsPreviewHidden: (hidden: boolean) => void;
  handleSelectProject: (project: Project) => Promise<void>;
  refreshAllCliStatuses: () => Promise<void>;
  setProjectGitHubStatus: (status: ProjectGitHubStatus | null) => void;
  fetchBranchInfo: (projectPath: string) => Promise<void>;
  openHelpModal: () => void;
}

export function useAppSetup({
  view,
  setView,
  initialProjectPath,
  setCurrentProject,
  setDevServerPort,
  setWorkspaceTab,
  setIsPreviewHidden,
  handleSelectProject,
  refreshAllCliStatuses,
  setProjectGitHubStatus,
  fetchBranchInfo,
  openHelpModal,
}: UseAppSetupParams) {
  // Track if auto-open has been attempted this session (protects against StrictMode double-invoke)
  const autoOpenAttemptedRef = useRef(false);

  const [projectsLoading, setProjectsLoading] = useState(true);
  const [bootProgress, setBootProgress] = useState<number>(BOOT_PROGRESS.initial);

  // Background verification for optimistic loading. It refreshes what the
  // app knows and logs what lapsed, but never takes the user out of what
  // they're doing: an expired sign-in or a missing tool is asked for where it
  // matters (Agents offers sign-in on the chat, project tools are asked for
  // when a project needs them), not by bouncing back into onboarding.
  const verifySetupInBackground = async () => {
    try {
      await refreshAllCliStatuses();
      const setupStatus = await getFullSetupStatus();
      if (!setupStatus.allReady) {
        logger.warn('Background verification: no agent engine ready', {
          missingItems: setupStatus.items
            .filter((i) => i.status !== 'ready')
            .map((i) => i.friendlyName),
        });
      }
    } catch (error) {
      logger.error('Background setup verification failed', { error });
    }
  };

  const checkSetup = useCallback(async (forceFullCheck = false) => {
    setView('loading');
    setBootProgress(BOOT_PROGRESS.initial);
    try {
      // Hydrate default agent cache from backend
      const defaultAgent = await withTimeout(
        fetchDefaultAgentId(),
        BOOT_GATE_TIMEOUT_MS,
        'Default agent lookup'
      );
      initDefaultAgent(defaultAgent);
      setBootProgress(BOOT_PROGRESS.defaultAgent);

      // Launch lands on Agents: you open the app and you're talking to your
      // Chief of Staff. A project window (opened with a project path) is the
      // exception: it goes through 'projects' because that is where the
      // auto-open effect below picks the project up and opens its workspace.
      const postSetupView = postSetupViewFor(initialProjectPath);

      // Fast path: if setup was previously completed, try quick check first
      if (!forceFullCheck) {
        const quickCheck = await withTimeout(
          quickSetupCheck(),
          BOOT_GATE_TIMEOUT_MS,
          'Quick setup check'
        );
        setBootProgress(BOOT_PROGRESS.setupProbe);
        if (quickCheck.setupCompleteCached && quickCheck.allPresent) {
          // Setup was completed before and all binaries still exist
          // Show projects/account picker immediately, verify auth in background
          // Use functional update to avoid overwriting HMR recovery's 'workspace' view
          setView((currentView) =>
            currentView === 'loading' || currentView === 'onboarding' ? postSetupView : currentView
          );
          setBootProgress(BOOT_PROGRESS.complete);
          void verifySetupInBackground();
          return;
        }
      }

      // Slow path: full setup check (first launch or something missing).
      // getFullSetupStatus() and refreshAllCliStatuses() each shell out to a
      // handful of CLIs independently and neither's result feeds the other,
      // but they used to be awaited back-to-back — on a real machine that
      // was ~1.7s then ~3s+ in series, all of it spent on the blocking
      // 'loading' view. Run them concurrently instead: total wait becomes
      // the slower of the two rather than the sum (measured ~1.7s+3.1s=4.8s
      // sequential vs ~3.1s concurrent for a representative run).
      //
      // Each still reports its own boot-progress step as it lands, so the
      // loading bar keeps advancing in two stages rather than jumping once
      // at the end; concurrency means they can arrive in either order.
      const [setupStatus] = await Promise.all([
        withTimeout(getFullSetupStatus(), BOOT_GATE_TIMEOUT_MS, 'Full setup status').then(
          (result) => {
            setBootProgress(BOOT_PROGRESS.fullSetup);
            return result;
          }
        ),
        withTimeout(refreshAllCliStatuses(), CLI_REFRESH_TIMEOUT_MS, 'CLI status refresh').then(
          (result) => {
            setBootProgress(BOOT_PROGRESS.cliStatuses);
            return result;
          }
        ),
      ]);

      // Use full setup status to determine if onboarding is needed
      if (setupStatus.allReady) {
        // Persist setup complete for existing users upgrading to this version
        // (they already completed onboarding but don't have the cached state yet)
        void markSetupComplete();
        setBootProgress(BOOT_PROGRESS.complete);
        // Use functional update to avoid overwriting HMR recovery's 'workspace' view
        setView((currentView) =>
          currentView === 'loading' || currentView === 'onboarding' ? postSetupView : currentView
        );
      } else {
        setBootProgress(BOOT_PROGRESS.complete);
        setView('onboarding');
      }
    } catch (error) {
      logger.error('Failed to check prerequisites', { error });
      setBootProgress(BOOT_PROGRESS.complete);
      setView('onboarding');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; refreshAllCliStatuses and verifySetupInBackground are stable
  }, []);

  // Check prerequisites and GitHub status on mount
  useEffect(() => {
    void checkSetup();
  }, [checkSetup]);

  // HMR Recovery for ALL windows (main window and project windows)
  // Checks backend port reservation to detect HMR and restore UI state without restarting dev server
  // This runs BEFORE the auto-open effect and handles the "already have a project open" case
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const storedProjectPath = sessionStorage.getItem(storageKey);
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    // Skip if already in workspace view (state already correct)
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Skip if ref says we've already handled this (prevents double-invoke in StrictMode)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Skip if user explicitly went back to projects
    if (dismissedValue === 'true') {
      return;
    }

    // Check backend for existing port reservation (most reliable HMR indicator).
    // Requires a project path to key on — if we don't have one yet, we can't
    // look up a reservation, so skip the HMR recovery path.
    if (!storedProjectPath) {
      return;
    }
    void (async () => {
      try {
        const existingPort = await invoke<number | null>('get_reserved_port_for_window', {
          windowLabel,
          projectPath: storedProjectPath,
        });

        // If we have a reserved port, this is likely an HMR reload
        if (existingPort !== null && storedProjectPath) {
          // Mark as handled to prevent the auto-open effect from also firing
          autoOpenAttemptedRef.current = true;

          logger.info('[HMR Recovery] Port reserved, restoring UI state', {
            windowLabel,
            port: existingPort,
            projectPath: storedProjectPath,
          });

          // Restore UI state without restarting dev server
          setWorkspaceTab('preview');
          setIsPreviewHidden(false);
          const projectName = basename(storedProjectPath) || 'Project';
          setCurrentProject({
            name: projectName,
            path: storedProjectPath,
            thumbnail: null,
          });
          setDevServerPort(existingPort, storedProjectPath);
          setView('workspace');

          // Refresh branch info and statuses in background
          // Dispatch each independently so fast results aren't blocked by slow ones
          void fetchBranchInfo(storedProjectPath);
          void getProjectGitHubStatus(storedProjectPath)
            .catch(() => GITHUB_STATUS_FALLBACK)
            .then((status) => setProjectGitHubStatus(status));
        }
      } catch {
        // If backend check fails, let normal flow continue
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchBranchInfo is stable, don't re-run on change
  }, [view]);

  // Auto-open project if initialProjectPath is provided (multi-window support)
  // This handles the case where a NEW project window is opened (not HMR recovery)
  useEffect(() => {
    const windowLabel = getWindowLabel();
    const storageKey = `ship-studio-project-loaded-${windowLabel}`;
    const dismissedKey = `ship-studio-auto-open-dismissed-${windowLabel}`;
    const dismissedValue = sessionStorage.getItem(dismissedKey);

    if (!initialProjectPath) {
      return;
    }

    // Skip if HMR recovery already handled this (ref is set by the HMR recovery effect)
    if (autoOpenAttemptedRef.current) {
      return;
    }

    // Check if user explicitly went back to projects - don't auto-open again
    if (dismissedValue === 'true') {
      return;
    }

    // Skip if already in workspace view
    if (view === 'workspace' || view === 'project-loading') {
      return;
    }

    // Only auto-open when we reach projects or loading view
    if (view === 'projects' || view === 'loading') {
      // Mark as attempted BEFORE any async work to prevent races
      autoOpenAttemptedRef.current = true;

      // Store the project path for HMR recovery (before any async work)
      sessionStorage.setItem(storageKey, initialProjectPath);

      const projectName = basename(initialProjectPath) || 'Project';
      const project: Project = {
        name: projectName,
        path: initialProjectPath,
        thumbnail: null,
      };
      logger.info('[MultiWindow] Auto-opening project from URL param', {
        path: initialProjectPath,
      });
      void handleSelectProject(project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleSelectProject is stable, don't re-run on change
  }, [initialProjectPath, view]);

  // Keyboard shortcut for help modal (Cmd+/ or F1)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+/ (Mac) or Ctrl+/ (Windows) or F1
      if (((e.metaKey || e.ctrlKey) && e.key === '/') || e.key === 'F1') {
        e.preventDefault();
        openHelpModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openHelpModal]);

  // Onboarding hands off to the Chief of Staff, on the engine just set up.
  const handleOnboardingComplete = useCallback(async () => {
    const defaultAgent = await fetchDefaultAgentId();
    initDefaultAgent(defaultAgent);
    await markSetupComplete();
    await putChiefOnEngine(defaultAgent);
    await refreshAllCliStatuses();
    setView(postSetupViewFor(initialProjectPath));
  }, [refreshAllCliStatuses, initialProjectPath, setView]);

  return {
    projectsLoading,
    setProjectsLoading,
    bootProgress,
    handleOnboardingComplete,
  };
}
