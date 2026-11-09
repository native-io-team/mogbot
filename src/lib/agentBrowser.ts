/**
 * "Let agents use your browser": the team's signed-in Chrome, through Claude
 * in Chrome (`src-tauri/src/agents/browser.rs`). Types mirroring the Rust
 * status, the invoke wrappers, and the card's words.
 *
 * The app checks it itself (no model turn, nothing opened in Chrome), and
 * switches it on only once a browser answers. From then on an agent uses it
 * without asking first, except in a turn answering outside text; every
 * click, post, send or payment still asks on a card.
 *
 * @module lib/agentBrowser
 */

import { invoke } from '@tauri-apps/api/core';

export type BrowserStepId = 'claude_code' | 'extension' | 'connect';

export interface BrowserStep {
  id: BrowserStepId;
  done: boolean;
  title: string;
  detail: string;
  /** The one thing to press, when there is one. */
  openUrl?: string;
  openLabel?: string;
}

export interface BrowserStatus {
  /** The team's switch. */
  enabled: boolean;
  /** A browser answered just now. */
  ready: boolean;
  steps: BrowserStep[];
  /** The Claude account Claude Code uses; the extension must use the same. */
  account?: string;
  browsers: number;
  verifiedAt?: number;
  /** Agents on Codex, which can't use it. */
  codexAgents: number;
}

export const getBrowserStatus = () => invoke<BrowserStatus>('agents_browser_status');
/** On only once a browser answers; the error names the step still to do. */
export const enableBrowser = () => invoke<BrowserStatus>('agents_browser_enable');
/** Opens the extension's page in this Mac's browser (the URL lives in Rust). */
export const openBrowserInstall = () => invoke<void>('agents_browser_open_install');

/* ------------------------------------------------------------- the words */

export const BROWSER_TITLE = 'Let agents use your browser';

/** The card's line under the title. */
export function browserLine(status: BrowserStatus | null): string {
  if (status?.enabled && status.ready) {
    return 'On. Agents use the sites you’re signed in to in Chrome, as you. Anything that sends, posts, pays or deletes still asks you first.';
  }
  if (status?.enabled) {
    return 'On, but Chrome isn’t answering right now. Open Chrome, then check again.';
  }
  return 'So agents can use the sites you’re already signed in to, instead of asking you to log in. Nothing is sent or changed without your Allow.';
}

/** The consent line on the setup checklist, before the check uses it. */
export const BROWSER_CHECK_CONSENT =
  'Let your team use your signed-in browser to check what it can reach? It only looks: nothing is sent or changed.';
