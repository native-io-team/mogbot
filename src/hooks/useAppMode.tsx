/**
 * Projects | Agents: the app's two modes, and where each one picks up.
 *
 * Switching to Projects returns to the last place you were on that side: the
 * dashboard or the project you had open (re-entered
 * the way a sidebar click does, so its hot session is reattached rather than
 * remounted under it). Switching to Agents returns to the last conversation,
 * or Team, which AgentsView remembers itself.
 *
 * ⌘⇧A flips between them from anywhere a mode is showing; it is also
 * `agents.toggleMode` in the palette, beside the rest of the Agents
 * navigation commands registered here.
 *
 * The switch is immediate and has one answer: the window shows the side that
 * was asked for in the same tick, and nothing that finishes later (a project
 * still opening, its server starting) moves it back. Leaving for any screen
 * that isn't a project tells an open still in flight to stand down
 * (`cancelPendingOpen`), and `navigate` is that same way out for the palette's
 * other navigation commands.
 *
 * Returns the sidebar's `onGoProjects` / `onGoAgents` and `navigate`, stable
 * between renders.
 *
 * @module hooks/useAppMode
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AgentsIcon, FolderOpenIcon } from '@/components/icons';
import { useCommands } from '../commands/useCommands';
import { useAgentsNavCommands } from '../commands/useAgentsCommands';
import { MODE_TOGGLE_SHORTCUT } from '../components/workspace/ModeToggle';
import type { AppView } from '../lib/types';

const PROJECTS_SIDE: readonly AppView[] = ['projects', 'workspace', 'project-loading'];

interface Place {
  view: AppView;
  projectPath: string | null;
}

interface UseAppModeParams {
  view: AppView;
  setView: (view: AppView) => void;
  currentProjectPath: string | null;
  /** Re-enter a project, as clicking its sidebar row does. */
  openProject: (projectPath: string) => void;
  /**
   * Tell a project open still in flight that the user went elsewhere, so it
   * doesn't pull them back to its workspace when it finishes.
   */
  cancelPendingOpen?: () => void;
}

const noop = () => {};

export function useAppMode({
  view,
  setView,
  currentProjectPath,
  openProject,
  cancelPendingOpen = noop,
}: UseAppModeParams) {
  // The latest of everything the callbacks reach for, so the callbacks
  // themselves never change: `openProject` is rebuilt on every App render,
  // and depending on it rebuilt the sidebar's props with it.
  const deps = useRef({ setView, openProject, cancelPendingOpen, currentProjectPath });
  useEffect(() => {
    deps.current = { setView, openProject, cancelPendingOpen, currentProjectPath };
  });

  const navigate = useCallback((next: AppView) => {
    if (next !== 'workspace' && next !== 'project-loading') deps.current.cancelPendingOpen();
    deps.current.setView(next);
  }, []);
  useAgentsNavCommands({ setView: navigate });

  const lastProjectsPlace = useRef<Place>({ view: 'projects', projectPath: null });
  useEffect(() => {
    if (!PROJECTS_SIDE.includes(view)) return;
    lastProjectsPlace.current =
      view === 'workspace' || view === 'project-loading'
        ? { view: 'workspace', projectPath: currentProjectPath }
        : { view, projectPath: null };
  }, [view, currentProjectPath]);

  // Which side was last asked for, set the moment a switch is asked for
  // rather than on the next render: two presses of ⌘⇧A (or a press and a
  // click) inside one frame flip there and back, rather than both going one way.
  const inAgents = view === 'agents';
  const side = useRef({ view, agents: inAgents });
  useEffect(() => {
    if (side.current.view !== view) side.current = { view, agents: view === 'agents' };
  }, [view]);

  const goProjects = useCallback(() => {
    side.current = { ...side.current, agents: false };
    const { view: last, projectPath } = lastProjectsPlace.current;
    if (last !== 'workspace' || !projectPath) {
      navigate(last === 'workspace' ? 'projects' : last);
      return;
    }
    // The project is still loaded in this window, so its workspace shows at
    // once and the re-entry (its session, its server) carries on under it.
    // Waiting for the re-entry first left the switch looking dead for a
    // moment, and the second click that invited cancelled the open outright.
    if (deps.current.currentProjectPath === projectPath) deps.current.setView('workspace');
    deps.current.openProject(projectPath);
  }, [navigate]);

  const goAgents = useCallback(() => {
    side.current = { ...side.current, agents: true };
    navigate('agents');
  }, [navigate]);

  const inMode = inAgents || PROJECTS_SIDE.includes(view);
  const toggle = useCallback(
    () => (side.current.agents ? goProjects() : goAgents()),
    [goProjects, goAgents]
  );

  const latest = useRef({ inMode, toggle });
  useEffect(() => {
    latest.current = { inMode, toggle };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.code !== 'KeyA' || event.repeat) return;
      if (!latest.current.inMode) return;
      // A dialog owns the keyboard; switching the window under it would strand it.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      latest.current.toggle();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useCommands(
    () => [
      {
        id: 'agents.toggleMode',
        title: inAgents ? 'Switch to Projects' : 'Switch to Agents',
        icon: inAgents ? <FolderOpenIcon size={14} /> : <AgentsIcon size={14} />,
        category: 'navigation',
        keywords: ['mode', 'toggle', 'projects', 'agents', 'switch'],
        shortcut: MODE_TOGGLE_SHORTCUT,
        when: () => inMode,
        run: toggle,
      },
    ],
    [inAgents, inMode, toggle]
  );

  return useMemo(
    () => ({ onGoProjects: goProjects, onGoAgents: goAgents, navigate }),
    [goProjects, goAgents, navigate]
  );
}
