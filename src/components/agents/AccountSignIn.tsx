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
 * This Mac's own sign-in isn't signed in here: it's the engine's own
 * login, which the engine's sign-in terminal elsewhere handles.
 *
 * @module components/agents/AccountSignIn
 */

import { useRef, useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextField } from '../primitives/TextField';
import { ClaudeConnectTerminal, WorkspaceConnectTerminal } from '../terminal/lazyTerminals';
import { ENGINE_LABEL } from '../../lib/agents';
import type { UsageAccount } from '../../lib/agentAccounts';

export function AccountSignIn({ account, onDone }: { account: UsageAccount; onDone: () => void }) {
  const label = ENGINE_LABEL[account.engine];
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<'email' | 'terminal'>(
    account.engine === 'claude' ? 'email' : 'terminal'
  );
  const [email, setEmail] = useState(account.email ?? '');
  const [exited, setExited] = useState(false);
  const done = useRef(false);

  const restart = () => {
    done.current = false;
    setExited(false);
    setSessionId(crypto.randomUUID());
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
      className="agents-panel-terminal-modal"
    >
      {phase === 'email' ? (
        <div className="connect-modal-email-phase">
          <p className="connect-modal-instructions">
            Use the Claude account this should be. Its sign-in stays separate from this Mac’s own.
          </p>
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
          <div className="connect-modal-actions">
            <Button variant="secondary" onClick={onDone}>
              Later
            </Button>
            <Button variant="strong" onClick={() => setPhase('terminal')}>
              Continue
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
                onCaptured={() => {
                  done.current = true;
                  onDone();
                }}
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
                  if (code === 0) {
                    done.current = true;
                    onDone();
                  } else if (!done.current) setExited(true);
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
