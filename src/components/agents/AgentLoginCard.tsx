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
import { SignInHelp, useNotNeeded } from './SignInHelp';
import { useOpenReach } from './openReach';
import {
  ChevronIcon,
  ChevronRightIcon,
  ErrorIcon,
  LockedIcon,
  MobileIcon,
} from '@/components/icons';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  cancelLogin,
  declineLogin,
  loginCardView,
  loginNotNeeded,
  retriesPrimary,
  saveLoginKey,
  startLogin,
  abilitiesLine,
  wayLine,
  type LoginOption,
} from '../../lib/agentLogins';
import type { AgentMessage } from '../../lib/agents';
import { askedForLine } from '../../lib/agentSecrets';

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
  const [othersOpen, setOthersOpen] = useState(false);
  const [openedPending] = useState(approval?.status === 'pending');
  const { guard, keyProps } = useCardGuard(approval?.status === 'pending');
  const notNeeded = useNotNeeded();
  const openReach = useOpenReach();
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
  // A way in that failed, other than the lead one, is shown where its retry is.
  const failedElsewhere =
    view.phase === 'failed' && !!login.flow && login.flow.option !== view.primary?.id;
  const showOthers = othersOpen || failedElsewhere;
  const othersId = `login-others-${approval.requestId}`;

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
        title={`Tells ${agentName} no, this time. It can ask again later.`}
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
          title={view.primary.detail}
          disabled={busy}
          {...keyProps}
          onClick={guard(() => choose(view.primary!))}
        >
          {retriesPrimary(view.phase, login?.flow?.option, view.primary.id)
            ? 'Try again'
            : view.primary.label}
        </Button>
      )}
    </>
  );
  const title = approval.title || `${agentName} needs your ${login.title}`;

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
        title={title}
        source={
          [
            askedForLine(login.askedAs, title),
            pending && login.alsoFor?.length ? `Also for ${login.alsoFor.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        actions={actions}
        outcome={
          pending ? undefined : approval.status === 'allowed' && openReach ? (
            // What was just given, and where to change it or take it back.
            <>
              {view.outcome}{' '}
              <TextButton
                tabIndex={0}
                className="agent-login__reach"
                aria-label={`What ${agentName} can reach: change or remove ${login.title}`}
                onClick={() => openReach(message.agentId)}
              >
                What it can reach
              </TextButton>
            </>
          ) : (
            view.outcome
          )
        }
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
        wrapActions
      >
        <p className="agent-secret__purpose">{login.why}</p>
        {pending && (
          <>
            <p className="agent-login__abilities" aria-label="What it will be able to do">
              {abilitiesLine(view.abilities)}
            </p>
            {login.noConnector && !view.primary && (
              <p className="agent-card__note">{login.noConnector}</p>
            )}
            {signingIn && (
              <p className="agent-login__flow" role="status">
                <Spinner size="sm" />
                <span>{view.flowLine}</span>
              </p>
            )}
            {signingIn && (
              <SignInHelp
                agentId={message.agentId}
                requestId={approval.requestId}
                flow={login.flow}
              />
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
              <p className="agent-card__note" data-lead-line>
                {wayLine(view.primary, login.title)}
              </p>
            )}
            {chooseable && !keyOpen && (
              <TextButton
                tabIndex={0}
                className="agent-login__more"
                aria-expanded={showOthers}
                aria-controls={othersId}
                onClick={() => setOthersOpen(!showOthers)}
                rightIcon={
                  // A disclosure, not a sentence: the chevron says it opens.
                  showOthers ? <ChevronIcon size={12} /> : <ChevronRightIcon size={12} />
                }
              >
                {showOthers ? 'Fewer ways' : 'Other ways'}
              </TextButton>
            )}
            {chooseable && !keyOpen && showOthers && (
              <div id={othersId} className="agent-login__others" aria-label="Other ways">
                {login.noConnector && view.primary && (
                  <p className="agent-login__other-detail">{login.noConnector}</p>
                )}
                {view.others.map((o) => (
                  <div key={o.id} className="agent-login__other" data-option={o.id}>
                    <TextButton
                      tabIndex={0}
                      disabled={busy}
                      title={o.detail}
                      {...keyProps}
                      onClick={guard(() => choose(o))}
                    >
                      {o.label}
                    </TextButton>
                    <span className="agent-login__other-detail">{wayLine(o, login.title)}</span>
                  </div>
                ))}
                <div className="agent-login__other" data-not-needed-row>
                  <TextButton
                    tabIndex={0}
                    data-not-needed
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        notNeeded(() => loginNotNeeded(message.agentId, approval.requestId))
                      )
                    }
                  >
                    Not needed
                  </TextButton>
                  <span className="agent-login__other-detail">
                    No agent asks for {login.title} again. Turn it back on from “What it can reach”.
                  </span>
                </div>
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
