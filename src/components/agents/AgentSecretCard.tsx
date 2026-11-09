/**
 * The secure input card an agent's `request_secret` leaves in its chat: what
 * it wants and why, a masked field per part, Save or Deny. The value goes
 * from here to the Keychain (`agents_save_secret`); the agent is woken with
 * the variable's name, never the value. Nobody waits on the card, so it can
 * be answered whenever.
 *
 * @module components/agents/AgentSecretCard
 */

import { memo, useMemo, useState } from 'react';
import { Button } from '../primitives/Button';
import { AgentCard } from './AgentCard';
import { TextField } from '../primitives/TextField';
import { ErrorIcon, LockedIcon } from '@/components/icons';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { saveSecret, secretTitle, secretVars } from '../../lib/agentSecrets';
import { readSecretRequest } from '../../lib/cardShapes';
import type { AgentMessage } from '../../lib/agents';

interface SecretCardProps {
  message: AgentMessage;
  agentName: string;
  onAnswer: (requestId: string, allow: boolean) => Promise<void>;
  arrived?: boolean;
}

export const SecretCard = memo(function SecretCard({
  message,
  agentName,
  onAnswer,
  arrived,
}: SecretCardProps) {
  const approval = message.approval;
  // Read field by field: a request missing parts still draws, and one with no
  // field to fill can only be declined.
  const request = useMemo(
    () => (approval?.secret ? readSecretRequest(approval.secret) : undefined),
    [approval?.secret]
  );
  const [values, setValues] = useState<string[]>(() => request?.fields.map(() => '') ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedPending] = useState(approval?.status === 'pending');
  if (!approval || !request) return null;
  const pending = approval.status === 'pending';
  const fillable = request.fields.length > 0;
  const filled = fillable && values.every((v) => v.trim().length > 0);

  const save = async () => {
    if (!filled || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveSecret(message.agentId, approval.requestId, values);
      setValues(request.fields.map(() => ''));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    } finally {
      setBusy(false);
    }
  };
  // The chat's answer handler toasts a failure.
  const deny = async () => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        as="form"
        className="agent-approval agent-secret"
        data={{ status: approval.status }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        icon={<LockedIcon size={14} />}
        title={
          // The identifier and its variables are the agent's business: a
          // tooltip for the curious, not the headline.
          <span title={`${request.name} · ${secretVars(request)}`}>
            {agentName} needs your {secretTitle(request.name)}
          </span>
        }
        actions={
          pending ? (
            <>
              <Button tabIndex={0} variant="secondary" disabled={busy} onClick={() => void deny()}>
                Deny
              </Button>
              {fillable && (
                <Button
                  tabIndex={0}
                  type="submit"
                  variant="strong"
                  data-allow
                  disabled={!filled || busy}
                >
                  Save
                </Button>
              )}
            </>
          ) : undefined
        }
        outcome={
          pending
            ? undefined
            : approval.status === 'allowed'
              ? `Saved to your Keychain · ${agentName} can use it now`
              : approval.status === 'denied'
                ? approval.note
                  ? `Declined · “${approval.note}”`
                  : `Declined · ${agentName} was told`
                : 'Not answered'
        }
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
      >
        {request.purpose && <p className="agent-secret__purpose">{request.purpose}</p>}
        {pending && !fillable && (
          <p className="agent-card__note">
            This request didn’t say what to fill in, so it can only be declined. {agentName} can ask
            again.
          </p>
        )}
        {pending && fillable && (
          <>
            <div className="agent-secret__fields">
              {request.fields.map((field, i) => (
                <label key={field.env} className="agent-secret__field">
                  <span className="agent-secret__label">{field.label}</span>
                  <TextField
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={values[i] ?? ''}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      setValues((list) => list.map((v, j) => (j === i ? next : v)));
                    }}
                  />
                </label>
              ))}
            </div>
            <p className="agent-card__note" title={secretVars(request)}>
              Kept in your Keychain for {agentName} only. {agentName} can use it but never sees it.
            </p>
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
