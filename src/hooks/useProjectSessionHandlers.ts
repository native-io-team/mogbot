/**
 * Session-lifecycle handlers the sidebar and palette share with App: renaming
 * a project (which moves its folder under a hot session) and switching to a
 * project on a specific terminal tab. Closing one lives in useCloseProject,
 * whose ordering rules are its own.
 *
 * @module hooks/useProjectSessionHandlers
 */

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { renameProject, setTerminalState, type Project } from '../lib/project';
import { sessionRegistry } from '../lib/sessionRegistry';
import { trackEvent } from '../lib/analytics';
import { asCommandError, formatCommandError, isExpectedRenameRefusal } from '../lib/errors';
import { logger } from '../lib/logger';

export interface UseProjectSessionHandlersParams {
  currentProjectPath: string | null;
  currentProjectPathRef: MutableRefObject<string | null>;
  setCurrentProject: Dispatch<SetStateAction<Project | null>>;
  stopServer: (projectPath?: string) => Promise<void>;
  closeAllTerminalsForProject: (projectPath: string) => void;
  refreshPinnedProjects: () => Promise<unknown>;
  /** Opens a project the way a sidebar row click does. */
  handleRailClick: (projectPath: string) => void;
  showToast: (message: string, kind: 'success') => void;
}

export function useProjectSessionHandlers({
  currentProjectPath,
  currentProjectPathRef,
  setCurrentProject,
  stopServer,
  closeAllTerminalsForProject,
  refreshPinnedProjects,
  handleRailClick,
  showToast,
}: UseProjectSessionHandlersParams) {
  const handleRenameProject = useCallback(
    async (projectPath: string, newName: string) => {
      try {
        const renamedPath = await renameProject(projectPath, newName);

        // The backend suspends a hot session before moving its folder. Release
        // the matching client-side server, terminal, and registry state too.
        if (renamedPath !== projectPath) {
          await stopServer(projectPath);
          closeAllTerminalsForProject(projectPath);
          sessionRegistry.renamePath(projectPath, renamedPath);
          sessionRegistry.suspend(renamedPath);
        }

        if (currentProjectPath === projectPath) {
          setCurrentProject((project) =>
            project && project.path === projectPath
              ? { ...project, name: newName, path: renamedPath }
              : project
          );
          currentProjectPathRef.current = renamedPath;
        }

        await refreshPinnedProjects();
        showToast(`Renamed project to ${newName}`, 'success');
        void trackEvent('project_renamed', { $screen_name: 'Workspace' });
      } catch (error) {
        const message = formatCommandError(asCommandError(error));
        logger[isExpectedRenameRefusal(error) ? 'warn' : 'error']('[RenameProject] failed', {
          projectPath,
          error: message,
        });
        throw error;
      }
    },
    [
      closeAllTerminalsForProject,
      currentProjectPath,
      currentProjectPathRef,
      refreshPinnedProjects,
      setCurrentProject,
      showToast,
      stopServer,
    ]
  );

  // Switch to another project AND focus a specific tab within it. Writes the
  // desired active tab index to backend first so the restore flow on open
  // comes up on the right tab.
  const handleSelectProjectTab = useCallback(
    (projectPath: string, tabSessionId: string) => {
      void (async () => {
        const snap = sessionRegistry.snapshot(projectPath);
        const idx = snap?.terminalTabs.findIndex((t) => t.sessionId === tabSessionId) ?? -1;
        if (snap && idx >= 0) {
          try {
            await setTerminalState(projectPath, {
              tabs: snap.terminalTabs.map((t) => ({
                agent_id: t.agentId,
                session_id: t.sessionId,
                custom_title: t.customTitle,
              })),
              active_tab_index: idx,
            });
          } catch (err) {
            logger.warn('[SelectProjectTab] Failed to persist active tab', {
              error: formatCommandError(asCommandError(err)),
            });
          }
        }
        handleRailClick(projectPath);
      })();
    },
    [handleRailClick]
  );

  return { handleRenameProject, handleSelectProjectTab };
}
