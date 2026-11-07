/**
 * Agent controls, from the composer's chip: model and engine, effort, how
 * much it does on its own, usage, and a way to the agent sheet
 * (components/AgentControls.tsx).
 */

import { useLocalSearchParams } from 'expo-router';
import { AgentControls } from '../components/AgentControls';
import { SheetPage } from '../components/ui';
import { withAgentAccent } from '../lib/accentScreen';

export default withAgentAccent(function Controls() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SheetPage>
      <AgentControls agentId={id} />
    </SheetPage>
  );
});

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
