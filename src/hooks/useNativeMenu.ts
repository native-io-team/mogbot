/**
 * This window's side of the menu bar and its title (`lib/nativeMenu.ts`).
 *
 * - The title says what the window shows: "Agents", "Projects", or the
 *   project's name. It is what the Window menu, the Dock's window list and
 *   Mission Control show.
 * - The menu bar learns where this window is and what ⌘1…⌘9 open: the
 *   agents in sidebar order in Agents, the projects in the sidebar's order
 *   elsewhere (`projectShortcutOrder`).
 * - ⌘1…⌘9 in Agents open those agents; in projects the project hook
 *   (`useProjectNumberShortcuts`) handles them.
 *
 * @module hooks/useNativeMenu
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { sortAgents } from '../lib/agents';
import { useAgentsSelector, type AgentsState } from '../lib/agentsStore';
import { basename } from '../lib/paths';
import { sessionRegistry } from '../lib/sessionRegistry';
import { setWindowTitle } from '../lib/window';
import { BRAND } from '../lib/brand';
import { logger } from '../lib/logger';
import { menuNumber, onMenuAction, reportMenuContext, resendMenuContext } from '../lib/nativeMenu';
import { requestAgentsIntent } from '../commands/useAgentsCommands';
import type { AppView } from '../lib/types';
import { projectShortcutOrder } from './useProjectNumberShortcuts';

interface Params {
  view: AppView;
  currentProjectName: string | null;
  pinnedPaths: readonly string[];
}

type Place = { id: string; name: string };

/** The agents ⌘1…⌘9 open: the sidebar's order, hidden ones left out. */
const selectOrder = (s: AgentsState): Place[] =>
  sortAgents(s.agents)
    .filter((a) => !a.hidden)
    .slice(0, 9)
    .map((a) => ({ id: a.id, name: a.name }));
const sameOrder = (a: Place[], b: Place[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name);

/** What a window showing `view` is called. */
export function windowTitleFor(view: AppView, projectName: string | null): string {
  if (view === 'agents') return 'Agents';
  if (view === 'projects') return 'Projects';
  if ((view === 'workspace' || view === 'project-loading') && projectName) return projectName;
  return BRAND.name;
}

/** The menu's word for where this window is. */
function menuView(view: AppView): string {
  if (view === 'agents' || view === 'projects' || view === 'workspace') return view;
  return 'other';
}

export function useNativeMenu({ view, currentProjectName, pinnedPaths }: Params): void {
  // Only the order and names: App must not re-render on every status line.
  const agentOrder = useAgentsSelector(selectOrder, sameOrder);
  // Which projects have sessions, as one string: it changes only when the
  // set does, not on every terminal title.
  const sessions = useSyncExternalStore(
    sessionRegistry.subscribeSimple,
    () =>
      sessionRegistry
        .snapshotAll()
        .map((s) => s.projectPath)
        .sort()
        .join('\n'),
    () => ''
  );
  const projectNames = useMemo(() => {
    void sessions;
    return projectShortcutOrder(pinnedPaths).map((p) => basename(p) || p);
  }, [pinnedPaths, sessions]);

  const title = windowTitleFor(view, currentProjectName);
  useEffect(() => {
    void setWindowTitle(title).catch((error: unknown) =>
      logger.warn('[useNativeMenu] set title failed', { error: String(error) })
    );
  }, [title]);

  const inAgents = view === 'agents';
  const goTo = useMemo(
    () => (inAgents ? agentOrder.map((a) => a.name) : projectNames).slice(0, 9),
    [inAgents, agentOrder, projectNames]
  );
  useEffect(() => {
    reportMenuContext({ view: menuView(view), goTo });
  }, [view, goTo]);

  // The menu bar is shared by every window: when this one comes forward it
  // is about this one again.
  useEffect(() => {
    const onFocus = () => resendMenuContext();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // ⌘1…⌘9 in Agents: that agent's chat.
  useEffect(() => {
    if (!inAgents) return;
    return onMenuAction((action) => {
      const n = menuNumber(action, 'go_to');
      const agent = n === null ? undefined : agentOrder[n - 1];
      if (agent) requestAgentsIntent({ kind: 'open', agentId: agent.id });
    });
  }, [inAgents, agentOrder]);
}

/**
 * `useNativeMenu` as a component that draws nothing. App renders this
 * rather than calling the hook: the agents' order changes whenever one of
 * them says something, and a hook in App would re-render the whole window
 * (every open chat's cards with it) each time.
 */
export function NativeMenuHost(props: Params): null {
  useNativeMenu(props);
  return null;
}
