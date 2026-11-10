/**
 * Signs a usage account in, into its own folder, with its engine's own
 * sign-in running in a terminal the backend owns:
 *
 * - Claude Code: `claude setup-token` (`ClaudeConnectTerminal`). The token
 *   it prints is captured and kept in the Keychain by Rust, and never
 *   reaches this view.
 * - Codex: `codex login` under the account's own `CODEX_HOME`
 *   (`WorkspaceConnectTerminal`); it finishes when the CLI exits 0.
 *
 * The trap it guards against: the browser signs in as whoever is already
 * logged in to claude.ai (or chatgpt.com), so "adding" an account often
 * adds the same one again. Before the terminal opens it says so
 * (`browserWarning`); the moment the sign-in returns it reads the account
 * once (`checkNewAccount`) and, when it is one already in the list, says so
 * right away with "Try again with a different account" or "Remove it",
 * rather than leaving a duplicate to be found later in Usage.
 *
 * This Mac's own sign-in isn't signed in here: it's the engine's own
 * login, which the engine's sign-in terminal elsewhere handles.
 *
 * @module components/agents/AccountSignIn
 */

import { useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { TextField } from '../primitives/TextField';
import { ClaudeConnectTerminal, WorkspaceConnectTerminal } from '../terminal/lazyTerminals';
import { ENGINE_LABEL } from '../../lib/agents';
import type { UsageAccount } from '../../lib/agentAccounts';
import {
  TRY_AGAIN_DIFFERENT,
  addedSameAccount,
  browserSteps,
  browserWarning,
  checkNewAccount,
} from '../../lib/agentsUsage';

type Phase = 'before' | 'terminal' | 'checking' | 'same';

export function AccountSignIn({
  account,
  nameOf,
  onRemove,
  onDone,
}: {
  account: UsageAccount;
  /** An account's name as its key in Usage shows it, by id. */
  nameOf?: (id: string) => string | undefined;
  /** Remove this account (it turned out to be one already here). */
  onRemove?: () => void;
  onDone: () => void;
}) {
  const label = ENGINE_LABEL[account.engine];
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<Phase>('before');
  const [email, setEmail] = useState(account.email ?? '');
  const [twin, setTwin] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const done = useRef(false);

  const restart = () => {
    done.current = false;
    setExited(false);
    setTwin(null);
    setSessionId(crypto.randomUUID());
    setPhase('before');
  };

  // Signed in: read it once, and say at once if it's an account already here.
  const finished = async () => {
    done.current = true;
    setPhase('checking');
    try {
      const { sameAs } = await checkNewAccount(account.engine, account.id);
      if (sameAs) {
        setTwin(nameOf?.(sameAs) ?? sameAs);
        setPhase('same');
        return;
      }
    } catch {
      // Not read this time: Usage says so once it is.
    }
    onDone();
  };

  if (account.thisMac) {
    return (
      <ModalFrame isOpen onClose={onDone} title={`Sign in to ${label}`}>
        <p className="connect-modal-instructions">
          This is {label}’s own sign-in on this Mac. Sign in from the engine’s row in Agents, or add
          another account here.
        </p>
        <div className="connect-modal-actions">
          <Button variant="secondary" onClick={onDone}>
            Close
          </Button>
        </div>
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      isOpen
      onClose={onDone}
      title={`Sign in “${account.name}” to ${label}`}
      className={phase === 'terminal' ? 'agents-panel-terminal-modal' : undefined}
    >
      {phase === 'before' ? (
        <div className="connect-modal-email-phase">
          <p className="connect-modal-instructions" data-testid="account-signin-warning">
            {browserWarning(account.engine)}
          </p>
          <ol className="connect-modal-steps">
            {browserSteps(account.engine).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {account.engine === 'claude' && (
            <label className="connect-modal-field">
              <span>
                Account email <span className="connect-modal-muted">(shown in Usage)</span>
              </span>
              <TextField
                type="email"
                value={email}
                placeholder="you@example.com"
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setPhase('terminal');
                }}
              />
            </label>
          )}
          <div className="connect-modal-actions">
            <Button variant="secondary" onClick={onDone}>
              Later
            </Button>
            <Button variant="strong" onClick={() => setPhase('terminal')}>
              Continue
            </Button>
          </div>
        </div>
      ) : phase === 'checking' ? (
        <div className="connect-modal-email-phase">
          <p className="connect-modal-instructions">
            <Spinner size="sm" /> Checking which account this is…
          </p>
        </div>
      ) : phase === 'same' ? (
        <div className="connect-modal-email-phase" data-testid="account-signin-same">
          <p className="connect-modal-instructions">
            {addedSameAccount(account.engine, twin ?? 'another account here')}
          </p>
          <div className="connect-modal-actions">
            {onRemove && (
              <Button variant="ghost" onClick={onRemove}>
                Remove it
              </Button>
            )}
            <Button variant="strong" onClick={restart}>
              {TRY_AGAIN_DIFFERENT}
            </Button>
          </div>
        </div>
      ) : (
        <div className="connect-modal-terminal-phase">
          <p className="connect-modal-instructions">
            {account.engine === 'claude'
              ? 'Sign in in the browser, then paste the code it shows into the terminal below and press Enter.'
              : 'A browser window opens: sign in to ChatGPT there. This finishes on its own.'}
          </p>
          <div className="agents-panel-terminal-body">
            {account.engine === 'claude' ? (
              <ClaudeConnectTerminal
                key={sessionId}
                sessionId={sessionId}
                accountId={account.id}
                email={email.trim() || undefined}
                onCaptured={() => void finished()}
                onExit={() => {
                  if (!done.current) setExited(true);
                }}
              />
            ) : (
              <WorkspaceConnectTerminal
                key={sessionId}
                sessionId={sessionId}
                accountId={account.id}
                service="codex"
                onExit={(code) => {
                  if (code === 0) void finished();
                  else if (!done.current) setExited(true);
                }}
              />
            )}
          </div>
          <div className="connect-modal-actions">
            {exited ? (
              <>
                <span className="connect-modal-muted">Sign-in didn’t finish.</span>
                <Button variant="secondary" onClick={restart}>
                  Start over
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={onDone}>
                Close
              </Button>
            )}
          </div>
        </div>
      )}
    </ModalFrame>
  );
}
