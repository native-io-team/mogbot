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
  /** Where each setup step stands, read from the Mac and Chrome's own records. */
  steps: UserChromeSteps;
  /** The folder for Chrome's "Load unpacked". */
  extensionDir?: string | null;
  extensionVersion?: string | null;
  /** The Web Store listing, once there is one. */
  webStoreUrl?: string | null;
  extensionId: string;
  browsers: UserChromeBrowser[];
  updateNeeded: boolean;
  /** Chrome's policy and profiles (`user_chrome::managed`). */
  management: ChromeManagement;
  /** The way agents reach the user's Chrome now, and why (`agents::chrome_route`). */
  route: ChromeRouteNow;
}

/** What this Mac's Chrome policy (MDM) blocks, in every profile. */
export type ChromeBlock = 'developer_mode' | 'install' | 'native_host';

export interface ChromeProfile {
  /** Chrome's folder for it ("Default", "Profile 2"). */
  dir: string;
  name: string;
  /** Its account's Workspace domain, when it has one. */
  domain?: string;
  /** An organisation's policy applies to it. */
  managed: boolean;
  /** The profile Chrome opened last. */
  lastUsed: boolean;
}

export interface ChromeManagement {
  machine: ChromeBlock[];
  profiles: ChromeProfile[];
}

export type ChromeRoute = 'your_chrome' | 'claude_in_chrome' | 'none';
export type ChromeRouteWhy =
  | 'your_chrome_connected'
  | 'your_chrome_not_connected'
  | 'your_chrome_off'
  | 'claude_in_chrome_down'
  | 'not_set_up'
  | 'codex_needs_your_chrome'
  | 'off_for_agent'
  | 'not_allowed'
  | 'outside_text';

export interface ChromeRouteNow {
  route: ChromeRoute;
  why: ChromeRouteWhy;
}

export const getUserChromeStatus = () => invoke<UserChromeStatus>('agents_user_chrome_status');
export const setUserChromeEnabled = (on: boolean) =>
  invoke<UserChromeStatus>('agents_user_chrome_set_enabled', { on });
/** Shows the extension's folder in Finder (the path lives in Rust). */
export const showUserChromeExtension = () => invoke<void>('agents_user_chrome_show_extension');
/** Opens chrome://extensions in Google Chrome. */
export const openChromeExtensionsPage = () =>
  invoke<void>('agents_user_chrome_open_extensions_page');
/**
 * Opens Chrome in a personal profile (`dir`, one that isn't managed) or a new
 * one (no `dir`), for adding the extension where work policy doesn't reach.
 * Answers the profile folder it opened.
 */
export const openChromeProfile = (dir?: string) =>
  invoke<string>('agents_user_chrome_open_profile', { dir: dir ?? null });
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
  return 'On. Do the steps below, each ticks Done by itself, then keep Chrome open.';
}

/** "Chrome can find this app" row. */
export function hostLine(host: HostState): string {
  switch (host) {
    case 'current':
      return 'Done. Chrome can reach this app.';
    case 'stale':
      return 'Not done yet: the app moved since Chrome was told where it is. Press Set it up again.';
    default:
      return 'Not done yet. Press Set it up again.';
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

/* ------------------------------------------------------ the setup, in steps */

/** Mirrors `user_chrome::setup::Steps`: every field a real check. */
export interface UserChromeSteps {
  chrome: boolean;
  host: boolean;
  files: boolean;
  /** A profile with Developer mode on (a personal one first). */
  developerMode: string | null;
  /** The profile the extension is in. */
  loadedIn: string | null;
  /** In Chrome, but turned off there. */
  turnedOff: boolean;
  /** Loaded from another folder than the app's. */
  otherFolder: boolean;
  connected: boolean;
}

export type SetupStepId = 'chrome' | 'host' | 'developerMode' | 'load' | 'connect';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  done: boolean;
  /** "Done…" or "Not done yet…" with the one thing to do. */
  line: string;
}

/**
 * The steps from turning it on to Connected, in the order the user does
 * them, each ticking Done from what the app read (never from a click).
 * Chrome writes Developer mode and the extension's record a few seconds
 * after the change, so those two can tick a moment late; a later step done
 * counts for the earlier ones (an extension can't load without Developer
 * mode). Only while it's on and Load unpacked is the way in.
 */
export function setupSteps(s: UserChromeStatus): SetupStep[] {
  const st = s.steps;
  const connected = st.connected || s.browsers.length > 0;
  const loaded = connected || (!!st.loadedIn && !st.turnedOff);
  const devMode = loaded || !!st.loadedIn || !!st.developerMode;
  const steps: SetupStep[] = [];
  if (!s.chromeInstalled) {
    steps.push({
      id: 'chrome',
      title: 'Install Google Chrome',
      done: false,
      line: 'Not done yet. Install Google Chrome on this Mac, then come back here.',
    });
  }
  steps.push({
    id: 'host',
    title: 'Chrome can reach this app',
    done: s.host === 'current' && !s.error,
    line: s.error
      ? `Not done yet: it couldn’t start (${s.error.trim().replace(/[.!]+$/, '')}). Press Set it up again.`
      : hostLine(s.host),
  });
  steps.push({
    id: 'developerMode',
    title: 'Turn on Developer mode in Chrome',
    done: devMode,
    line: devMode
      ? st.developerMode
        ? `Done, in “${st.developerMode}”.`
        : 'Done.'
      : 'Not done yet. Open Chrome’s extensions page and turn on Developer mode, the switch at the top right.',
  });
  steps.push({
    id: 'load',
    title: 'Add the app’s extension',
    done: loaded,
    line: loaded
      ? st.loadedIn
        ? `Done, in “${st.loadedIn}”.${st.otherFolder ? ' It was loaded from another folder, so app updates won’t reach it: remove it and load the app’s folder instead.' : ''}`
        : 'Done.'
      : st.turnedOff
        ? `Not done yet: it’s in “${st.loadedIn}” but turned off. Turn it on in Chrome’s extensions page.`
        : 'Not done yet. Drag the app’s folder from Finder onto the extensions page. Or press Load unpacked, then ⇧⌘G, paste the folder’s path and press Select.',
  });
  steps.push({
    id: 'connect',
    title: 'Extension connected',
    done: connected,
    line: connected
      ? 'Done. Agents use it from their next message.'
      : loaded
        ? 'Not done yet: waiting for the extension to reach the app. If it hasn’t in a minute, click the extension’s icon in Chrome and press Try again.'
        : 'Not done yet. This ticks by itself once the extension is added.',
  });
  return steps;
}

/** The step to do now: the first one not done, or `null` when all are. */
export function currentStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((x) => !x.done) ?? null;
}

/** A connected profile, in words. */
export function browserLabel(b: UserChromeBrowser, i: number): string {
  return b.label || `Chrome profile ${i + 1}`;
}

/* ------------------------------------------- which way agents use, and why */

/** Settings → Chrome: the way agents reach your Chrome now, in one sentence. */
export function routeLine(now: ChromeRouteNow): string {
  switch (now.route) {
    case 'your_chrome':
      return 'Your Chrome, for every agent on Claude Code or Codex and on any account. Switching accounts never needs a browser sign-in.';
    case 'claude_in_chrome':
      return now.why === 'your_chrome_not_connected'
        ? 'Claude in Chrome for now, because Your Chrome isn’t connected. Open Chrome with the app’s extension and agents go back to it by themselves.'
        : 'Claude in Chrome, for agents on Claude Code. It’s tied to the Claude account signed in to its extension, so switching accounts can mean signing in again. Your Chrome doesn’t have that problem.';
    default:
      return routeNoneLine(now.why, 'this agent');
  }
}

function routeNoneLine(why: ChromeRouteWhy, agentName: string): string {
  switch (why) {
    case 'claude_in_chrome_down':
      return 'None right now: Claude in Chrome isn’t answering and Your Chrome isn’t connected. Agents use their own browser meanwhile.';
    case 'your_chrome_not_connected':
      return 'None right now: Your Chrome isn’t connected. Open Chrome with the app’s extension and agents use it by themselves.';
    case 'codex_needs_your_chrome':
      return 'None: agents on Codex reach your Chrome only through Your Chrome, which isn’t on.';
    case 'off_for_agent':
      return `None: you took the browser away from ${agentName}.`;
    case 'not_allowed':
      return `None: ${agentName}’s settings don’t let it use a browser.`;
    case 'outside_text':
      return 'None while it answers someone else’s message.';
    default:
      return 'None: neither Your Chrome nor Claude in Chrome is set up, so agents use their own browser.';
  }
}

/** "What it can reach": the browser row's name, by the way it uses now. */
export function routeName(now: ChromeRouteNow): string {
  switch (now.route) {
    case 'your_chrome':
      return 'Chrome, through Your Chrome';
    case 'claude_in_chrome':
      return 'Chrome, through Claude in Chrome';
    default:
      return 'Not reaching your Chrome now';
  }
}

/** "What it can reach": why it uses that way, for one agent. */
export function routeWhy(now: ChromeRouteNow, agentName: string): string {
  switch (now.route) {
    case 'your_chrome':
      return 'The app’s own extension: the same on any account and engine, so switching accounts never needs a browser sign-in.';
    case 'claude_in_chrome':
      return now.why === 'your_chrome_not_connected'
        ? 'Your Chrome isn’t connected, so it falls back to Claude in Chrome, which is tied to the Claude account signed in to its extension.'
        : 'Tied to the Claude account signed in to its extension: switching accounts can mean signing in again. Set up Your Chrome (Settings → Chrome) to stop that.';
    default:
      return routeNoneLine(now.why, agentName);
  }
}

/* --------------------------------------------- a profile managed by work */

const BLOCK_WORDS: Record<ChromeBlock, string> = {
  developer_mode: 'Developer mode',
  install: 'adding extensions like this one',
  native_host: 'extensions talking to apps on this Mac',
};

/** What to say when Chrome's policy keeps the extension out, if it does. */
export interface ManagedAdvice {
  /** The one sentence. */
  line: string;
  /** Every profile is managed (this Mac's policy): a new profile won't help. */
  everyProfile: boolean;
  /** A personal profile already there, to open instead of a new one. */
  personal?: ChromeProfile;
}

/**
 * The advice for `s`: this Mac's policy (every profile), else the profile
 * Chrome opened last being managed. `reported`: the user said Chrome won't
 * let them (Developer mode greyed out), which the app can't see itself.
 * `null` while nothing says it's in the way.
 */
export function managedAdvice(s: UserChromeStatus, reported = false): ManagedAdvice | null {
  const m = s.management;
  if (!m) return null;
  const personal = m.profiles.find((p) => !p.managed);
  if (m.machine.length > 0) {
    const what = m.machine.map((b) => BLOCK_WORDS[b]).join(' and ');
    return {
      line: `Chrome on this Mac is managed by your work, and its policy turns off ${what} in every profile, so the app’s extension can’t be added here. Ask whoever manages this Mac to allow it; until then agents use Claude in Chrome or their own browser.`,
      everyProfile: true,
    };
  }
  const last = m.profiles.find((p) => p.lastUsed);
  if (last?.managed) {
    return {
      line: `This Chrome profile (“${last.name}”${last.domain ? `, ${last.domain}` : ''}) is managed by your work, so it can’t add the app’s extension. Use a personal Chrome profile for your agents’ browsing.`,
      everyProfile: false,
      personal,
    };
  }
  if (reported) {
    return {
      line: 'Then this Chrome profile is managed by your work, so it can’t add the app’s extension. Use a personal Chrome profile for your agents’ browsing.',
      everyProfile: false,
      personal: personal && !personal.lastUsed ? personal : undefined,
    };
  }
  return null;
}

/** The steps in a personal profile, after it opens. */
export const PERSONAL_PROFILE_STEPS =
  'Then add the extension in that window (the next step) and sign in there to the sites your agents need. You do this once.';
