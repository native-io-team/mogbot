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
import { COMPUTER, THIS_COMPUTER } from './computer';

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
/** One frame of an agent's page in its own browser (`agent_browser::live`). */
export interface LiveBrowserFrame {
  /** Ask again with this as `after` for the next. */
  seq: number;
  /** A `data:image/jpeg` URL: the app's own picture, never the page's. */
  src: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

/**
 * The next frame of the agent's current page after `after`; the Mac waits a
 * moment for one. `null` when it has no page open or nothing new came.
 * `large` is the pane beside the chat (bigger, a little quicker); the chat's
 * thumbnail is about two a second. Each ask keeps the screencast going for a
 * few seconds, so stopping asking stops it.
 */
export const liveBrowserFrame = (agentId: string, after: number, large: boolean) =>
  invoke<LiveBrowserFrame | null>('agents_browser_live_frame', { agentId, after, large });
/** Nobody is looking at this size any more: stop its screencast now. */
export const stopLiveBrowser = (agentId: string, large: boolean) =>
  invoke<void>('agents_browser_live_stop', { agentId, large });

/** A page's address without its scheme and `www.`, for a header: "northwind-supply.com". */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** The site an own-browser step names ("Using its own browser · example.com"). */
export function siteOfStep(label: string | null | undefined): string | null {
  const m = label?.match(/its own browser · (\S+)$/);
  return m ? m[1] : null;
}

/* The last frame each turn showed, so the reply it ended on keeps a still of
   it. In memory only: a picture of a page is not something to write down. */
const lastFrames = new Map<string, LiveBrowserFrame>();
const MAX_KEPT = 12;
const turnKey = (agentId: string, turnStartedAt: number) => `${agentId}:${turnStartedAt}`;

export function rememberLastFrame(agentId: string, turnStartedAt: number, f: LiveBrowserFrame) {
  const key = turnKey(agentId, turnStartedAt);
  lastFrames.delete(key);
  lastFrames.set(key, f);
  while (lastFrames.size > MAX_KEPT) {
    const oldest = lastFrames.keys().next().value;
    if (oldest === undefined) break;
    lastFrames.delete(oldest);
  }
}

export function lastFrameOf(agentId: string, turnStartedAt: number): LiveBrowserFrame | null {
  return lastFrames.get(turnKey(agentId, turnStartedAt)) ?? null;
}

/** Tests only. */
export function forgetLastFrames() {
  lastFrames.clear();
}

/** Asks macOS (Screen Recording prompts once) and opens that pane of System Settings. */
export const openAgentsBrowserPermission = (which: AgentsBrowserPermission) =>
  invoke<AgentsBrowserStatus>('agents_agent_browser_permission', { which });

/* ------------------------------------------------------------- the words */

export const AGENTS_BROWSER_TITLE = 'Agents’ browser';

/** The switch's line. */
export function agentsBrowserLine(s: AgentsBrowserStatus | null): string {
  if (s && !s.chromeInstalled)
    return `Needs Google Chrome on ${THIS_COMPUTER}. Agents use their own profile in it, not yours.`;
  if (s && !s.enabled) return 'Off. Agents use only your own Chrome, through Claude in Chrome.';
  return `A Chrome of the team’s own on ${THIS_COMPUTER}, not your personal one. You sign in to sites for them from your phone.`;
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
  return `Google won’t sign in to a browser the app drives, so its sign-in uses a plain window. To do that from your phone, allow both once; otherwise Google needs one sign-in at the ${COMPUTER}.`;
}
