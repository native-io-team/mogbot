/**
 * The agents' own browser (`src-tauri/src/agent_browser/`): a Google Chrome
 * the app starts on a profile of its own, separate from the user's
 * personal Chrome, for agents on Claude Code and Codex alike. Types
 * mirroring the Rust status, the invoke wrappers, and the Settings words.
 *
 * Not `agentBrowser.ts`, which is "Let agents use your browser": the
 * user's own Chrome through Claude in Chrome.
 *
 * @module lib/agentsOwnBrowser
 */

import { invoke } from '@tauri-apps/api/core';

export interface AgentsBrowserPermissions {
  screenRecording: boolean;
  accessibility: boolean;
}

export interface AgentsBrowserStatus {
  /** This build has it. */
  compiled: boolean;
  /** The Settings switch (on unless turned off). */
  enabled: boolean;
  chromeInstalled: boolean;
  running: boolean;
  /** For signing in to Google from the phone (a plain window shown through macOS). */
  permissions: AgentsBrowserPermissions;
}

export type AgentsBrowserPermission = 'screen_recording' | 'accessibility';

export const getAgentsBrowserStatus = () =>
  invoke<AgentsBrowserStatus>('agents_agent_browser_status');
export const setAgentsBrowserEnabled = (on: boolean) =>
  invoke<AgentsBrowserStatus>('agents_agent_browser_set_enabled', { on });
/**
 * Bring an agent's page in its own browser on screen to watch it work
 * (`show`), or put the window back in its corner.
 */
export const showAgentBrowser = (agentId: string, show: boolean) =>
  invoke<void>('agents_show_agent_browser', { agentId, show });
/** Asks macOS (Screen Recording prompts once) and opens that pane of System Settings. */
export const openAgentsBrowserPermission = (which: AgentsBrowserPermission) =>
  invoke<AgentsBrowserStatus>('agents_agent_browser_permission', { which });

/* ------------------------------------------------------------- the words */

export const AGENTS_BROWSER_TITLE = 'Agents’ browser';

/** The switch's line. */
export function agentsBrowserLine(s: AgentsBrowserStatus | null): string {
  if (s && !s.chromeInstalled)
    return 'Needs Google Chrome on this Mac. Agents use their own profile in it, not yours.';
  if (s && !s.enabled) return 'Off. Agents use only your own Chrome, through Claude in Chrome.';
  return 'A Chrome of the team’s own on this Mac, not your personal one. You sign in to sites for them from your phone.';
}

/** The permission rows: what each is for, in one line. */
export const PERMISSION_ROWS: {
  id: AgentsBrowserPermission;
  label: string;
  description: string;
}[] = [
  {
    id: 'screen_recording',
    label: 'Screen Recording',
    description: 'So your phone can see the one Chrome window Google signs in to.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'So your taps and typing on the phone reach that window.',
  },
];

/** The heading line over the permission rows. */
export function permissionsLine(p: AgentsBrowserPermissions): string {
  if (p.screenRecording && p.accessibility) return 'Google sign-ins work from your phone too.';
  return 'Google won’t sign in to a browser the app drives, so its sign-in uses a plain window. To do that from your phone, allow both once; otherwise Google needs one sign-in at the Mac.';
}
