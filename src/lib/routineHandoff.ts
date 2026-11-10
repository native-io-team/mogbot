/**
 * "Change" on a row of the Routines page: open that agent's chat with its
 * schedule popover already on the routine's editor.
 *
 * The page and the chat never share a tree (opening the agent replaces the
 * page), so the ask waits here, one slot, until that agent's chat mounts and
 * takes it. It lives for a few seconds only: an ask that never got its chat
 * mustn't open an editor the next time someone visits that agent.
 *
 * @module lib/routineHandoff
 */

interface RoutineAsk {
  agentId: string;
  routineId: string;
  at: number;
}

const TTL_MS = 10_000;

let pending: RoutineAsk | null = null;

/** Ask `agentId`'s chat to open on `routineId`'s editor once it shows. */
export function askToChangeRoutine(agentId: string, routineId: string, now = Date.now()): void {
  pending = { agentId, routineId, at: now };
}

/** The routine `agentId`'s chat was asked to open on, once; null otherwise. */
export function takeRoutineAsk(agentId: string, now = Date.now()): string | null {
  const ask = pending;
  if (!ask || ask.agentId !== agentId) return null;
  pending = null;
  return now - ask.at <= TTL_MS ? ask.routineId : null;
}
