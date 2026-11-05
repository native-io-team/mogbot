/**
 * Preview and "Test it" from a chat card (`src-tauri/src/agents/preview_test.rs`).
 *
 * Preview on a result or copy card opens a pane beside the chat with the
 * card's project running in it: the agent's copy when the card is a live
 * copy's, otherwise the project. Which folder that is, the backend decides
 * from the card as the log has it; the pane never names a path itself.
 *
 * The pane is a preview like the workspace's: the same proxy, the same
 * injected inspector, the same bridge tools. While it is open the backend
 * routes that folder's preview tools to it (`agents_preview_attach`), which
 * is how "Test it" drives it while the user watches.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TestOutcome, TestStep } from '../../packages/companion-protocol/src/results';
import { isMobileProjectType, type ProjectType } from './static-server';

export type { TestStep } from '../../packages/companion-protocol/src/results';

/** `preview_test::PreviewTarget`. */
export interface PreviewTarget {
  agentId: string;
  messageId: string;
  /** The folder whose dev server the pane shows: the copy, or the project. */
  path: string;
  /** The user's own project it belongs to. */
  project: string;
  /** `path` is the agent's open copy of `project`. */
  copy: boolean;
  /** A server already up for it in this app, else the port saved for it. */
  port?: number;
  /** A preview proxy already serves the folder. */
  running: boolean;
  title?: string;
}

export type RunState = 'running' | 'reported' | 'stopped';

/** `preview_test::Run`. */
export interface PreviewRun {
  id: string;
  agentId: string;
  messageId: string;
  path: string;
  project: string;
  copy: boolean;
  title?: string | null;
  startedAt: number;
  state: RunState;
  steps: TestStep[];
  outcome?: TestOutcome;
}

/** What the pane needs from the window's dev servers (App's `useDevServer`). */
export interface AgentPreviewServer {
  /** The server for a folder as this window tracks it. */
  status: (path: string) => {
    status: 'not-running' | 'starting' | 'ready' | 'stopped';
    address: string | null;
  };
  /** Start it (install and consent gates included); resolves with its type. */
  start: (path: string, name: string, port: number) => Promise<ProjectType>;
  /** Set when dependencies aren't installed, so nothing was started. */
  needsInstall: (path: string) => { packageManager: string } | null;
  projectType: (path: string) => ProjectType;
  /** Bumps whenever any of the above may have changed. */
  version: number;
}

export const EVENT_PREVIEW_TEST = 'agents://preview-test';

export function previewTarget(agentId: string, messageId: string): Promise<PreviewTarget> {
  return invoke<PreviewTarget>('agents_preview_target', { agentId, messageId });
}

/** The pane is (or stops being) live for `path` in this window. */
export function attachPreviewPane(path: string, attached: boolean): Promise<void> {
  return invoke('agents_preview_attach', { path, attached });
}

export function startPreviewTest(agentId: string, messageId: string): Promise<PreviewRun> {
  return invoke<PreviewRun>('agents_preview_test_start', { agentId, messageId });
}

export function previewTestState(agentId: string): Promise<PreviewRun | null> {
  return invoke<PreviewRun | null>('agents_preview_test_state', { agentId });
}

export function stopPreviewTest(agentId: string): Promise<boolean> {
  return invoke<boolean>('agents_preview_test_stop', { agentId });
}

export function onPreviewTest(handler: (run: PreviewRun) => void): Promise<() => void> {
  return listen<PreviewRun>(EVENT_PREVIEW_TEST, (event) => handler(event.payload));
}

/** The port in a `localhost:<port>` address, or null. */
export function portOf(address: string | null): number | null {
  const m = address?.match(/:(\d{1,5})$/);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** What the pane shows, in the order the honesty rules want it. */
export type PaneState =
  | { kind: 'resolving' }
  | { kind: 'failed'; message: string }
  | { kind: 'consent' }
  | { kind: 'install'; packageManager: string }
  | { kind: 'no-preview' }
  | { kind: 'starting' }
  | { kind: 'stopped' }
  | { kind: 'ready'; port: number };

/**
 * Fold what is known into one state. A failure to resolve beats everything;
 * a server waiting for the user's OK, or for dependencies, is said as such
 * rather than as "starting"; a project with no web preview says so; only a
 * server that answered is ready.
 */
export function paneState(input: {
  error: string | null;
  target: PreviewTarget | null;
  consentPending: boolean;
  needsInstall: { packageManager: string } | null;
  projectType: ProjectType | null;
  server: { status: string; address: string | null } | null;
  /** Port the pane chose to show (a server already up elsewhere, or reserved). */
  port: number | null;
  /** The start call returned: a server still not running means none will. */
  startSettled: boolean;
}): PaneState {
  if (input.error) return { kind: 'failed', message: input.error };
  if (!input.target) return { kind: 'resolving' };
  if (input.consentPending) return { kind: 'consent' };
  if (input.needsInstall)
    return { kind: 'install', packageManager: input.needsInstall.packageManager };
  if (input.projectType && isMobileProjectType(input.projectType)) return { kind: 'no-preview' };
  if (input.server?.status === 'stopped') return { kind: 'stopped' };
  const port = portOf(input.server?.address ?? null) ?? input.port;
  if (input.server?.status === 'ready' && port) return { kind: 'ready', port };
  // Served by another window's workspace: nothing to start here.
  if (input.target.running && input.port) return { kind: 'ready', port: input.port };
  // Started, and nothing runs (a folder with no dev command).
  if (input.startSettled && (input.server?.status ?? 'not-running') === 'not-running') {
    return { kind: 'no-preview' };
  }
  return { kind: 'starting' };
}

/** The steps beside the frame, newest last; a reported run says its outcome. */
export function runLine(run: PreviewRun | null): string | null {
  if (!run) return null;
  if (run.state === 'running') {
    return run.steps.length === 0 ? 'Starting the test…' : 'Testing…';
  }
  if (run.state === 'reported') {
    return run.outcome === 'broken' ? 'Found something broken' : 'It works';
  }
  return 'The test stopped';
}

/** Pages the pane went to, for its Back button: no repeats in a row, capped. */
export function pushLocation(history: string[], location: string, max = 30): string[] {
  if (history[history.length - 1] === location) return history;
  return [...history, location].slice(-max);
}
