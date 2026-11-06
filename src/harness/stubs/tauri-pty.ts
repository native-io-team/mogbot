/**
 * `tauri-pty` talks to a native side that does not exist in a browser. The
 * harness is for looking at UI, not for driving a real agent session, so the
 * terminal renders its chrome and stays inert — visibly empty rather than
 * faking agent output that never happened.
 *
 * One exception, for the states that follow a process dying: a scenario that
 * sets `harness:pty-exit` in `storage` (an exit code) gets PTYs that exit
 * with it shortly after they spawn, the way a dev server that crashes does.
 */
const EXIT_KEY = 'harness:pty-exit';

function exitCode(): number | null {
  try {
    const raw = window.localStorage.getItem(EXIT_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function spawn() {
  const code = exitCode();
  return {
    onData: () => ({ dispose: () => {} }),
    onExit: (handler: (e: { exitCode: number }) => void) => {
      if (code === null) return { dispose: () => {} };
      const timer = setTimeout(() => handler({ exitCode: code }), 300);
      return { dispose: () => clearTimeout(timer) };
    },
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
}
export default { spawn };
