/**
 * Apps agents can use. Two kinds, said plainly in the dialog:
 *
 * - **Ours** (`agents::app_connect`, src-tauri/src/agents/app_connect.rs):
 *   apps this app signs in to itself, in this Mac's browser, the token in its
 *   Keychain, for the agents the user ticks, on Claude Code or Codex alike.
 * - **Claude Code's own** (`agents::apps`): servers set up in Claude Code and
 *   claude.ai's connectors, which only its turns load.
 *
 * @module lib/agentApps
 */

import { invoke } from '@tauri-apps/api/core';
import type { Access, Connection, LoginFlow } from './agentLogins';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CLAUDE_AI_CONNECTORS_URL } from '../../packages/companion-protocol/src/links';

// The words the desk and the phone share ("Who can use it", where it's kept).
export {
  ACCESS_CHOICES,
  connectionAccount,
  defaultGrantees,
  grantNote,
  grantsLine,
  keptWhere,
  pickerAccess,
} from '../../packages/companion-protocol/src/apps';

/** Where a server is set up, which decides whether this panel may remove it. */
export type AgentAppSource = 'user' | 'claudeAi' | 'other';

export interface AgentApp {
  name: string;
  /** The server's URL, or the command for a local one. */
  target: string;
  /** As Claude Code reported it: `connected`, `needs_auth`, `error` or `unknown`. */
  status: string;
  source: AgentAppSource;
}

export interface AgentApps {
  connected: AgentApp[];
}

/** An app this app signs in to itself (`app_connect::CatalogueApp`). */
export interface ConnectableApp {
  service: string;
  title: string;
  /** What reading lets an agent do. */
  read: string;
  /** What a full grant adds, each time on a card. */
  write: string;
  host: string;
}

/** A connect from the dialog (`app_connect::AppFlow`): under way, failed, or done. */
export interface AppConnectFlow {
  service: string;
  flow?: LoginFlow;
  connected?: { connectionId: string; line: string };
}

export interface AppConnections {
  apps: ConnectableApp[];
  connections: Connection[];
  flows: AppConnectFlow[];
}

export interface GrantChoice {
  agentId: string;
  access: Access;
}

/** The event each change to a dialog connect arrives on. */
export const APP_CONNECT_EVENT = 'agents-app-connect';

/** Where claude.ai's own connectors (Gmail, Calendar, Slack…) are set up: one copy, in the protocol package. */
export const CLAUDE_CONNECTORS_URL = CLAUDE_AI_CONNECTORS_URL;

/** Opens claude.ai's connector settings in the browser. */
export const openClaudeConnectors = () => openUrl(CLAUDE_CONNECTORS_URL);

export const listAgentApps = () => invoke<AgentApps>('agents_apps_list');
export const appConnections = () => invoke<AppConnections>('agents_app_connections');
/** `again`: a connection that needs signing in again, kept as that one. */
export const connectApp = (service: string, grants: GrantChoice[], again?: string) =>
  invoke<void>('agents_app_connect', { service, grants, again: again ?? null });
export const cancelAppConnect = (service: string) =>
  invoke<void>('agents_app_connect_cancel', { service });
export const reopenAppConnect = (service: string) =>
  invoke<void>('agents_app_connect_reopen', { service });
export const setConnectionGrants = (connectionId: string, grants: GrantChoice[]) =>
  invoke<Connection>('agents_connection_set_grants', { connectionId, grants });
export const removeAgentApp = (name: string) => invoke<void>('agents_apps_remove', { name });

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  needs_auth: 'Needs sign-in',
  error: 'Can’t connect',
};

/** The status in words; nothing when Claude Code didn't say. */
export const appStatusLabel = (status: string): string | null => STATUS_LABEL[status] ?? null;

/** "claude.ai Google Drive" → "Google Drive": the connector, in its own name (shared with the phone). */
export { appTitle } from '../../packages/companion-protocol/src/whenComposer';

/** A URL's host ("mcp.figma.com"); a local server's command as it is. */
export function appTarget(target: string): string {
  try {
    const url = new URL(target);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host;
  } catch {
    /* a command, not a URL */
  }
  return target;
}

/** Why a row has no Remove: it's managed where it was set up. */
export function appManagedWhere(source: AgentAppSource): string | null {
  if (source === 'claudeAi') return 'Managed on claude.ai';
  if (source === 'other') return 'Set up in a project or plugin';
  return null;
}

/** A Claude Code server that is one of the apps we connect ourselves (by host). */
export function ourAppFor(
  app: Pick<AgentApp, 'name' | 'target' | 'source'>,
  ours: readonly ConnectableApp[]
): ConnectableApp | undefined {
  if (app.source === 'claudeAi') return undefined;
  const host = appTarget(app.target);
  return ours.find((o) => o.host === host || o.service === app.name.toLowerCase());
}
