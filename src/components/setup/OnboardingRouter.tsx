/**
 * The onboarding window: the agent-led flow under a drag region, since the
 * window has no title bar while it shows.
 *
 * There used to be a second, classic step-by-step wizard one click away. It
 * gated the app on developer tools (a package manager, Node, Git, a GitHub
 * sign-in) that onboarding no longer asks for, so it could no longer finish
 * the way the agent-led flow does and was removed rather than left to
 * contradict it.
 */

import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AgentOnboardingScreen } from './agent-led/AgentOnboardingScreen';

interface OnboardingRouterProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function OnboardingRouter({ onComplete }: OnboardingRouterProps) {
  const handleDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, [role="button"]')) return;
    const win = getCurrentWindow();
    void win.isMaximized().then((maximized) => {
      void (maximized ? win.unmaximize() : win.maximize());
    });
  }, []);

  return (
    <div className="onboarding-router">
      <div
        className="onboarding-drag-region"
        onMouseDown={handleDrag}
        onDoubleClick={handleDoubleClick}
      />
      <AgentOnboardingScreen onComplete={onComplete} />
    </div>
  );
}
