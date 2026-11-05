/**
 * AttachedTerminal — a thin, interactive xterm on a backend
 * {@link openPtySession | pty_session}: subscribe, attach (replay the
 * scrollback), write keystrokes, keep the size in sync.
 *
 * It is the minimal subset of {@link Terminal} for a process something else
 * owns. It has none of Terminal's agent spawning, resume or status logic,
 * so it never starts a process of its own unless its caller hands it `open`:
 *
 * - **A mobile build** (`BuildTerminal`) opens its shell itself, idempotently.
 * - **An agent's take-over** is spawned by the backend, with arguments the
 *   webview never sees; this only attaches to it.
 *
 * Unmounting unsubscribes but never kills the session: its owner decides
 * when it ends.
 *
 * @module components/terminal/AttachedTerminal
 */

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { attachWebglRenderer } from '../../lib/terminalWebgl';
import { createWebLinksAddon } from '../../lib/terminalLinks';
import {
  attachPtySession,
  writePtySessionLogged,
  resizePtySessionLogged,
  detachPtySession,
  onPtySessionData,
  onPtySessionExit,
  createAttachGate,
  setPtySessionPaused,
} from '../../lib/ptySession';
import { createTerminalFlowControl } from '../../lib/terminalFlowControl';
import { getTerminalGpuEnabled } from '../../lib/settings';
import { loadNerdFonts } from '../../lib/fonts';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { createTerminalOptions, followAppTheme, type TerminalThemeVariant } from './terminalTheme';
import '@xterm/xterm/css/xterm.css';

export interface AttachedTerminalProps {
  /** The backend pty_session to show. */
  sessionId: string;
  /** Start the session if it isn't running (idempotent), given the terminal's
   *  size. Omitted: attach only, to a session something else started. */
  open?: (size: { cols: number; rows: number }) => Promise<void>;
  /** The palette (`terminalTheme`). */
  variant?: TerminalThemeVariant;
  /** Focus the terminal when this becomes the active view. */
  isActive?: boolean;
  /** The process exited (clean = 0, error > 0, -1 = unknown). */
  onExit?: (exitCode: number) => void;
  /** Decoded output as it arrives, the replayed scrollback included. */
  onOutput?: (text: string) => void;
  /** What failing to open or attach says, before the reason. */
  failureLabel?: string;
  className?: string;
}

export function AttachedTerminal({
  sessionId,
  open,
  variant = 'normal',
  isActive,
  onExit,
  onOutput,
  failureLabel = 'Couldn’t open the terminal',
  className,
}: AttachedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  // Callbacks in refs, so their identity churn never re-runs the setup
  // (which would re-attach the session).
  const onExitRef = useRef(onExit);
  const onOutputRef = useRef(onOutput);
  const openRef = useRef(open);
  const labelRef = useRef(failureLabel);
  useEffect(() => {
    onExitRef.current = onExit;
    onOutputRef.current = onOutput;
    openRef.current = open;
    labelRef.current = failureLabel;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    // Set once the session is known to exist — resize calls before that hit
    // the backend's "unknown session" guard (issue #261).
    let sessionReady = false;
    const disposers: Array<() => void> = [];

    const term = new XTerm({
      ...createTerminalOptions(variant),
      allowProposedApi: true,
    });
    followAppTheme(term, variant);
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.loadAddon(createWebLinksAddon());
    term.unicode.activeVersion = '11';
    term.open(container);
    termRef.current = term;

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container detached mid-teardown */
      }
    };

    void loadNerdFonts().then(() => {
      if (!cancelled) safeFit();
    });

    // GPU renderer, gated by the same setting Terminal honours; kept loaded
    // only while the pane has layout (issue #383).
    void (async () => {
      if (cancelled) return;
      const gpuEnabled = await getTerminalGpuEnabled();
      if (cancelled || !gpuEnabled) return;
      disposers.push(attachWebglRenderer(term, container));
    })();

    setTimeout(() => {
      if (!cancelled) safeFit();
    }, 0);

    // Stream-decode for onOutput, keeping multi-byte characters whole.
    const decoder = new TextDecoder();
    const emitOutput = (bytes: Uint8Array) => {
      const cb = onOutputRef.current;
      if (cb) cb(decoder.decode(bytes, { stream: true }));
    };

    const inputDisposable = term.onData((data) => {
      writePtySessionLogged(sessionId, data);
    });
    disposers.push(() => inputDisposable.dispose());

    // Open (if asked) → subscribe → attach (replay, then flush the gate).
    // Subscribing BEFORE attaching matters: Tauri drops events with no
    // listener, so attach-then-subscribe could lose a chunk (issue #156).
    void (async () => {
      try {
        const opener = openRef.current;
        if (opener) {
          await opener({ cols: Math.max(term.cols, 2), rows: Math.max(term.rows, 2) });
        }
        sessionReady = true;
        if (cancelled) return;
        resizePtySessionLogged(sessionId, Math.max(term.cols, 2), Math.max(term.rows, 2));

        // Paced against xterm's parse rate (issue #910).
        const flow = createTerminalFlowControl(term, {
          onPause: () => setPtySessionPaused(sessionId, true),
          onResume: () => setPtySessionPaused(sessionId, false),
        });
        disposers.push(() => flow.dispose());

        const gate = createAttachGate((bytes) => {
          flow.write(bytes);
          emitOutput(bytes);
        });
        const unlistenData = await onPtySessionData(sessionId, (bytes, offset) => {
          if (cancelled) return;
          gate.push(offset, bytes);
        });
        disposers.push(() => void unlistenData());

        // Exit waits for the replay, so the scrollback comes first.
        let gateOpen = false;
        let pendingExit: number | null = null;
        let exitEventSeen = false;
        const unlistenExit = await onPtySessionExit(sessionId, (exitCode) => {
          if (cancelled) return;
          exitEventSeen = true;
          if (!gateOpen) {
            pendingExit = exitCode;
            return;
          }
          onExitRef.current?.(exitCode);
        });
        disposers.push(() => void unlistenExit());

        const attach = await attachPtySession(sessionId);
        if (cancelled) return;
        if (attach.buffer.length > 0) {
          flow.write(attach.buffer);
          emitOutput(attach.buffer);
        }
        gateOpen = true;
        gate.open(attach.endOffset);
        if (pendingExit !== null) {
          onExitRef.current?.(pendingExit);
        } else if (!attach.alive && attach.exitCode !== null && !exitEventSeen) {
          onExitRef.current?.(attach.exitCode);
        }
      } catch (err) {
        if (!cancelled) {
          const reason = formatCommandError(asCommandError(err));
          logger.error('[AttachedTerminal] failed to open or attach', { sessionId, error: reason });
          term.write(`\r\n\x1b[31m${labelRef.current}: ${reason}\x1b[0m\r\n`);
        }
      }
    })();

    // An unguarded resize can beat the session into the registry (#261).
    const resizeObserver = new ResizeObserver(() => {
      if (cancelled) return;
      safeFit();
      if (sessionReady) resizePtySessionLogged(sessionId, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      void detachPtySession(sessionId);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* best-effort */
        }
      }
      term.dispose();
      termRef.current = null;
      // Never kills the session: its owner ends it.
    };
  }, [sessionId, variant]);

  useEffect(() => {
    if (isActive) termRef.current?.focus();
  }, [isActive]);

  return <div ref={containerRef} className={className} />;
}
