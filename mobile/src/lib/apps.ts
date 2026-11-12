/**
 * "Apps your agents can use" from the phone (desktop
 * `agents/app_connect.rs`, the dialog `AgentAppsModal`): connect one of the
 * apps the Mac signs in to itself, choose which agents can use each, remove
 * one. The token is always made and kept in the Mac's Keychain; this phone
 * never receives one.
 *
 * Connecting signs in here, on the system sign-in sheet, when the Mac serves
 * it and this build has the sheet: the Mac prepares it and keeps the PKCE
 * verifier, and the sheet's one-time code goes straight back to the Mac over
 * the paired, identity-verified connection (as a login card's does,
 * `signInWithSheet`). Otherwise the sign-in opens in the Mac's browser.
 *
 * The words are the desk's (`@shipstudio/companion-protocol` `apps.ts`).
 */

import type {
  AppConnectFlow,
  AppConnection,
  AppGrant,
  AppsOverview,
  ConnectableApp,
} from '@shipstudio/companion-protocol';
import { webBrowserModule } from './logins';
import { secretRouteProblem } from './secrets';
import { call, currentTransport } from './session';

export {
  ACCESS_CHOICES,
  connectionAccount,
  defaultGrantees,
  grantNote,
  grantsLine,
  keptWhere,
  pickerAccess,
} from '@shipstudio/companion-protocol';
import { pairedComputer } from './computer';

/* ------------------------------------------------------------- calls */

export const readApps = () => call('agents.apps', {});

/** On the Mac, in its browser: the fallback when this phone can't sign in itself. */
export const connectAppOnMac = (service: string, grants: AppGrant[], again?: string) =>
  call('agents.appsConnect', { service, grants, ...(again ? { again } : {}) });

export const cancelAppConnect = (service: string) => call('agents.appsCancel', { service });

/** Exactly these agents, each as given: the user's own answer, as on the desk. */
export const setAppGrants = (connectionId: string, grants: AppGrant[]) =>
  call('agents.appsSetGrants', { connectionId, grants });

export const removeApp = (connectionId: string) => call('agents.appsRemove', { connectionId });

/** The sheet's answer, or the route, isn't safe to send: said in the screen's words. */
function guardedTransport() {
  const t = currentTransport();
  if (!t) throw new Error('Not paired');
  const problem = secretRouteProblem(
    t.state.kind === 'connected' ? t.route : null,
    t.identityVerified
  );
  if (problem) throw new Error(problem);
  return t;
}

/**
 * Sign in to `service` on this phone's sign-in sheet, ephemeral (no cookies
 * kept), for exactly `grants`. The Mac holds the verifier; the code goes to
 * it once and isn't kept here. A closed sheet stops it on the Mac.
 */
export async function connectAppHere(
  service: string,
  grants: AppGrant[],
  again?: string
): Promise<'sent' | 'cancelled'> {
  const comp = pairedComputer();
  const wb = webBrowserModule();
  if (!wb) throw new Error(`This version of the app can’t sign in here. Connect it on ${comp.your}.`);
  const t = guardedTransport();
  const begun = await t.request('agents.appsPhoneBegin', {
    service,
    grants,
    ...(again ? { again } : {}),
  });
  let result: Awaited<ReturnType<typeof wb.openAuthSessionAsync>>;
  try {
    result = await wb.openAuthSessionAsync(begun.url, begun.redirectUri, {
      preferEphemeralSession: true,
    });
  } catch (e) {
    await cancelAppConnect(service).catch(() => {});
    throw e;
  }
  if (result.type !== 'success') {
    await cancelAppConnect(service).catch(() => {});
    return 'cancelled';
  }
  // The sheet may have been open a while: the connection is checked again first.
  const after = guardedTransport();
  await after.request('agents.loginPhoneFinish', { flowId: begun.flowId, callbackUrl: result.url });
  return 'sent';
}

/* ------------------------------------------------------------- pure */

/** How a connect goes from here: this phone's sheet, or the Mac's browser. */
export type AppWay = 'sheet' | 'mac';

export function appWay(servesSheet: boolean, hasSheet: boolean): AppWay {
  return servesSheet && hasSheet ? 'sheet' : 'mac';
}

/** Under way on the Mac: starting, or waiting for the sign-in. */
export const appSigningIn = (live?: AppConnectFlow) =>
  live?.flow?.state === 'starting' || live?.flow?.state === 'waiting';

/** The line a connect under way says, on the phone. */
export function appFlowLine(live: AppConnectFlow, title: string): string {
  const comp = pairedComputer();
  const flow = live.flow;
  if (!flow) return '';
  if (flow.state === 'starting') return `Getting ${title}’s sign-in ready…`;
  if (flow.state === 'waiting') {
    return flow.onPhone
      ? (flow.message ?? `${title}’s sign-in is open on your phone.`)
      : `Finish signing in on ${comp.your} — it’s open there.`;
  }
  if (flow.state === 'failed') return flow.message ?? 'That didn’t work. Try again.';
  return flow.message ?? 'Stopped.';
}

/**
 * What the screen lists: connections first, then the apps still to connect
 * (an app being connected stays there while it signs in, as on the desk).
 */
export function appSections(o: AppsOverview): {
  connected: AppConnection[];
  toConnect: ConnectableApp[];
  flows: Record<string, AppConnectFlow>;
} {
  const flows: Record<string, AppConnectFlow> = {};
  for (const f of o.flows) flows[f.service] = f;
  const connected = new Set(o.connections.map((c) => c.service));
  return {
    connected: o.connections,
    toConnect: o.apps.filter((a) => !connected.has(a.service) || !!flows[a.service]?.flow),
    flows,
  };
}

/** Whether the list must be read again soon: a connect is under way on the Mac. */
export const anySigningIn = (o: AppsOverview | null) => !!o?.flows.some((f) => appSigningIn(f));

/** The grants a picker saves: every ticked agent, with the one access chosen (as the desk). */
export const grantsOf = (ids: readonly string[], access: 'read' | 'full'): AppGrant[] =>
  ids.map((agentId) => ({ agentId, access }));
