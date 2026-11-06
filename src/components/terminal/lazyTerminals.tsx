/**
 * The xterm-backed terminals, loaded the first time one is drawn.
 *
 * xterm and its WebGL renderer are ~450 kB of the app's JavaScript, and the
 * window opens on Agents, which only needs a terminal when the user takes over
 * an agent or signs an engine in. Importing a terminal here instead of from its
 * file keeps xterm out of the chunk the first paint waits on.
 */
import { Suspense, lazy, type ComponentProps } from 'react';
import type { OnboardingTerminal as OnboardingTerminalImpl } from '../setup/OnboardingTerminal';
import type { AttachedTerminal as AttachedTerminalImpl } from './AttachedTerminal';
import type { ClaudeConnectTerminal as ClaudeConnectTerminalImpl } from '../dashboard/ClaudeConnectTerminal';
import type { WorkspaceConnectTerminal as WorkspaceConnectTerminalImpl } from '../dashboard/WorkspaceConnectTerminal';

const Onboarding = lazy(() =>
  import('../setup/OnboardingTerminal').then((m) => ({ default: m.OnboardingTerminal }))
);
const Attached = lazy(() =>
  import('./AttachedTerminal').then((m) => ({ default: m.AttachedTerminal }))
);
const ClaudeConnect = lazy(() =>
  import('../dashboard/ClaudeConnectTerminal').then((m) => ({ default: m.ClaudeConnectTerminal }))
);
const WorkspaceConnect = lazy(() =>
  import('../dashboard/WorkspaceConnectTerminal').then((m) => ({
    default: m.WorkspaceConnectTerminal,
  }))
);

export function OnboardingTerminal(props: ComponentProps<typeof OnboardingTerminalImpl>) {
  return (
    <Suspense fallback={null}>
      <Onboarding {...props} />
    </Suspense>
  );
}
export function AttachedTerminal(props: ComponentProps<typeof AttachedTerminalImpl>) {
  return (
    <Suspense fallback={null}>
      <Attached {...props} />
    </Suspense>
  );
}
export function ClaudeConnectTerminal(props: ComponentProps<typeof ClaudeConnectTerminalImpl>) {
  return (
    <Suspense fallback={null}>
      <ClaudeConnect {...props} />
    </Suspense>
  );
}
export function WorkspaceConnectTerminal(
  props: ComponentProps<typeof WorkspaceConnectTerminalImpl>
) {
  return (
    <Suspense fallback={null}>
      <WorkspaceConnect {...props} />
    </Suspense>
  );
}
