/**
 * Consent before a project's own dev command runs (see
 * `src-tauri/src/commands/projects/dev_consent.rs`).
 *
 * The backend fingerprints what would run — `package.json` scripts plus the
 * repo-controlled `custom_dev_command` / `workspace_subpath` — and keeps the
 * user's approvals in the app's own support folder. The dev server starts
 * by itself only when the fingerprint is approved; otherwise `useDevServer`
 * parks a pending entry here and the Preview pane asks.
 *
 * `startDevServer` (lib/project.ts) checks again right before it spawns, so
 * a call site that forgets to ask still can't run an unapproved command.
 */
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';

export type DevServerConsentState = 'approved' | 'new' | 'changed';

export interface DevCommandSurface {
  scripts: Record<string, string>;
  workspaceScripts: Record<string, string> | null;
  workspaceSubpath: string | null;
  customCommand: string | null;
  /** Every other declared workspace's scripts, by folder. */
  workspaces: Record<string, Record<string, string>>;
  /** Config and rc files that run code or change what runs → SHA-256. */
  files: Record<string, string>;
}

export interface DevServerConsent {
  state: DevServerConsentState;
  fingerprint: string;
  surface: DevCommandSurface;
  /** Dependencies were installed without lifecycle scripts; they run on approval. */
  installScriptsPending: boolean;
}

/**
 * Env key that marks a PTY spawn as `root`'s dev server. The PTY layer
 * removes it and refuses the spawn unless that project is approved
 * (`tauri-plugin-pty`, `dev_consent::guard_dev_server_spawn`).
 */
export const DEV_SERVER_ROOT_ENV = '__SHIPSTUDIO_DEV_SERVER_ROOT';

/** How an install runs, decided by the backend from the project's approval. */
export interface InstallPlan {
  args: string[];
  /** Lifecycle scripts run (only once the project is approved). */
  runsScripts: boolean;
}

/** Install with scripts if approved; otherwise without, and they're owed. */
export function planPackageInstall(
  projectPath: string,
  packageManager: string
): Promise<InstallPlan> {
  return invoke<InstallPlan>('plan_package_install', { projectPath, packageManager });
}

/** The scripts a scripts-free install skipped, once approved (else null). */
export function planPendingInstallScripts(
  projectPath: string,
  packageManager: string
): Promise<InstallPlan | null> {
  return invoke<InstallPlan | null>('plan_pending_install_scripts', {
    projectPath,
    packageManager,
  });
}

/** An install with scripts succeeded: nothing is owed any more. */
export function markInstallScriptsRan(projectPath: string): Promise<void> {
  return invoke<void>('mark_install_scripts_ran', { projectPath });
}

export function getDevServerConsent(projectPath: string): Promise<DevServerConsent> {
  return invoke<DevServerConsent>('get_dev_server_consent', { projectPath });
}

/** Approve exactly what the user was shown; fails if it changed since. */
export function approveDevServer(projectPath: string, fingerprint: string): Promise<void> {
  return invoke<void>('approve_dev_server', { projectPath, fingerprint });
}

/** Thrown by `startDevServer` when the command hasn't been approved. */
export class DevServerConsentRequired extends Error {
  constructor(public readonly consent: DevServerConsent) {
    super('This project’s dev command needs your OK before it runs.');
    this.name = 'DevServerConsentRequired';
  }
}

/** Resolve when approved, otherwise throw `DevServerConsentRequired`. */
export async function assertDevServerApproved(projectPath: string): Promise<void> {
  const consent = await getDevServerConsent(projectPath);
  if (consent.state !== 'approved') throw new DevServerConsentRequired(consent);
}

/** A project whose dev server is waiting for the user's OK. */
export interface PendingDevServerConsent {
  consent: DevServerConsent;
  /** Start the dev server the way it would have started (called after approval). */
  resume: () => void | Promise<unknown>;
}

const pending = new Map<string, PendingDevServerConsent>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const devServerConsentStore = {
  set(projectPath: string, entry: PendingDevServerConsent) {
    pending.set(projectPath, entry);
    emit();
  },
  clear(projectPath: string) {
    if (pending.delete(projectPath)) emit();
  },
  get(projectPath: string | null | undefined): PendingDevServerConsent | null {
    return (projectPath && pending.get(projectPath)) || null;
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function usePendingDevServerConsent(
  projectPath: string | null | undefined
): PendingDevServerConsent | null {
  return useSyncExternalStore(devServerConsentStore.subscribe, () =>
    devServerConsentStore.get(projectPath)
  );
}

/** Every command line the user is approving, in the order it'd be read. */
export function consentLines(surface: DevCommandSurface): { label: string; command: string }[] {
  const lines: { label: string; command: string }[] = [];
  if (surface.customCommand) lines.push({ label: 'dev command', command: surface.customCommand });
  for (const [name, command] of Object.entries(surface.scripts)) {
    lines.push({ label: name, command });
  }
  if (surface.workspaceScripts) {
    const prefix = surface.workspaceSubpath ? `${surface.workspaceSubpath} › ` : '';
    for (const [name, command] of Object.entries(surface.workspaceScripts)) {
      lines.push({ label: `${prefix}${name}`, command });
    }
  }
  for (const [dir, scripts] of Object.entries(surface.workspaces ?? {})) {
    for (const [name, command] of Object.entries(scripts)) {
      lines.push({ label: `${dir} › ${name}`, command });
    }
  }
  return lines;
}

/** The config and rc files that are part of what was approved, by path. */
export function consentFiles(surface: DevCommandSurface): string[] {
  return Object.keys(surface.files ?? {});
}
