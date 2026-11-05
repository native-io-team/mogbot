/** Shared by the tests: message and agent builders, and a wait for the mock Mac. */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { newChallenge } from '../src/lib/identity';

const base = real.agentsOverview.agents[0] as Agent;

/** The Mac's real agent, idle and with nothing waiting, then `over`. */
export const agent = (over: Partial<Agent> = {}): Agent => ({
  ...base,
  pendingApprovals: 0,
  unread: 0,
  failure: undefined,
  status: { state: 'idle', activity: null, since: null },
  ...over,
});

export const msg = (id: string, ts: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({
  id,
  agentId: 'a',
  ts,
  kind: 'agent',
  text: id,
  ...extra,
});

export async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Random bytes, as the phone's `Crypto.getRandomBytes` gives them. */
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/**
 * What a transport needs to hold the mock Mac to its identity: the key and
 * id its pairing links name, and a fresh challenge per connection.
 */
export const provenBy = (mac: { fingerprint: string; serverId: string }) => ({
  pinned: { fingerprint: mac.fingerprint, serverId: mac.serverId },
  challenge: () => newChallenge(random),
});
