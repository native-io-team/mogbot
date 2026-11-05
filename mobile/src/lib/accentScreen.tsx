/**
 * A screen about one agent (its chat's sheets), in that agent's colour. The
 * agent is the route param `param`, so the screen needs no wiring of its own.
 * Apart from accent.tsx so the primitives that read the accent don't pull in
 * the router.
 */

import { useLocalSearchParams } from 'expo-router';
import type { ComponentType } from 'react';
import { AgentAccent } from './accent';

export function withAgentAccent<P extends object>(Screen: ComponentType<P>, param = 'id') {
  function Scoped(props: P) {
    const params = useLocalSearchParams<Record<string, string>>();
    return (
      <AgentAccent agentId={params[param]}>
        <Screen {...props} />
      </AgentAccent>
    );
  }
  Scoped.displayName = `withAgentAccent(${Screen.displayName ?? Screen.name})`;
  return Scoped;
}
