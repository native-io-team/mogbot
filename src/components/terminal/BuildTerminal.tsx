/**
 * BuildTerminal — a thin, interactive terminal that runs a mobile app build
 * (`expo run:ios` / `react-native run-ios` / `flutter run`) inside a backend
 * {@link openPtySession | pty_session}.
 *
 * It is {@link AttachedTerminal} with the build's shell as its opener. Two
 * properties matter:
 *
 * - **Interactive.** Keystrokes are written to the PTY, so a build that prompts
 *   (CocoaPods, `npx` "Ok to proceed?") can actually be answered — the read-only
 *   `<pre>` it replaces could not.
 * - **Backend-owned.** Unmounting (a tab switch) unsubscribes but does NOT kill
 *   the session, so a multi-minute build keeps running and replays its scrollback
 *   on return. Teardown is the backend's job (suspend / close / window-close).
 *
 * @module components/BuildTerminal
 */

import { useCallback } from 'react';
import { openPtySession } from '../../lib/ptySession';
import { AttachedTerminal } from './AttachedTerminal';

interface BuildTerminalProps {
  /** Stable pty_session id — use `buildSessionId(projectPath)` so it matches the
   *  backend and re-open across tab switches is idempotent. */
  sessionId: string;
  /** The launch command to run (from `getSimulatorLaunchCommand`). */
  command: string;
  /** Working directory for the build (the project path). */
  cwd: string;
  /** Focus the terminal when this becomes the active view. */
  isActive?: boolean;
  /** Called when the build process exits (clean = 0, error > 0, -1 = unknown). */
  onExit?: (exitCode: number) => void;
  /** Called with decoded terminal output as it arrives — both the replayed
   *  scrollback on attach and the live stream — so the parent can classify build
   *  progress. Kept generic: this component knows nothing about what the text
   *  means. */
  onOutput?: (text: string) => void;
}

// iOS previews are macOS-only; a login+interactive shell sources the user's
// profile so `npx` / `xcrun` / nvm-managed node resolve exactly as in their
// terminal (PATH parity with how the dev server used to launch the build).
const BUILD_SHELL = '/bin/zsh';

export function BuildTerminal({
  sessionId,
  command,
  cwd,
  isActive,
  onExit,
  onOutput,
}: BuildTerminalProps) {
  // Idempotent: a re-mount (tab switch) finds the build still running.
  const open = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      await openPtySession({
        sessionId,
        command: BUILD_SHELL,
        args: ['-lic', command],
        cwd,
        env: {},
        cols,
        rows,
        projectPath: cwd,
      });
    },
    [sessionId, command, cwd]
  );
  return (
    <AttachedTerminal
      // A different build is a different session: set it up again.
      key={`${sessionId}\n${command}\n${cwd}`}
      sessionId={sessionId}
      open={open}
      variant="build"
      isActive={isActive}
      onExit={onExit}
      onOutput={onOutput}
      failureLabel="Failed to start build"
      className="build-terminal"
    />
  );
}
