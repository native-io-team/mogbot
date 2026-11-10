/**
 * What a login card (or a row of "What your team needs") says while a
 * sign-in it opened in this Mac's browser is waiting: "Opened in your
 * browser — didn't see it? Open again · Copy link". If nothing has come back
 * `NO_CALLBACK_MS` after the browser was asked, the line says so plainly,
 * with the same two actions; never a silent spinner. The browser can be
 * opened and still be invisible (another app answering for it), so the link
 * is always one click away.
 *
 * Also: "Not needed", with its one-line receipt and Undo (`useNotNeeded`),
 * and the claude.ai re-check when the window comes back (`useRecheckOnFocus`).
 *
 * @module components/agents/SignInHelp
 */

import { useCallback, useEffect, useState } from 'react';
import { TextButton } from '../primitives/TextButton';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  NO_CALLBACK_MS,
  quietLine,
  quietSignIn,
  recheckLogins,
  reopenLogin,
  undeclineLogins,
  type DeclineReceipt,
  type LoginFlow,
} from '../../lib/agentLogins';

/** True once the sign-in has been quiet for `NO_CALLBACK_MS`; re-renders at that moment. */
export function useQuietSignIn(flow: LoginFlow | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  const openedAt = flow?.openedAt;
  useEffect(() => {
    if (openedAt === undefined) return;
    // Already past it: the timer fires at once, rather than a setState here.
    const wait = Math.max(0, openedAt + NO_CALLBACK_MS - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [openedAt]);
  return quietSignIn(flow, now);
}

/** While something waits on claude.ai, coming back to the window checks it at once. */
export function useRecheckOnFocus(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      if (document.visibilityState === 'visible') void recheckLogins().catch(() => undefined);
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [enabled]);
}

/**
 * Run a "Not needed" and show its receipt, with Undo for the few seconds the
 * toast is up (Settings → Agents and "What it can reach" turn it back on later).
 */
export function useNotNeeded() {
  const { showToast } = useOptionalToast();
  return useCallback(
    async (task: () => Promise<DeclineReceipt>) => {
      const receipt = await task();
      showToast(receipt.line, 'info', {
        label: 'Undo',
        onClick: () =>
          void undeclineLogins(receipt.keys).catch((err) =>
            showToast(formatCommandError(asCommandError(err)), 'error')
          ),
      });
      return receipt;
    },
    [showToast]
  );
}

interface SignInHelpProps {
  /** A card's sign-in: Open again reopens it. */
  agentId?: string;
  requestId?: string;
  /** Anything else's (the apps dialog): how Open again reopens it. */
  reopen?: () => Promise<void>;
  flow: LoginFlow | undefined;
}

export function SignInHelp({ agentId, requestId, reopen, flow }: SignInHelpProps) {
  const quiet = useQuietSignIn(flow);
  const { copy, isCopied } = useCopyToClipboard();
  const [error, setError] = useState<string | null>(null);
  useRecheckOnFocus(flow?.option === 'claude_ai' && flow.state === 'waiting');
  if (!flow || flow.state !== 'waiting' || !flow.url || flow.onPhone) return null;
  const url = flow.url;
  return (
    <p className="agent-login__help" data-quiet={quiet || undefined} role="status">
      <span>{error ?? (quiet ? quietLine(flow) : 'Opened in your browser — didn’t see it?')}</span>{' '}
      <TextButton
        tabIndex={0}
        onClick={() => {
          setError(null);
          const again = reopen ?? (() => reopenLogin(agentId ?? '', requestId ?? ''));
          void again().catch((err) => setError(formatCommandError(asCommandError(err))));
        }}
      >
        Open again
      </TextButton>
      <span aria-hidden> · </span>
      <TextButton tabIndex={0} onClick={() => void copy(url)}>
        {isCopied ? 'Copied' : 'Copy link'}
      </TextButton>
    </p>
  );
}
