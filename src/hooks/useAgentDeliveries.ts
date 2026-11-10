/**
 * Everything that hands work to the workspace's agent tabs from outside the
 * workspace: a queued prompt (a site migration's brief) started in a new agent
 * tab, and remote access starting or closing an agent from a phone.
 *
 * Both need the same three things App owns — which view is showing, the
 * current project, and the terminal bundle — so they're wired once here
 * rather than one by one in App.
 *
 * @module hooks/useAgentDeliveries
 */

import type { Project } from '../lib/project';
import type { ToastAction, ToastOptions, ToastType } from './useToasts';
import { usePromptHandoff } from './usePromptHandoff';
import { useRemoteAgentControl } from './useRemoteAgentControl';

type Terminals = Parameters<typeof usePromptHandoff>[1] &
  Parameters<typeof useRemoteAgentControl>[2];

export function useAgentDeliveries(
  inWorkspace: boolean,
  currentProject: Project | null,
  terminals: Terminals,
  showToast: (
    message: string,
    type?: ToastType,
    action?: ToastAction,
    options?: ToastOptions
  ) => void,
  openProject: (project: Project) => void | Promise<void>
): void {
  const currentPath = currentProject?.path ?? null;
  // A queued prompt — see hooks/usePromptHandoff. Null while off-workspace:
  // leaving keeps the hot project current, so the flip back to 'workspace' is
  // what re-arms delivery of a second prompt.
  usePromptHandoff(inWorkspace ? currentPath : null, terminals, showToast);
  // Remote access's start_agent / close_agent — see hooks/useRemoteAgentControl.
  useRemoteAgentControl(currentPath, inWorkspace, terminals, openProject);
}
