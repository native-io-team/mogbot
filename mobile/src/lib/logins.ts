/**
 * Login cards (desktop `agents/logins.rs`): an agent asks for an app with
 * `request_login`, and the card connects it the safest way there is. Every
 * way in runs on the Mac: Connect here asks the Mac to start it, the Mac
 * opens the sign-in in its own browser, and the token is made and kept in
 * its Keychain. This phone only ever sends which way in was chosen (and, for
 * the key option, the key itself, under the same rule as a secret card).
 *
 * The pure parts are in `loginState.ts`, re-exported here.
 */

import type { AgentSecret } from '@shipstudio/companion-protocol';
import { secretRouteProblem } from './secrets';
import { call, currentTransport } from './session';

export * from './loginState';

/* ------------------------------------------------------------- calls */

export const loginStart = (agentId: string, requestId: string, optionId: string) =>
  call('agents.loginStart', { agentId, requestId, optionId });

export const loginCancel = (agentId: string, requestId: string) =>
  call('agents.loginCancel', { agentId, requestId });

export const loginDecline = (agentId: string, requestId: string, note?: string) =>
  call('agents.loginDecline', { agentId, requestId, ...(note ? { note } : {}) });

export const loginDismiss = (agentId: string, requestId: string) =>
  call('agents.loginDismiss', { agentId, requestId });

export const readReach = (agentId: string) => call('agents.reach', { agentId });

export const readTeam = (since?: number) =>
  call('agents.loginsTeam', since !== undefined ? { since } : {});

export const connectNeed = (key: string, optionId: string, skip: string[]) =>
  call('agents.loginsConnect', { key, optionId, ...(skip.length ? { skip } : {}) });

/**
 * A login card's API key, to the Mac's Keychain: only over Tailscale, on a
 * connection that proved it's the Mac paired with, as one request, never
 * kept here (the same rule as `sendSecret`).
 */
export async function saveLoginKey(
  agentId: string,
  requestId: string,
  value: string
): Promise<AgentSecret> {
  const t = currentTransport();
  if (!t) throw new Error('Not paired');
  const problem = secretRouteProblem(
    t.state.kind === 'connected' ? t.route : null,
    t.identityVerified
  );
  if (problem) throw new Error(problem);
  return t.request('agents.loginSaveKey', { agentId, requestId, value });
}
