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

import { AgentOnboardingScreen } from './agent-led/AgentOnboardingScreen';

interface OnboardingRouterProps {
  /** Called when setup is complete and the user continues. */
  onComplete: () => void;
}

export function OnboardingRouter({ onComplete }: OnboardingRouterProps) {


  return (
    <div className="onboarding-router">
      <div
        className="onboarding-drag-region" data-window-drag
      />
      <AgentOnboardingScreen onComplete={onComplete} />
    </div>
  );
}
