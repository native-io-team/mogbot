/**
 * Runs onboarding's installs and sign-ins (getting one engine installed and
 * signed in) and keeps what the screen needs to show them as a native
 * installer would: the run's real output, the step it has reached
 * (`lib/installProgress`), what it's waiting on, and, when it fails, what
 * went wrong with the one fix.
 *
 * A clean exit is a claim, not proof: "Checking it works" is the app's own
 * status check, and only that marks an item done.
 *
 * Three ways a run happens:
 * - `pty`: the real command in a terminal (`OnboardingTerminal`), which the
 *   screen keeps folded under "Show details"
 * - `quiet`: Node.js through Homebrew in the background (`install_brew_packages`),
 *   which prints nothing until it's done
 * - `mock`: under `SHIPSTUDIO_FORCE_SETUP`, a scripted run (`mockScript`)
 *   through the same parsing, then the backend's mock state; nothing touches
 *   the Mac. `SHIPSTUDIO_FORCE_INSTALL_FAILURE` makes the first run of each
 *   item that can fail that way fail once.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  SetupItem,
  FullSetupStatus,
  TERMINAL_COMMANDS,
  USES_TERMINAL,
  checkClaudeAuthStatus,
  getFullSetupStatus,
  installPackages,
  isSetupItemReady,
  PKG_MGR_PACKAGES,
  recheckWithDelays,
} from '../../../lib/setup';
import { mockMarkSetupItemReady } from '../../../lib/agentOnboarding';
import { trackEvent } from '../../../lib/analytics';
import { withTimeout } from '../../../lib/withTimeout';
import { extractTerminalError } from '../../../lib/terminalDiagnostics';
import { asCommandError, formatCommandError } from '../../../lib/errors';
import {
  describeFailure,
  isAuthItem,
  laterPhase,
  mockScript,
  phaseFromOutput,
  type InstallFailure,
  type InstallPhase,
  type MockFailure,
} from '../../../lib/installProgress';
import { usePolling } from '../../../hooks/usePolling';
import { logger } from '../../../lib/logger';

const SETUP_STATUS_TIMEOUT_MS = 15_000;
/** How much of a run's output is kept: enough for an installer's failure. */
const OUTPUT_MAX_CHARS = 16_384;
/** How often a sign-in asks the app's own check whether it's done. */
const SIGN_IN_POLL_MS = 3000;

export interface InstallRun {
  itemId: string;
  source: 'pty' | 'mock' | 'quiet';
  /** Everything it has printed (bounded), raw. */
  output: string;
  /** The furthest step it has reached; never goes back. */
  phase: InstallPhase;
  /** When it last printed, so a quiet prompt can be told from a busy one. */
  lastOutputAt: number;
  /** What the app knew about the item before this run, restored on Cancel. */
  before: SetupItem['status'];
}

/** The real command a `pty` run is running. */
export interface InstallTerminal {
  /** A new key per run, so Try again is a fresh process. */
  key: number;
  command: string;
  args: string[];
  onExit: (exitCode: number | null, outputTail: string) => void;
  onOutput: (text: string) => void;
  inputRef: MutableRefObject<((data: string) => void) | null>;
}

interface Params {
  /** Re-fetch setup status into the owner's `items` state. */
  fetchStatus: () => Promise<FullSetupStatus | null>;
  /** Patch a single item's status in the owner's `items` state. */
  updateItemStatus: (itemId: string, updates: Partial<SetupItem>) => void;
  /** Mock mode: scripted runs and the backend's mock state, no real processes. */
  mock: boolean;
  /** Mock mode: fail the first run of each item that can fail this way. */
  mockFailure?: MockFailure | null;
}

const bound = (s: string) => (s.length > OUTPUT_MAX_CHARS ? s.slice(-OUTPUT_MAX_CHARS) : s);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useAgentSetupActions({
  fetchStatus,
  updateItemStatus,
  mock,
  mockFailure = null,
}: Params) {
  const [run, setRun] = useState<InstallRun | null>(null);
  const [terminal, setTerminal] = useState<{
    key: number;
    itemId: string;
    command: string;
    args: string[];
  } | null>(null);
  /** The last run's output per item, for "Show details" after it ends. */
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  /** What went wrong, per item, from everything the run printed. */
  const [failures, setFailures] = useState<Record<string, InstallFailure>>({});

  // Every run gets a token; anything arriving for an older one (a killed
  // PTY's exit, a mock line after Cancel) is ignored.
  const token = useRef(0);
  // The run as handlers see it: set at once when one starts or ends, and
  // kept in step with each output after render.
  const runRef = useRef<InstallRun | null>(null);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const endRun = useCallback(() => {
    runRef.current = null;
    setRun(null);
  }, []);
  const ptyInput = useRef<((data: string) => void) | null>(null);
  const mockAnswer = useRef<(() => void) | null>(null);
  const mockFailedOnce = useRef(new Set<string>());

  // Staggered re-checks (600/1500/3000ms) outlive fast unmounts — their
  // continuations must not dispatch state into an unmounted tree.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      token.current += 1;
    };
  }, []);
  const live = (t: number) => mountedRef.current && t === token.current;

  const append = useCallback((text: string) => {
    if (!text) return;
    setRun((prev) => {
      if (!prev) return prev;
      const output = bound(prev.output + text);
      return {
        ...prev,
        output,
        phase: laterPhase(prev.phase, phaseFromOutput(prev.itemId, output)),
        lastOutputAt: Date.now(),
      };
    });
  }, []);

  /** The run ended: the app checks for itself, or says what went wrong. */
  const finish = useCallback(
    async (itemId: string, t: number, exitCode: number | null, tail: string) => {
      if (!live(t)) return;
      setTerminal(null);
      setOutputs((prev) => ({ ...prev, [itemId]: tail }));

      if (exitCode === 0 || exitCode === null) {
        setRun((prev) => (prev ? { ...prev, phase: 'check' } : prev));
        let verified: boolean;
        if (mock) {
          try {
            await mockMarkSetupItemReady(itemId);
          } catch (err) {
            logger.warn('Mock setup action failed', { itemId, error: String(err) });
          }
          if (!live(t)) return;
          const status = await fetchStatus();
          verified = !!status && isSetupItemReady(status.items, itemId);
        } else if (itemId === 'claude_auth') {
          verified = await recheckWithDelays(() => checkClaudeAuthStatus());
        } else {
          verified = await recheckWithDelays(async () => {
            try {
              const status = await withTimeout(
                getFullSetupStatus(),
                SETUP_STATUS_TIMEOUT_MS,
                'Setup status check'
              );
              return isSetupItemReady(status.items, itemId);
            } catch {
              return false;
            }
          });
        }
        if (!live(t)) return;
        if (!mock) await fetchStatus();
        if (!live(t)) return;
        if (!verified) {
          const failure = describeFailure(itemId, tail, { exitedClean: true });
          void trackEvent('setup_action_failed', {
            item_id: itemId,
            exit_code: exitCode,
            error_excerpt: 'clean_exit_but_not_detected',
          });
          setFailures((prev) => ({ ...prev, [itemId]: failure }));
          updateItemStatus(itemId, { status: 'error', errorMessage: failure.line });
        }
      } else {
        const failure = describeFailure(itemId, tail);
        void trackEvent('setup_action_failed', {
          item_id: itemId,
          exit_code: exitCode,
          error_excerpt: extractTerminalError(tail) ?? undefined,
          failure_kind: failure.kind,
        });
        setFailures((prev) => ({ ...prev, [itemId]: failure }));
        updateItemStatus(itemId, { status: 'error', errorMessage: failure.line });
      }
      endRun();
    },
    [mock, fetchStatus, updateItemStatus, endRun]
  );

  const playMock = useCallback(
    async (itemId: string, t: number) => {
      const failing =
        mockFailure &&
        !mockFailedOnce.current.has(itemId) &&
        mockScript(itemId, mockFailure).exitCode !== 0;
      if (failing) mockFailedOnce.current.add(itemId);
      const script = mockScript(itemId, failing ? mockFailure : null);
      let tail = '';
      for (const line of script.lines) {
        await wait(line.after);
        if (!live(t)) return;
        if (!line.text) continue;
        const text = line.waitsForInput ? line.text : `${line.text}\r\n`;
        tail += text;
        append(text);
        if (line.waitsForInput) {
          await new Promise<void>((resolve) => {
            mockAnswer.current = resolve;
          });
          mockAnswer.current = null;
          if (!live(t)) return;
          tail += '\r\n';
          append('\r\n');
        }
      }
      await finish(itemId, t, script.exitCode, tail);
    },
    [mockFailure, append, finish]
  );

  const handleItemAction = useCallback(
    async (itemId: string, before: SetupItem['status'] = 'not_installed') => {
      if (runRef.current) return;
      const t = ++token.current;
      void trackEvent('setup_action_clicked', {
        item_id: itemId,
        action: isAuthItem(itemId) ? 'connect' : 'install',
        step_id: 'agent_led_pick',
      });

      const source: InstallRun['source'] = mock
        ? 'mock'
        : PKG_MGR_PACKAGES.has(itemId)
          ? 'quiet'
          : 'pty';
      const started: InstallRun = {
        itemId,
        source,
        output: '',
        phase: phaseFromOutput(itemId, ''),
        lastOutputAt: Date.now(),
        // An error was the last run's, not what's on the Mac.
        before: before === 'error' || before === 'in_progress' ? 'not_installed' : before,
      };
      runRef.current = started;
      setRun(started);
      setFailures((prev) => {
        if (!(itemId in prev)) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
      updateItemStatus(itemId, { status: 'in_progress', errorMessage: undefined });

      if (mock) {
        await playMock(itemId, t);
        return;
      }

      // Auth items: re-check first — the user may have completed auth in a
      // previously cancelled run without the screen updating. Only skip the
      // sign-in when the CHECKLIST source agrees the item is ready; if the
      // quick probe and the checklist disagree, run the CLI's own flow, the
      // tiebreaker the user can actually see. (A probe-only early return
      // here deadlocks the button — the #159 failure shape.)
      if (itemId === 'claude_auth' && (await checkClaudeAuthStatus())) {
        if (!live(t)) return;
        const status = await fetchStatus();
        if (!live(t)) return;
        if (status && isSetupItemReady(status.items, itemId)) {
          endRun();
          return;
        }
      }

      // Node.js (Codex's prerequisite) installs through the package manager
      // with no terminal; its answer, if it fails, is the whole output.
      if (source === 'quiet') {
        let error = '';
        try {
          await installPackages([itemId]);
        } catch (err) {
          error = formatCommandError(asCommandError(err));
          logger.warn('Package install failed', { itemId, error });
        }
        if (!live(t)) return;
        append(error);
        await finish(itemId, t, error ? 1 : 0, error);
        return;
      }

      const cmd = USES_TERMINAL.has(itemId) ? TERMINAL_COMMANDS[itemId] : undefined;
      if (cmd) {
        setTerminal({ key: t, itemId, command: cmd.command, args: cmd.args });
        return;
      }
      logger.warn('Onboarding asked to run an item it has no command for', { itemId });
      endRun();
    },
    [mock, playMock, append, finish, fetchStatus, updateItemStatus, endRun]
  );

  /** Stop the run: the process is killed, and the screen says it was closed. */
  const cancel = useCallback(() => {
    const current = runRef.current;
    token.current += 1;
    mockAnswer.current?.();
    setTerminal(null);
    endRun();
    if (!current) return;
    const { itemId } = current;
    setOutputs((prev) => ({ ...prev, [itemId]: current.output }));
    // Back to what the app knew before the run, until the check below says otherwise.
    updateItemStatus(itemId, { status: current.before });
    void fetchStatus();
    // Auth flows may still be writing the token when the user cancels
    // (e.g. after the OAuth browser callback) — re-check once more.
    if (isAuthItem(itemId)) {
      setTimeout(() => {
        if (mountedRef.current) void fetchStatus();
      }, 2000);
    }
  }, [fetchStatus, updateItemStatus, endRun]);

  /** Answer what the run is waiting on (a password, Return, a code). */
  const answer = useCallback((data: string) => {
    if (runRef.current?.source === 'pty') {
      ptyInput.current?.(data);
    } else if (runRef.current?.source === 'mock') {
      mockAnswer.current?.();
    }
  }, []);

  /** Forget a failure (Try again by way of a prerequisite). */
  const clearFailure = useCallback((itemId: string) => {
    setFailures((prev) => {
      if (!(itemId in prev)) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  // A sign-in finishes in the browser. The command usually exits then, but
  // the app's own check decides: once it says signed in, the run is done.
  const signingIn = run?.source === 'pty' && isAuthItem(run.itemId) && run.phase !== 'check';
  usePolling(
    async () => {
      const current = runRef.current;
      if (!current || !isAuthItem(current.itemId)) return;
      const t = token.current;
      const status = await withTimeout(
        getFullSetupStatus(),
        SETUP_STATUS_TIMEOUT_MS,
        'Setup status check'
      );
      if (!live(t) || !isSetupItemReady(status.items, current.itemId)) return;
      token.current += 1;
      setTerminal(null);
      setRun((prev) => (prev ? { ...prev, phase: 'check' } : prev));
      await fetchStatus();
      if (mountedRef.current) endRun();
    },
    {
      intervalMs: SIGN_IN_POLL_MS,
      enabled: signingIn,
      whileHidden: true,
      name: 'onboarding-sign-in',
    }
  );

  const t = terminal?.key ?? 0;
  const itemId = terminal?.itemId ?? '';
  const onExit = useCallback(
    (exitCode: number | null, tail: string) => void finish(itemId, t, exitCode, tail),
    [finish, itemId, t]
  );
  const ptyTerminal: InstallTerminal | null = terminal && {
    key: terminal.key,
    command: terminal.command,
    args: terminal.args,
    onExit,
    onOutput: append,
    inputRef: ptyInput,
  };

  return {
    run,
    busy: run !== null,
    terminal: ptyTerminal,
    outputs,
    failures,
    handleItemAction,
    cancel,
    answer,
    clearFailure,
  };
}
