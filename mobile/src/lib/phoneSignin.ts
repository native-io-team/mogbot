/**
 * The requests behind signing in on the Mac's Chrome from here. The state
 * and its words are `signinView.ts`.
 */

import type { SigninInput, SigninVia } from '@shipstudio/companion-protocol';
import { secretRouteProblem } from './secrets';
import { currentTransport } from './session';
import { signinRouteProblem } from './signinView';

function transport() {
  const t = currentTransport();
  if (!t) throw new Error('Not paired');
  return t;
}

/**
 * Only over Tailscale to a Mac that proved it's the one paired with, by the
 * same test as a secret (`secretRouteProblem`): what's typed here may be a
 * password. Said in this screen's words.
 */
function guarded() {
  const t = transport();
  const route = t.state.kind === 'connected' ? t.route : null;
  const problem = signinRouteProblem(secretRouteProblem(route, t.identityVerified), route);
  if (problem) throw new Error(problem);
  return t;
}

// Async throughout, so a refusal arrives as a rejected promise, never a throw.
export const signinBegin = async (agentId: string, requestId: string, way?: SigninVia) =>
  guarded().request('agents.signinBegin', way ? { agentId, requestId, way } : { agentId, requestId });
/** Step into an agent's own tab for its step-in card: the same screen, Done is Hand back. */
export const stepInBegin = async (agentId: string, requestId: string) =>
  guarded().request('agents.stepInBegin', { agentId, requestId });
// Pictures too: what's on the page (an address, a name) stays on Tailscale.
export const signinFrame = async (sessionId: string, after?: number) =>
  guarded().request('agents.signinFrame', after ? { sessionId, after } : { sessionId });
export const signinFallback = async (sessionId: string) =>
  guarded().request('agents.signinFallback', { sessionId });
export const signinInput = async (sessionId: string, input: SigninInput) =>
  guarded().request('agents.signinInput', { sessionId, input });
export const signinDone = async (sessionId: string, anyway = false) =>
  transport().request('agents.signinDone', anyway ? { sessionId, anyway } : { sessionId });
export const signinStop = async (sessionId: string) =>
  transport().request('agents.signinStop', { sessionId });
