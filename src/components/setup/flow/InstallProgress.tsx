/**
 * An install or a sign-in as a native installer shows it: a few plain steps
 * that tick as the real process gets there, whatever it's waiting on asked
 * in plain words (the Mac password, Return, a code from the browser), and
 * the real terminal output folded under "Show details" for whoever wants it.
 *
 * @module components/setup/flow/InstallProgress
 */

import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../../primitives/Button';
import { Spinner } from '../../primitives/Spinner';
import { TextField } from '../../primitives/TextField';
import { CheckIcon, ChevronIcon, ExternalLinkIcon } from '@/components/icons';
import {
  installSteps,
  isAuthItem,
  plainName,
  promptOf,
  QUESTION_QUIET_MS,
  QUIET_ITEMS,
  signInUrlOf,
  stepState,
  type InstallPhase,
} from '../../../lib/installProgress';
import { toVisibleLines } from '../../../lib/terminalDiagnostics';
import { stripTerminalControls } from '../../../lib/terminalPrompt';

/** How many of the last lines the folded log keeps. */
const LOG_LINES = 200;

interface InstallDetailsProps {
  /** What the run printed. Shown as plain lines when there is no live terminal. */
  output: string;
  /** The live terminal, kept mounted (it owns the process) and only shown when open. */
  terminal?: ReactNode;
  /** Shown instead of an empty log. */
  empty?: string;
  open: boolean;
  onToggle: () => void;
}

/** "Show details": the real output, for whoever wants it. */
export function InstallDetails({ output, terminal, empty, open, onToggle }: InstallDetailsProps) {
  const id = useId();
  const lines = toVisibleLines(output).slice(-LOG_LINES);
  return (
    <div className="install-details">
      <Button
        variant="ghost"
        size="compact"
        rightIcon={<ChevronIcon size={12} className="install-details__chevron" />}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        data-install-details-toggle
      >
        {open ? 'Hide details' : 'Show details'}
      </Button>
      <div
        id={id}
        className="install-details__panel"
        data-open={open}
        // Folded away, nothing in it can take focus or be read out.
        inert={!open}
        aria-hidden={!open}
      >
        {terminal ? (
          <div className="install-details__terminal">{terminal}</div>
        ) : (
          <pre className="install-details__log">
            {lines.length > 0 ? lines.join('\n') : (empty ?? 'Nothing printed yet.')}
          </pre>
        )}
      </div>
    </div>
  );
}

interface InstallProgressProps {
  itemId: string;
  phase: InstallPhase;
  output: string;
  lastOutputAt: number;
  /** The live terminal running the real command, when there is one. */
  terminal?: ReactNode;
  /** Type into the run: a password, Return, a code. */
  onAnswer: (data: string) => void;
  onCancel: () => void;
}

export function InstallProgress({
  itemId,
  phase,
  output,
  lastOutputAt,
  terminal,
  onAnswer,
  onCancel,
}: InstallProgressProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [value, setValue] = useState('');
  const fieldId = useId();

  // A line that ends like a question only counts once the run has gone
  // quiet on it, so look again when that would be.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const due = lastOutputAt + QUESTION_QUIET_MS - Date.now();
    if (due <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), due + 50);
    return () => clearTimeout(timer);
  }, [lastOutputAt]);
  const prompt = phase === 'check' ? null : promptOf(output, Math.max(0, now - lastOutputAt));

  // Something we can't put a field to: the real output opens so it can be
  // answered there, unless the person has already chosen.
  const open = userOpen ?? prompt === 'question';

  const signInUrl = isAuthItem(itemId) && phase === 'browser' ? signInUrlOf(output) : null;
  const name = plainName(itemId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const typed = stripTerminalControls(value).replace(/\n/g, '');
    if (!typed) return;
    onAnswer(`${typed}\r`);
    setValue('');
  };

  return (
    <div className="install-progress" data-install-phase={phase} data-install-prompt={prompt ?? ''}>
      <ol className="install-steps">
        {installSteps(itemId).map((step) => {
          const state = stepState(step, phase);
          return (
            <li key={step.phase} className="install-step" data-state={state}>
              <span className="install-step__mark" aria-hidden>
                {state === 'done' ? (
                  <CheckIcon size={14} />
                ) : state === 'current' ? (
                  <Spinner size="sm" />
                ) : (
                  <span className="install-step__dot" />
                )}
              </span>
              <span className="install-step__label">
                {step.label}
                {state === 'current' ? '…' : ''}
              </span>
              {state === 'done' && <span className="sr-only">, done</span>}
            </li>
          );
        })}
      </ol>

      {(prompt === 'password' || prompt === 'code') && (
        <form className="install-ask" onSubmit={submit} data-install-ask={prompt}>
          <label className="install-ask__label" htmlFor={fieldId}>
            {prompt === 'password'
              ? `${name}’s installer needs your Mac password`
              : 'Browser showing a code? Paste it here'}
          </label>
          {prompt === 'password' && (
            <p className="install-ask__hint">
              The one you log in to this Mac with. It goes straight to the installer; the app
              doesn’t keep it.
            </p>
          )}
          <div className="install-ask__row">
            <TextField
              id={fieldId}
              type={prompt === 'password' ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" variant="strong" disabled={!value}>
              Continue
            </Button>
          </div>
        </form>
      )}

      {prompt === 'enter' && (
        <div className="install-ask" data-install-ask="enter">
          <span className="install-ask__label">{name} is ready to install.</span>
          <div className="install-ask__row">
            <Button variant="strong" onClick={() => onAnswer('\r')} autoFocus>
              Continue
            </Button>
          </div>
        </div>
      )}

      {prompt === 'question' && (
        <div className="install-ask" data-install-ask="question">
          <span className="install-ask__label">It’s asking something.</span>
          <p className="install-ask__hint">Answer it in the details below, then press Enter.</p>
        </div>
      )}

      {signInUrl && (
        <div className="install-signin">
          <span className="install-signin__line">
            Finish in your browser. This screen notices when you’re done.
          </span>
          <Button
            variant="secondary"
            rightIcon={<ExternalLinkIcon size={12} />}
            onClick={() => void openUrl(signInUrl)}
            data-install-open-signin
          >
            Open the sign-in page again
          </Button>
        </div>
      )}

      <div className="install-progress__foot">
        <InstallDetails
          output={output}
          terminal={terminal}
          empty={
            QUIET_ITEMS.has(itemId)
              ? `Homebrew prints nothing while it installs ${name}. If it fails, what it said shows here.`
              : undefined
          }
          open={open}
          onToggle={() => setUserOpen(!open)}
        />
        {phase !== 'check' && (
          <Button variant="ghost" size="compact" onClick={onCancel} data-install-cancel>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
