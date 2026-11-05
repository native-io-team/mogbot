/**
 * The agent editor's Logins list: what this agent has in the Keychain, said
 * by what it's for and when it was used (the stored name and the variables it
 * becomes are a hover away, not the headline), each with Revoke. Revoking deletes the Keychain item at
 * once; it isn't part of Save.
 *
 * @module components/agents/AgentSecrets
 */

import { useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { formatAgo } from '../../lib/workflows';
import { revokeSecret, secretVars, type AgentSecret } from '../../lib/agentSecrets';
import type { Agent } from '../../lib/agents';

export function AgentSecrets({ agent }: { agent: Agent }) {
  const [secrets, setSecrets] = useState<AgentSecret[]>(agent.secrets ?? []);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const revoke = async (secret: AgentSecret) => {
    setError(null);
    try {
      await revokeSecret(agent.id, secret.id);
      setSecrets((list) => list.filter((s) => s.id !== secret.id));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  return (
    <div className="agent-editor__label" role="group" aria-label="Logins">
      Logins
      {secrets.length === 0 ? (
        <p className="agent-editor__hint">
          None yet. When {agent.name} needs to sign in to something, it asks with a secure card in
          the chat, and the login goes into your Keychain.
        </p>
      ) : (
        <ul className="agent-permissions">
          {secrets.map((secret) => (
            <li key={secret.id} className="agent-permissions__rule agent-secrets__row">
              <span className="agent-secrets__text">
                <span
                  className="agent-secrets__name"
                  title={`Saved as ${secret.name} · ${secretVars(secret)}`}
                >
                  {secret.purpose || secret.name}
                </span>
                <span className="agent-secrets__meta">
                  Added {formatAgo(secret.createdAt, now)} ·{' '}
                  {secret.lastUsedAt ? `used ${formatAgo(secret.lastUsedAt, now)}` : 'not used yet'}
                </span>
              </span>
              <TextButton
                tabIndex={0}
                className="agent-permissions__revoke"
                onClick={() => void revoke(secret)}
              >
                Revoke
              </TextButton>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}
