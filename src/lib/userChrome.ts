/**
 * "Your Chrome": agents use the user's own Chrome, where they're signed in,
 * through the app's own extension (`src-tauri/src/user_chrome/`). Any
 * engine, any account: Claude Code and Codex alike, no Claude in Chrome.
 * Off until the user turns it on. Types mirroring the Rust status, the
 * invoke wrappers, and the Settings words.
 *
 * Not `agentBrowser.ts` (Claude in Chrome) and not `agentsOwnBrowser.ts`
 * (the team's own Chrome profile).
 *
 * @module lib/userChrome
 */

import { invoke } from '@tauri-apps/api/core';

export type HostState = 'missing' | 'stale' | 'current';

export interface UserChromeBrowser {
  profileId: string;
  /** What the user named the profile in the extension, else empty. */
  label: string;
  extensionVersion: string;
  connectedAt: number;
}

export interface UserChromeStatus {
  supported: boolean;
  enabled: boolean;
  listening: boolean;
  /** Why it isn't listening while switched on. */
  error?: string | null;
  chromeInstalled: boolean;
  host: HostState;
  /** The folder for Chrome's "Load unpacked". */
  extensionDir?: string | null;
  extensionVersion?: string | null;
  /** The Web Store listing, once there is one. */
  webStoreUrl?: string | null;
  extensionId: string;
  browsers: UserChromeBrowser[];
  updateNeeded: boolean;
}

export const getUserChromeStatus = () => invoke<UserChromeStatus>('agents_user_chrome_status');
export const setUserChromeEnabled = (on: boolean) =>
  invoke<UserChromeStatus>('agents_user_chrome_set_enabled', { on });
/** Shows the extension's folder in Finder (the path lives in Rust). */
export const showUserChromeExtension = () => invoke<void>('agents_user_chrome_show_extension');
/** Opens chrome://extensions in Google Chrome. */
export const openChromeExtensionsPage = () =>
  invoke<void>('agents_user_chrome_open_extensions_page');
/** Once listed: Chrome offers it on its next start, and the listing opens. */
export const addUserChromeFromStore = () => invoke<void>('agents_user_chrome_add_from_store');

/* ------------------------------------------------------------- the words */

export const USER_CHROME_TITLE = 'Your Chrome';

/** Said once when the extension connects while its settings are open. */
export const USER_CHROME_CONNECTED =
  'Your Chrome is connected. Agents use it from their next message.';

/** The line under the switch. */
export function userChromeLine(s: UserChromeStatus | null): string {
  if (!s?.enabled) {
    return 'Let agents, on Claude Code or Codex, use the sites you’re signed in to in Chrome, through this app’s own extension. Anything that sends, posts, pays or deletes still asks you first.';
  }
  if (s.error) return `On, but it couldn’t start: ${s.error.trim().replace(/[.!]+$/, '')}.`;
  if (s.browsers.length === 1) {
    return 'On. Agents can use your Chrome, in tabs of their own.';
  }
  if (s.browsers.length > 1) {
    return `On. Agents can use ${s.browsers.length} of your Chrome profiles, in tabs of their own.`;
  }
  return 'On. Add the extension to Chrome, then keep Chrome open.';
}

/** "Chrome can find this app" row. */
export function hostLine(host: HostState): string {
  switch (host) {
    case 'current':
      return 'Done. Chrome can reach this app.';
    case 'stale':
      return 'Not done yet: the app moved since Chrome was told where it is. Turn Your Chrome off and on.';
    default:
      return 'Not done yet. Turn Your Chrome off and on to set it up.';
  }
}

/** "Add the extension" row. */
export function extensionLine(s: UserChromeStatus): string {
  if (s.browsers.length > 0) return 'Done. The extension is connected.';
  if (s.webStoreUrl) {
    return 'Not done yet. Add it from the Chrome Web Store, then press Enable when Chrome asks.';
  }
  return 'Not done yet. In Chrome’s extensions page turn on Developer mode, press Load unpacked, and choose this folder (copy its path, then ⇧⌘G in the picker). This turns to Connected by itself.';
}

/** A connected profile, in words. */
export function browserLabel(b: UserChromeBrowser, i: number): string {
  return b.label || `Chrome profile ${i + 1}`;
}
