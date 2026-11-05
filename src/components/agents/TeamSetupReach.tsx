/**
 * The Logins step of "Setting up your team", after the app checked what the
 * team can already reach (`agents/access_check.rs`): one calm progress line
 * while it runs, then only the residue — "Your team is ready. 3 things I
 * couldn't reach on this Mac" — each with one sign-in button and "Not
 * needed". What was reached folds into one line of receipts.
 *
 * Also the guided "Let agents use your browser" card (`BrowserSetupCard`),
 * shown here before the check can use the browser, and from ⌘K.
 *
 * @module components/agents/TeamSetupReach
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, GlobeIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Spinner } from '../primitives/Spinner';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  checkLine,
  checkTeamReach,
  openLater,
  receiptLine,
  residueLine,
  setupLater,
  type SetupLater,
  type SetupStep,
} from '../../lib/teamSetup';
import {
  BROWSER_CHECK_CONSENT,
  BROWSER_TITLE,
  browserLine,
  enableBrowser,
  getBrowserStatus,
  openBrowserInstall,
  type BrowserStatus,
} from '../../lib/agentBrowser';
import { useModal } from '../../contexts/ModalContext';
import { ModalFrame } from '../primitives/ModalFrame';
import { AgentCard } from './AgentCard';

export function SetupReach({
  step,
  onOpenAgent,
}: {
  step: SetupStep;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { showToast } = useOptionalToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showReached, setShowReached] = useState(false);
  const later = step.later ?? [];
  const check = step.check;
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setBusy(null);
    }
  };
  if (later.length === 0) return null;

  if (check?.running) {
    return (
      <p className="team-setup__check" data-testid="team-setup-check" aria-live="polite">
        <Spinner size="sm" /> {checkLine(check)}
      </p>
    );
  }

  const open = openLater(later);
  const reached = later.filter((l) => l.state === 'reachable');
  const waiting = later.filter((l) => l.state === 'asked');
  return (
    <div className="team-setup__reach" data-testid="team-setup-reach">
      <p className="team-setup__detail">{residueLine(later)}</p>
      {open.length > 0 && (
        <ul className="team-setup__list">
          {open.map((l) => (
            <ResidueRow
              key={l.key}
              row={l}
              busy={busy}
              onConnect={() =>
                void run(`connect:${l.key}`, async () => {
                  const raised = await setupLater(l.key, 'connect');
                  // A key's field, or how the sign-in is going: in that agent's chat.
                  if (raised && l.keyOnly) onOpenAgent?.(raised.agentId);
                })
              }
              onNotNeeded={() => void run(`skip:${l.key}`, () => setupLater(l.key, 'not_needed'))}
            />
          ))}
        </ul>
      )}
      {waiting.length > 0 && (
        <ul className="team-setup__list">
          {waiting.map((l) => (
            <li key={l.key} className="team-setup__item" data-later="asked">
              <div className="team-setup__item-text">
                <span className="team-setup__item-title">{l.title}</span>
                <span className="team-setup__item-detail">Waiting on its sign-in card</span>
              </div>
              {l.state === 'asked' && onOpenAgent && (
                <TextButton tabIndex={0} onClick={() => onOpenAgent(l.agentId)}>
                  Open
                </TextButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {!check?.browser && open.some((l) => !l.keyOnly) && <BrowserConsent />}
      <p className="team-setup__receipts">
        {reached.length > 0 && (
          <TextButton
            tabIndex={0}
            aria-expanded={showReached}
            onClick={() => setShowReached((v) => !v)}
          >
            {reached.length} reached on this Mac
          </TextButton>
        )}
        <TextButton
          tabIndex={0}
          disabled={!!busy}
          onClick={() => void run('check', checkTeamReach)}
        >
          Check again
        </TextButton>
      </p>
      {showReached && (
        <ul className="team-setup__receipt-list" data-testid="team-setup-receipts">
          {reached.map((l) => (
            <li key={l.key}>
              <CheckIcon size={10} /> {receiptLine(l)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResidueRow({
  row,
  busy,
  onConnect,
  onNotNeeded,
}: {
  row: SetupLater;
  busy: string | null;
  onConnect: () => void;
  onNotNeeded: () => void;
}) {
  const connecting = busy === `connect:${row.key}`;
  return (
    <li className="team-setup__item" data-later="open">
      <div className="team-setup__item-text">
        <span className="team-setup__item-title">{row.title}</span>
        <span className="team-setup__item-detail">{row.agents.join(', ')}</span>
      </div>
      <TextButton tabIndex={0} disabled={!!busy} onClick={onNotNeeded}>
        Not needed
      </TextButton>
      {row.action && (
        <Button variant="secondary" size="compact" disabled={!!busy} onClick={onConnect}>
          {connecting ? <Spinner size="sm" /> : row.action}
        </Button>
      )}
    </li>
  );
}

/** One calm line before the browser is set up: the consent, one tap. */
function BrowserConsent() {
  const [open, setOpen] = useState(false);
  if (open) return <BrowserSetupCard compact onDone={() => setOpen(false)} />;
  return (
    <p className="team-setup__consent">
      {BROWSER_CHECK_CONSENT}{' '}
      <TextButton tabIndex={0} onClick={() => setOpen(true)}>
        Set up
      </TextButton>
    </p>
  );
}

/**
 * "Let agents use your browser · Set up": what's needed, checked by the app
 * (Claude Code's sign-in, the extension, a browser answering), the one thing
 * to press for the step that's next, and Turn on once Chrome answers.
 */
export function BrowserSetupCard({
  compact = false,
  onDone,
}: {
  compact?: boolean;
  onDone?: () => void;
}) {
  const { showToast } = useOptionalToast();
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getBrowserStatus());
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setChecking(false);
    }
  }, [showToast]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    try {
      setStatus(await enableBrowser());
      onDone?.();
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const on = !!status?.enabled;
  return (
    <AgentCard
      as="section"
      className="browser-setup"
      data-testid="browser-setup"
      data={{ on, ready: status?.ready, compact }}
      icon={<GlobeIcon size={14} />}
      title={BROWSER_TITLE}
      source={browserLine(status)}
      note={
        status && status.codexAgents > 0
          ? 'Agents on Codex can’t use it; they ask instead.'
          : undefined
      }
      actions={
        <>
          <TextButton tabIndex={0} disabled={checking} onClick={() => void refresh()}>
            {checking ? 'Checking…' : 'Check again'}
          </TextButton>
          {!on && (
            <Button
              variant="strong"
              size="compact"
              disabled={busy || checking || !status?.ready}
              onClick={() => void turnOn()}
            >
              Turn on
            </Button>
          )}
        </>
      }
    >
      {status ? (
        <ol className="browser-setup__steps">
          {status.steps.map((s) => (
            <li key={s.id} className="browser-setup__step" data-done={s.done || undefined}>
              <span className="team-setup__mark" aria-hidden="true">
                {s.done && <CheckIcon size={12} />}
              </span>
              <div className="team-setup__item-text">
                <span className="team-setup__item-title">{s.title}</span>
                <span className="team-setup__item-detail">{s.detail}</span>
              </div>
              {!s.done && s.openLabel && (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => void openBrowserInstall()}
                >
                  {s.openLabel}
                </Button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="team-setup__check">
          <Spinner size="sm" /> Checking this Mac…
        </p>
      )}
    </AgentCard>
  );
}

/** ⌘K "Let agents use your browser…": the guided card in a dialog. */
export function BrowserSetupModal() {
  const modal = useModal('agentBrowser');
  return (
    <ModalFrame
      isOpen={modal.isOpen}
      onClose={modal.close}
      title={BROWSER_TITLE}
      className="browser-setup-modal"
    >
      {modal.isOpen && <BrowserSetupCard />}
    </ModalFrame>
  );
}
