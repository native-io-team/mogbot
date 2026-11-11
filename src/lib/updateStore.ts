/**
 * The app's one update flow, per window: check on launch and every few hours,
 * download a newer version in the background (the updater plugin verifies its
 * signature), then say once, in the sidebar, that it's ready. Installing waits
 * for the user's "Restart to update".
 *
 * A module-level store rather than component state: the sidebar (and with it
 * `UpdateBanner`) is remounted on every view change, and a download must not
 * restart, or a dismissed banner come back, because the user opened a project.
 *
 * Only the main window runs the automatic checks, so two windows never
 * download (and install) the same update twice.
 *
 * "Never nag more than once per version": Later remembers the version (in
 * localStorage, per this Mac), and the banner stays away for it until a newer
 * one is out or the user asks for updates in ⌘K.
 *
 * @module lib/updateStore
 */

import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  isMockUpdateSimulationEnabled,
  releaseUpdate,
  restartApp,
  UPDATES_ENABLED,
  type UpdateHandle,
  type UpdateInfo,
} from './updater';
import { invoke } from '@tauri-apps/api/core';
import { getWindowLabel } from './window';
import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';
import { trackEvent, trackError } from './analytics';

/** First check this long after launch: never in the way of starting up. */
export const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** Then every four hours, for an app that stays open for days. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const DISMISSED_KEY = 'updates.dismissedVersion';

export type UpdatePhase =
  /** Nothing to offer (or not checked yet). */
  | 'idle'
  /** A newer version is downloading in the background; nothing is shown. */
  | 'downloading'
  /** Downloaded and verified: the banner offers "Restart to update". */
  | 'ready'
  /** The user clicked restart: putting it in place. */
  | 'installing'
  /** Putting it in place failed; the banner says so and offers to try again. */
  | 'error';

export interface UpdateSnapshot {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  progress: number;
  error: string | null;
  /** Running from the installer disk (or a quarantined copy): it can't replace
   *  itself until it's in Applications (`commands::app_location`). */
  needsMove: boolean;
  /** The user said Later to this version. */
  dismissed: boolean;
}

/** What a check found, for ⌘K "Check for updates" to say. */
export type CheckOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  /** A development build reports a release but never installs one. */
  | { kind: 'dev-build'; version: string }
  | { kind: 'failed'; message: string };

const IDLE: UpdateSnapshot = {
  phase: 'idle',
  info: null,
  progress: 0,
  error: null,
  needsMove: false,
  dismissed: false,
};

let snapshot: UpdateSnapshot = IDLE;
let handle: UpdateHandle | null = null;
let checking: Promise<CheckOutcome> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<() => void>();

function set(next: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string | null) {
  try {
    if (version === null) localStorage.removeItem(DISMISSED_KEY);
    else localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Storage unavailable: the banner may show again next launch, no worse.
  }
}

export function subscribeUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

/** A development build (not the mock simulation) never downloads a release. */
function isDevBuild(): boolean {
  return import.meta.env.DEV && !isMockUpdateSimulationEnabled();
}

async function download(next: UpdateHandle, info: UpdateInfo) {
  set({ phase: 'downloading', info, progress: 0, error: null });
  void trackEvent('update_started', { version: info.version, $screen_name: 'Background' });
  try {
    await downloadUpdate(next, (progress) => {
      if (handle === next) set({ progress });
    });
    if (handle !== next) return;
    set({ phase: 'ready', progress: 100, dismissed: readDismissed() === info.version });
    void trackEvent('update_downloaded', { version: info.version, $screen_name: 'Background' });
  } catch (err) {
    if (handle !== next) return;
    // Offline, a dropped connection, or a bundle that failed its signature
    // check: nothing for the user to do now, so nothing is shown. The next
    // check starts over.
    logger.warn('[Updates] Background download failed', {
      version: info.version,
      error: formatCommandError(asCommandError(err)),
    });
    trackError('update_download', err, 'Background');
    handle = null;
    void releaseUpdate(next).catch(() => undefined);
    set({ ...IDLE });
    throw err;
  }
}

async function runCheck(manual: boolean): Promise<CheckOutcome> {
  const busy = snapshot.phase === 'downloading' || snapshot.phase === 'installing';
  if (busy && snapshot.info) {
    return { kind: 'downloading', version: snapshot.info.version };
  }

  let result: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    result = await checkForUpdate();
  } catch (err) {
    return { kind: 'failed', message: formatCommandError(asCommandError(err)) };
  }

  if (!result) {
    // Keep a downloaded update: the feed going quiet doesn't undo it.
    if (snapshot.phase === 'ready' && snapshot.info) {
      if (manual) set({ dismissed: false });
      return { kind: 'ready', version: snapshot.info.version };
    }
    return { kind: 'up-to-date' };
  }

  const { version } = result.info;
  if (isDevBuild()) return { kind: 'dev-build', version };

  // The user asking is the user un-saying Later.
  if (manual && readDismissed() === version) writeDismissed(null);

  if (
    (snapshot.phase === 'ready' || snapshot.phase === 'error') &&
    snapshot.info?.version === version
  ) {
    if (manual) set({ dismissed: false });
    return { kind: 'ready', version };
  }

  // A newer version than the one waiting: let go of the old bytes.
  const previous = handle;
  handle = result.update;
  if (previous) void releaseUpdate(previous).catch(() => undefined);

  const downloading = download(result.update, result.info);
  if (manual) {
    // Report straight away; the banner says when it's ready.
    downloading.catch(() => undefined);
    return { kind: 'downloading', version };
  }
  try {
    await downloading;
    return { kind: 'ready', version };
  } catch (err) {
    return { kind: 'failed', message: formatCommandError(asCommandError(err)) };
  }
}

/**
 * Check now. `manual` is ⌘K "Check for updates": it brings back a banner the
 * user dismissed, and returns as soon as a download starts.
 */
export function checkForUpdatesNow(options: { manual?: boolean } = {}): Promise<CheckOutcome> {
  const manual = options.manual ?? false;
  if (!checking) {
    checking = runCheck(manual).finally(() => {
      checking = null;
    });
  } else if (manual) {
    // A background check is already running: answer from what it finds.
    return checking.then((outcome) => {
      if (outcome.kind === 'ready' || outcome.kind === 'downloading') {
        if (readDismissed() === outcome.version) writeDismissed(null);
        set({ dismissed: false });
      }
      return outcome;
    });
  }
  return checking;
}

function schedule(delayMs: number) {
  timer = setTimeout(() => {
    void checkForUpdatesNow().finally(() => schedule(UPDATE_CHECK_INTERVAL_MS));
  }, delayMs);
}

/**
 * Start the automatic checks (launch + every few hours). Idempotent; a no-op
 * in a build without an update feed, in development (unless simulating with
 * VITE_MOCK_UPDATE=1), and in any window but the main one.
 */
export function startAutomaticUpdateChecks(windowLabel: () => string = getWindowLabel): void {
  if (started) return;
  if (!UPDATES_ENABLED && !isMockUpdateSimulationEnabled()) return;
  if (isDevBuild()) return;
  let label: string;
  try {
    label = windowLabel();
  } catch {
    return;
  }
  if (label !== 'main') return;
  started = true;
  schedule(FIRST_CHECK_DELAY_MS);
}

/** Later: hide the banner for this version, until a newer one or a ⌘K check. */
export function dismissUpdate(): void {
  const version = snapshot.info?.version;
  if (!version) return;
  writeDismissed(version);
  set({ dismissed: true });
  void trackEvent('update_deferred', { version, $screen_name: 'Project Sidebar' });
}

/** What the banner says when the app runs from the installer disk. */
export const MOVE_FIRST =
  'The app is running from the installer disk, so it can’t update itself. Move it to Applications and it will update from there.';

/** Is the app somewhere it can't replace itself (the installer disk, a quarantined copy)? */
async function runningOutsideApplications(): Promise<boolean> {
  try {
    const where = await invoke<{ needsMove: boolean }>('app_location');
    return where.needsMove;
  } catch {
    return false;
  }
}

/** Copy the app into Applications and reopen it from there (it quits this copy). */
export async function moveToApplications(): Promise<void> {
  try {
    await invoke<string>('move_to_applications');
  } catch (err) {
    set({ phase: 'error', needsMove: true, error: formatCommandError(asCommandError(err)) });
  }
}

/** Put the downloaded version in place and relaunch into it. */
export async function installAndRestart(): Promise<void> {
  const current = handle;
  if (!current || (snapshot.phase !== 'ready' && snapshot.phase !== 'error')) return;
  // From the installer disk the update can only fail (and a half-done
  // attempt can leave nothing to open): say so and offer the move instead.
  if (await runningOutsideApplications()) {
    set({ phase: 'error', needsMove: true, error: MOVE_FIRST });
    return;
  }
  set({ phase: 'installing', error: null });
  try {
    await installUpdate(current);
  } catch (err) {
    const detail = formatCommandError(asCommandError(err));
    logger.warn('[Updates] Install failed', { error: detail });
    trackError('update_install', err, 'Project Sidebar');
    if (/read-only file system|os error 30/i.test(detail)) {
      set({ phase: 'error', needsMove: true, error: MOVE_FIRST });
      return;
    }
    set({ phase: 'error', error: `Couldn't install the update: ${detail}` });
    return;
  }
  try {
    const restarted = await restartApp();
    if (restarted === 'simulated') {
      handle = null;
      writeDismissed(null);
      set({ ...IDLE });
    }
  } catch (err) {
    const detail = formatCommandError(asCommandError(err));
    logger.warn('[Updates] Restart failed', { error: detail });
    trackError('app_restart', err, 'Project Sidebar');
    // Installed already: quitting and reopening finishes it.
    set({
      phase: 'error',
      error: `The update is installed but the app couldn't restart (${detail}). Quit and reopen it to finish.`,
    });
  }
}

/** What ⌘K "Check for updates" says about a check, as a toast. */
export function updateCheckMessage(outcome: CheckOutcome): {
  text: string;
  tone: 'success' | 'error' | 'info';
} {
  switch (outcome.kind) {
    case 'up-to-date':
      return { text: "You're up to date", tone: 'success' };
    case 'downloading':
      return {
        text: `Version ${outcome.version} is downloading. The sidebar says when it's ready`,
        tone: 'info',
      };
    case 'ready':
      return {
        text: `Version ${outcome.version} is ready: Restart to update in the sidebar`,
        tone: 'info',
      };
    case 'dev-build':
      return {
        text: `Version ${outcome.version} is out. A development build doesn't update itself`,
        tone: 'info',
      };
    case 'failed':
      return { text: "Couldn't check for updates. Try again when you're online", tone: 'error' };
  }
}

/** Tests only: back to a fresh launch. */
export function resetUpdateStoreForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  handle = null;
  checking = null;
  snapshot = IDLE;
  listeners.clear();
}
