/**
 * Dev servers that stopped by themselves, as this window's dev-server owner
 * (`useDevServer`'s exit watcher) sees them: a crash, a compile error, a port
 * in use, an outside `kill`. Never a stop the app asked for.
 *
 * `useAgentDevServerControl` hands each to the backend, which gives it to the
 * agent that owns the preview (`agents/preview_fix.rs`).
 *
 * @module lib/devServerExits
 */

export interface DevServerExit {
  projectPath: string;
  exitCode: number | null;
  /** The end of what it printed. */
  output: string;
}

type Listener = (exit: DevServerExit) => void;

const listeners = new Set<Listener>();

export function onDevServerExit(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportDevServerExit(exit: DevServerExit): void {
  for (const listener of listeners) {
    try {
      listener(exit);
    } catch {
      /* a listener's failure is its own */
    }
  }
}
