/**
 * Login cards (desktop `agents/logins.rs`): an agent asks for an app with
 * `request_login`, and the card connects it the safest way there is. The
 * token is always made and kept in the Mac's Keychain. With a Mac that has
 * `logins.phone`, the sign-in itself can happen here, away from the Mac
 * (`phoneWay`): the provider's page in the system sign-in sheet, whose
 * one-time code goes to the Mac and nowhere else; GitHub's device code;
 * claude.ai opened here. Otherwise Connect asks the Mac to open the sign-in
 * in its own browser. This phone persists nothing from any of them.
 *
 * The pure parts are in `loginState.ts`, re-exported here.
 */

import type { AgentSecret, TeamLogins, TeamNeed } from '@shipstudio/companion-protocol';
import { CLAUDE_AI_CONNECTORS_URL } from '@shipstudio/companion-protocol';
import { requireOptionalNativeModule } from 'expo';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { secretRouteProblem } from './secrets';
import { call, currentTransport } from './session';

export * from './loginState';

/* ------------------------------------------------------------- calls */

export const loginStart = (agentId: string, requestId: string, optionId: string, onPhone = false) =>
  call('agents.loginStart', { agentId, requestId, optionId, ...(onPhone ? { onPhone } : {}) });

export const loginCancel = (agentId: string, requestId: string) =>
  call('agents.loginCancel', { agentId, requestId });

export const loginDecline = (agentId: string, requestId: string, note?: string) =>
  call('agents.loginDecline', { agentId, requestId, ...(note ? { note } : {}) });

export const loginDismiss = (agentId: string, requestId: string) =>
  call('agents.loginDismiss', { agentId, requestId });

/** "Not needed" on a card: its app, declined for the whole team and remembered on the Mac. */
export const loginNotNeeded = (agentId: string, requestId: string) =>
  call('agents.loginNotNeeded', { agentId, requestId });

/** "Not needed" on rows (`keys`), or "Skip the rest" (none: every row still waiting). */
export const loginsNotNeeded = (keys?: string[]) =>
  call('agents.loginsNotNeeded', keys ? { keys } : {});

/** Undo a "Not needed", or turn an app back on. */
export const loginsUndecline = (keys: string[]) => call('agents.loginsUndecline', { keys });

/** The app is back in front of the user: the Mac checks claude.ai connectors now. */
export const loginsRecheck = () => call('agents.loginsRecheck', {});

export const readReach = (agentId: string) => call('agents.reach', { agentId });

export const readTeam = (since?: number) =>
  call('agents.loginsTeam', since !== undefined ? { since } : {});

/**
 * The list for some agents only (the "Setting up your team" card's): other
 * agents' cards are left off, empty rows go, progress counts what's shown,
 * and `hidden` is who a Connect on the row must skip (as the desk's `scopeTeam`).
 */
export function scopeTeam(
  team: TeamLogins,
  agentIds: ReadonlySet<string>
): TeamLogins & { needs: (TeamNeed & { hidden: string[] })[] } {
  const needs = team.needs.flatMap((need) => {
    const cards = need.cards.filter((c) => agentIds.has(c.agentId));
    if (cards.length === 0) return [];
    const hidden = [
      ...new Set(need.cards.filter((c) => !agentIds.has(c.agentId)).map((c) => c.agentId)),
    ];
    return [{ ...need, cards, done: cards.every((c) => c.state !== 'waiting'), hidden }];
  });
  return { needs, done: needs.filter((n) => n.done).length, total: needs.length };
}

export const connectNeed = (key: string, optionId: string, skip: string[], onPhone = false) =>
  call('agents.loginsConnect', {
    key,
    optionId,
    ...(skip.length ? { skip } : {}),
    ...(onPhone ? { onPhone } : {}),
  });

/** Where claude.ai's connectors are added (Customize → Connectors): one copy, in the protocol package. */
export const CLAUDE_AI_CONNECTORS = CLAUDE_AI_CONNECTORS_URL;

type WebBrowserModule = typeof import('expo-web-browser');

/**
 * The system sign-in sheet, when this build has it. A build from before it
 * was added has no native module, so the sheet path isn't offered there
 * and its Connect starts the sign-in on the Mac, as before.
 */
function webBrowser(): WebBrowserModule | null {
  if (Platform.OS !== 'web' && !requireOptionalNativeModule('ExpoWebBrowser')) return null;
  // Loaded only once it's known to be there: importing it without its native half throws.
  return require('expo-web-browser') as WebBrowserModule;
}

export const hasSignInSheet = () => webBrowser() !== null;

/** Open a page on this phone (claude.ai, GitHub's device page), in the app if it can. */
export async function openHere(url: string): Promise<void> {
  const wb = webBrowser();
  if (wb) {
    await wb.openBrowserAsync(url, { dismissButtonStyle: 'done' });
    return;
  }
  await Linking.openURL(url);
}

export type SheetTarget = { agentId: string; requestId: string } | { key: string; skip?: string[] };

/**
 * Sign in on this phone, in the provider's own page in the system sign-in
 * sheet, ephemeral (no cookies kept). The Mac prepared it and holds the PKCE
 * verifier; the sheet's one-time code goes straight back to the Mac over this
 * paired, identity-verified connection (as a secret would) and isn't kept
 * here. Returns whether it reached the Mac; a closed sheet cancels on the Mac.
 */
export async function signInWithSheet(
  target: SheetTarget,
  optionId: string
): Promise<'sent' | 'cancelled'> {
  const wb = webBrowser();
  if (!wb) throw new Error('This version of the app can’t sign in here. Finish on your Mac.');
  const t = currentTransport();
  if (!t) throw new Error('Not paired');
  const problem = secretRouteProblem(
    t.state.kind === 'connected' ? t.route : null,
    t.identityVerified
  );
  if (problem) throw new Error(problem);
  const begun = await t.request('agents.loginPhoneBegin', { ...target, optionId });
  let result: Awaited<ReturnType<WebBrowserModule['openAuthSessionAsync']>>;
  try {
    result = await wb.openAuthSessionAsync(begun.url, begun.redirectUri, {
      preferEphemeralSession: true,
    });
  } catch (e) {
    await call('agents.loginCancel', { agentId: begun.agentId, requestId: begun.requestId }).catch(
      () => {}
    );
    throw e;
  }
  if (result.type !== 'success') {
    await call('agents.loginCancel', { agentId: begun.agentId, requestId: begun.requestId }).catch(
      () => {}
    );
    return 'cancelled';
  }
  // Straight to the Mac, once: never stored, logged or shown. The sheet may
  // have been open a while, so the connection is checked again first.
  const after = currentTransport();
  const late = after
    ? secretRouteProblem(
        after.state.kind === 'connected' ? after.route : null,
        after.identityVerified
      )
    : 'Not paired';
  if (!after || late) throw new Error(late ?? 'Not paired');
  await after.request('agents.loginPhoneFinish', { flowId: begun.flowId, callbackUrl: result.url });
  return 'sent';
}

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
