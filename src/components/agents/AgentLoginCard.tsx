/**
 * The login card an agent's `request_login` leaves in its chat ("Recruiter
 * needs your Gmail"): which account, what it will be able to do (reading, and
 * sending only if it asked, which asks each time), and the ways in, best
 * first. Connect signs in on this Mac (its browser opens there; the token is
 * kept there), Use my browser lets the agent work in the user's own Chrome,
 * and only a real API key gets a masked field. Never a password.
 *
 * The card follows a sign-in under way (`login.flow`), on this Mac or started
 * from the phone, and lands on its outcome. Nobody waits on it.
 *
 * @module components/agents/AgentLoginCard
 */

import { memo, useState } from 'react';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { Spinner } from '../primitives/Spinner';
import { AgentCard } from './AgentCard';
import { useCardGuard } from './useCardGuard';
import { ErrorIcon, LockedIcon, MobileIcon } from '@/components/icons';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  cancelLogin,
  declineLogin,
  loginCardView,
  saveLoginKey,
  startLogin,
  type LoginOption,
} from '../../lib/agentLogins';
import type { AgentMessage } from '../../lib/agents';

interface LoginCardProps {
  message: AgentMessage;
  agentName: string;
  arrived?: boolean;
}

export const LoginCard = memo(function LoginCard({ message, agentName, arrived }: LoginCardProps) {
  const approval = message.approval;
  const login = approval?.login;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [openedPending] = useState(approval?.status === 'pending');
  const { guard, keyProps } = useCardGuard(approval?.status === 'pending');
  if (!approval || !login) return null;
  const view = loginCardView(approval, agentName);
  const pending = approval.status === 'pending';
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
    }
  };
  const choose = (option: LoginOption) => {
    if (option.method === 'key') {
      setKeyOpen(true);
      return;
    }
    void run(() => startLogin(message.agentId, approval.requestId, option.id));
  };
  const saveKey = () =>
    run(async () => {
      await saveLoginKey(message.agentId, approval.requestId, keyValue);
      setKeyValue('');
    });
  const signingIn = view.phase === 'signing-in';
  const chooseable = pending && !signingIn;
  const keyField = login.key?.fields[0];

  const actions = !pending ? undefined : signingIn ? (
    <Button
      tabIndex={0}
      variant="secondary"
      disabled={busy}
      onClick={() => void run(() => cancelLogin(message.agentId, approval.requestId))}
    >
      Cancel
    </Button>
  ) : keyOpen ? (
    <>
      <Button tabIndex={0} variant="secondary" disabled={busy} onClick={() => setKeyOpen(false)}>
        Back
      </Button>
      <Button
        tabIndex={0}
        type="submit"
        variant="strong"
        data-allow
        disabled={busy || keyValue.trim().length === 0}
      >
        Save key
      </Button>
    </>
  ) : (
    <>
      <Button
        tabIndex={0}
        variant="secondary"
        disabled={busy}
        onClick={() => void run(() => declineLogin(message.agentId, approval.requestId))}
      >
        Not now
      </Button>
      {view.primary && (
        <Button
          tabIndex={0}
          variant="strong"
          data-allow
          data-option={view.primary.id}
          disabled={busy}
          {...keyProps}
          onClick={guard(() => choose(view.primary!))}
        >
          {view.phase === 'failed' || view.phase === 'cancelled' ? 'Try again' : view.primary.label}
        </Button>
      )}
    </>
  );

  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        as="form"
        className="agent-approval agent-login"
        data={{ status: approval.status, phase: view.phase, service: login.service }}
        onSubmit={(e) => {
          e.preventDefault();
          if (keyOpen) void saveKey();
        }}
        icon={<LockedIcon size={14} />}
        title={approval.title || `${agentName} needs your ${login.title}`}
        source={login.askedAs ? `Asked for as “${login.askedAs}”` : undefined}
        actions={actions}
        outcome={pending ? undefined : view.outcome}
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
        wrapActions
      >
        <p className="agent-secret__purpose">{login.why}</p>
        {pending && (
          <>
            <ul className="agent-login__abilities" aria-label="What it will be able to do">
              {view.abilities.map((a) => (
                <li key={a.id} data-ability={a.id}>
                  {a.label}
                </li>
              ))}
            </ul>
            {login.noConnector && <p className="agent-card__note">{login.noConnector}</p>}
            {signingIn && (
              <p className="agent-login__flow" role="status">
                <Spinner size="sm" />
                <span>{view.flowLine}</span>
              </p>
            )}
            {signingIn && login.flow?.userCode && (
              <DeviceCode code={login.flow.userCode} uri={login.flow.verificationUri} />
            )}
            {signingIn && login.flow?.fromPhone && (
              <p className="agent-login__from-phone">
                <MobileIcon size={12} />{' '}
                {login.flow.onPhone ? 'Signing in on your phone' : 'Started from your phone'}
              </p>
            )}
            {(view.phase === 'failed' || view.phase === 'cancelled') && (
              <p className="agent-login__flow" data-failed={view.phase === 'failed' || undefined}>
                {view.phase === 'failed' && <ErrorIcon size={12} className="inline-error-icon" />}
                <span>{view.flowLine}</span>
              </p>
            )}
            {chooseable && !keyOpen && view.primary && (
              <p className="agent-card__note">{view.primary.detail}</p>
            )}
            {chooseable && !keyOpen && view.others.length > 0 && (
              <div className="agent-login__others" aria-label="Other ways in">
                {view.others.map((o) => (
                  <div key={o.id} className="agent-login__other" data-option={o.id}>
                    <TextButton
                      tabIndex={0}
                      disabled={busy}
                      {...keyProps}
                      onClick={guard(() => choose(o))}
                    >
                      {o.label}
                    </TextButton>
                    <span className="agent-login__other-detail">{o.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {chooseable && keyOpen && keyField && (
              <div className="agent-secret__fields">
                <label className="agent-secret__field">
                  <span className="agent-secret__label">{keyField.label}</span>
                  <TextField
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyValue}
                    disabled={busy}
                    onChange={(e) => setKeyValue(e.target.value)}
                  />
                </label>
                <p className="agent-card__note">
                  A key made for apps, never a password. Kept in your Keychain for {agentName} only;
                  it can use it but never sees it.
                </p>
              </div>
            )}
            {error && (
              <p className="agent-editor__error" role="alert">
                <ErrorIcon size={12} className="inline-error-icon" />
                {error}
              </p>
            )}
          </>
        )}
      </AgentCard>
    </div>
  );
});

/**
 * A device sign-in's one-time code (GitHub's, through `gh` on this Mac):
 * typed at the address on this Mac or the phone. Short-lived; never stored.
 */
function DeviceCode({ code, uri }: { code: string; uri?: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  const where = uri?.replace(/^https:\/\//, '');
  return (
    <div className="agent-login__code" data-testid="login-device-code">
      <span className="agent-login__code-label">Your code</span>
      <code className="agent-login__code-value">{code}</code>
      <TextButton tabIndex={0} onClick={() => void copy(code)}>
        {isCopied ? 'Copied' : 'Copy'}
      </TextButton>
      {uri && where && (
        <a className="agent-login__code-link" href={uri} target="_blank" rel="noreferrer">
          {where}
        </a>
      )}
    </div>
  );
}
