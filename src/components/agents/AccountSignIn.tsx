/**
 * Signs a usage account in, into its own folder, with its engine's own
 * sign-in running in a terminal the backend owns:
 *
 * - Claude Code: `claude auth login` under the account's own
 *   `CLAUDE_CONFIG_DIR`, the same sign-in as the first one. Claude Code keeps
 *   the login for that folder itself; the app never sees or stores it. It
 *   finishes when the CLI exits 0 and `claude auth status` as that folder
 *   agrees (Rust checks before the exit reaches here).
 * - Codex: `codex login` under the account's own `CODEX_HOME`; it finishes
 *   when the CLI exits 0.
 *
 * Both run in `WorkspaceConnectTerminal`. An account an older build signed
 * in with a captured token says "Sign in again" in Usage; signing it in here
 * replaces that token, which is then deleted.
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

import { useRef, useState, type ReactNode } from 'react';
import { CheckIcon, WarningIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { WorkspaceConnectTerminal } from '../terminal/lazyTerminals';
import { ENGINE_LABEL } from '../../lib/agents';
import type { UsageAccount } from '../../lib/agentAccounts';
import {
  TRY_AGAIN_DIFFERENT,
  addedSameAccount,
  browserSteps,
  browserWarning,
  checkNewAccount,
} from '../../lib/agentsUsage';
import { ENGINE_ICON } from './UsageStack';
import { THIS_COMPUTER } from '../../lib/computer';

/**
 * `checking`, `done`, `same` and `failed` are one status card each, drawn
 * by `SignInStatus` in one compact, fixed-height layout (the engine's icon
 * with the state's mark, the account, one line, one hint, the actions), so
 * the dialog doesn't jump from one to the next.
 */
type Phase = 'before' | 'terminal' | 'checking' | 'done' | 'same' | 'failed';

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
      setPhase('done');
    } catch {
      // Signed in, not read this time: said plainly, and Usage says so once it is.
      setPhase('failed');
    }
  };

  if (account.thisMac) {
    return (
      <ModalFrame isOpen onClose={onDone} title={`Sign in to ${label}`}>
        <p className="connect-modal-instructions">
          This is {label}’s own sign-in on {THIS_COMPUTER}. Sign in from its row in Agents, or add
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

  const status = phase === 'checking' || phase === 'done' || phase === 'same' || phase === 'failed';
  return (
    <ModalFrame
      isOpen
      onClose={onDone}
      title={`Sign in “${account.name}” to ${label}`}
      className={phase === 'terminal' ? 'agents-panel-terminal-modal' : 'account-signin-modal'}
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
          <div className="connect-modal-actions">
            <Button variant="secondary" onClick={onDone}>
              Later
            </Button>
            <Button
              variant="strong"
              autoFocus
              data-testid="account-signin-continue"
              onClick={() => setPhase('terminal')}
            >
              Continue
            </Button>
          </div>
        </div>
      ) : status ? (
        phase === 'checking' ? (
          <SignInStatus
            phase="checking"
            account={account}
            line="Checking which account this is…"
            hint={`Signed in. Reading it once from ${label}, to catch an account that’s already here.`}
            actions={
              <Button variant="secondary" onClick={onDone}>
                Close
              </Button>
            }
          />
        ) : phase === 'done' ? (
          <SignInStatus
            phase="done"
            account={account}
            line={`${account.name} is signed in`}
            hint="It’s a new account, so it adds room. Its usage shows in Usage after its first reading."
            actions={
              <Button variant="strong" autoFocus onClick={onDone}>
                Done
              </Button>
            }
          />
        ) : phase === 'same' ? (
          <SignInStatus
            phase="same"
            account={account}
            line="That’s an account already here"
            hint={addedSameAccount(account.engine, twin ?? 'another account here')}
            actions={
              <>
                {onRemove && (
                  <Button variant="ghost" onClick={onRemove}>
                    Remove it
                  </Button>
                )}
                <Button variant="strong" autoFocus onClick={restart}>
                  {TRY_AGAIN_DIFFERENT}
                </Button>
              </>
            }
          />
        ) : (
          <SignInStatus
            phase="failed"
            account={account}
            line="Signed in, but not checked"
            hint="Which account this is couldn’t be read just now. If it’s one already here, Usage says so once it reads it."
            actions={
              <Button variant="strong" autoFocus onClick={onDone}>
                Done
              </Button>
            }
          />
        )
      ) : (
        <div className="connect-modal-terminal-phase">
          <p className="connect-modal-instructions">
            {account.engine === 'claude'
              ? 'A browser window opens: sign in to Claude there. If it shows a code, paste it into the terminal below and press Enter.'
              : 'A browser window opens: sign in to ChatGPT there. This finishes on its own.'}
          </p>
          <div className="agents-panel-terminal-body">
            <WorkspaceConnectTerminal
              key={sessionId}
              sessionId={sessionId}
              accountId={account.id}
              service={account.engine === 'claude' ? 'claude' : 'codex'}
              onExit={(code) => {
                if (code === 0) void finished();
                else if (!done.current) setExited(true);
              }}
            />
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

/**
 * After the sign-in returns: one compact card, the same for every outcome.
 * The engine's icon carries the state's mark (a spinner while checking, a
 * tick, a warning), then the account, one line saying what happened, one
 * hint, and the actions. Fixed height, so changing state never moves the
 * dialog.
 */
function SignInStatus({
  phase,
  account,
  line,
  hint,
  actions,
}: {
  phase: 'checking' | 'done' | 'same' | 'failed';
  account: UsageAccount;
  line: string;
  hint: string;
  actions: ReactNode;
}) {
  const Icon = ENGINE_ICON[account.engine];
  return (
    <div
      className="account-signin__status"
      data-phase={phase}
      data-testid={phase === 'same' ? 'account-signin-same' : `account-signin-${phase}`}
    >
      <div className="account-signin__status-body" role="status" aria-live="polite">
        <span className="account-signin__badge" aria-hidden>
          <Icon size={22} />
          <span className="account-signin__mark">
            {phase === 'checking' ? (
              <Spinner size="sm" label="Checking" />
            ) : phase === 'done' ? (
              <CheckIcon size={11} />
            ) : (
              <WarningIcon size={11} />
            )}
          </span>
        </span>
        {/* The title names the account; its email only when there is one. */}
        {account.email && account.email !== account.name && (
          <span className="account-signin__account">{account.email}</span>
        )}
        <p className="account-signin__line">{line}</p>
        <p className="account-signin__hint">{hint}</p>
      </div>
      <div className="account-signin__actions">{actions}</div>
    </div>
  );
}
