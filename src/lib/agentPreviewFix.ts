/**
 * A preview that stopped by itself, handed back to the agent that owns it
 * (`src-tauri/src/agents/preview_fix.rs`).
 *
 * The window reports each exit (`lib/devServerExits.ts`) with the agent
 * whose pane shows that folder; the backend tells that agent, wakes it at
 * most once per folder per ten minutes, and gives up to the user after two
 * fixes that didn't hold. The pane shows the agent on it, or offers to ask.
 *
 * @module lib/agentPreviewFix
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const EVENT_PREVIEW_FIX = 'agents://preview-fix';

/** `preview_fix::View`. */
export interface PreviewFix {
  path: string;
  agentId: string;
  agentName: string;
  phase: 'fixing' | 'ask' | 'gave-up';
  /** Why it stopped, in a few words. */
  reason: string;
  at: number;
}

// ------------------------------------------------------- open panes

const openPanes = new Map<string, string>();

/** A pane beside `agentId`'s chat shows `path`, until the returned call. */
export function registerPreviewPane(path: string, agentId: string): () => void {
  openPanes.set(path, agentId);
  return () => {
    if (openPanes.get(path) === agentId) openPanes.delete(path);
  };
}

/** The agent whose pane in this window shows `path`, if one does. */
export function paneAgentFor(path: string): string | null {
  return openPanes.get(path) ?? null;
}

// ------------------------------------------------------- backend

export function reportDevServerExited(
  path: string,
  exitCode: number | null,
  output: string,
  paneAgent: string | null
): Promise<PreviewFix | null> {
  return invoke<PreviewFix | null>('agents_dev_server_exited', {
    path,
    exitCode,
    output,
    paneAgent,
  });
}

export function previewFixState(path: string): Promise<PreviewFix | null> {
  return invoke<PreviewFix | null>('agents_preview_fix_state', { path });
}

export function askToFixPreview(agentId: string, path: string): Promise<PreviewFix> {
  return invoke<PreviewFix>('agents_preview_fix_ask', { agentId, path });
}

export function onPreviewFix(handler: (fix: PreviewFix) => void): Promise<() => void> {
  return listen<PreviewFix>(EVENT_PREVIEW_FIX, (event) => handler(event.payload));
}

export function setFixPreviews(enabled: boolean): Promise<void> {
  return invoke('set_agents_fix_previews', { enabled });
}

// ------------------------------------------------------- what the pane shows

/** A woken agent that hasn't started yet still counts as on it this long. */
export const FIX_GRACE_MS = 15_000;
/** How long a stopped pane waits to hear whether an agent owns it. */
export const OWNER_WAIT_MS = 2_000;

export type StoppedView =
  /** Nobody owns it, or nobody has said: the workspace line. */
  | { kind: 'workspace' }
  /** Just stopped; who owns it isn't known yet. */
  | { kind: 'waiting' }
  | { kind: 'fixing'; agentName: string; reason: string }
  | { kind: 'ask'; agentId: string; agentName: string; reason: string }
  | { kind: 'gave-up'; agentId: string; agentName: string; reason: string };

/**
 * What a stopped preview shows. "Fixing" only while the owner's turn runs
 * (or for a short grace while the woken turn starts); a fix that ended with
 * the site still down offers to ask again.
 */
export function stoppedView(input: {
  fix: PreviewFix | null;
  /** The owner's turn is running. */
  ownerWorking: boolean;
  /** When this pane saw it stop. */
  stoppedAt: number;
  now: number;
}): StoppedView {
  const { fix, now } = input;
  if (!fix) {
    return now - input.stoppedAt < OWNER_WAIT_MS ? { kind: 'waiting' } : { kind: 'workspace' };
  }
  const who = { agentId: fix.agentId, agentName: fix.agentName, reason: fix.reason };
  if (fix.phase === 'gave-up') return { kind: 'gave-up', ...who };
  if (fix.phase === 'fixing' && (input.ownerWorking || now - fix.at < FIX_GRACE_MS)) {
    return { kind: 'fixing', agentName: fix.agentName, reason: fix.reason };
  }
  return { kind: 'ask', ...who };
}
