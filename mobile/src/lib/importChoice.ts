/**
 * Import from the phone, as plain decisions: whether the home asks "bring
 * your agents, or start fresh?" (once, while the Mac says it's undecided),
 * and which one of the import screen's three steps shows.
 */

import type { AgentsOverview, PhoneImportStatus } from '@shipstudio/companion-protocol';

/** Whether the home asks: undecided, and this Mac can both import and take the answer. */
export function asksImportChoice(
  overview: Pick<AgentsOverview, 'importChoice'> | null | undefined,
  welcome: { methods: readonly string[] } | null | undefined
): boolean {
  const methods = welcome?.methods ?? [];
  return (
    overview?.importChoice === 'undecided' &&
    methods.includes('agents.setImportChoice') &&
    methods.includes('agents.import.status')
  );
}

/**
 * Which one of the three screens shows, from what the Mac says: connect
 * (Remote access on and the assistant connected, done once at the Mac),
 * start (Start, then the message), or follow (the import, in the Chief's
 * chat). One at a time, never all three.
 */
export function phoneImportStep(status: PhoneImportStatus | null): {
  id: 'connect' | 'start' | 'follow';
  index: 1 | 2 | 3;
  reachable: boolean;
} {
  const remote = status?.remoteAccess;
  const reachable = !!remote?.enabled && !!remote.funnelOn;
  if (status?.talk) return { id: 'follow', index: 3, reachable };
  if (!status || !reachable || !remote?.everConnected) {
    return { id: 'connect', index: 1, reachable };
  }
  return { id: 'start', index: 2, reachable };
}
