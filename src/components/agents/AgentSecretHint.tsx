/**
 * A bar over the composer when the draft holds something shaped like a
 * key: offer to keep it in the Keychain for this agent and send its variable
 * instead. It never blocks the message; Dismiss (or sending) leaves it as is.
 *
 * @module components/agents/AgentSecretHint
 */

import { useState } from 'react';
import { LockedIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { ConversationBar } from './AgentCard';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { addSecret, findSecret, secretVars } from '../../lib/agentSecrets';

interface AgentSecretHintProps {
  agentId: string;
  agentName: string;
  draft: string;
  setDraft: (next: string) => void;
}

export function AgentSecretHint({ agentId, agentName, draft, setDraft }: AgentSecretHintProps) {
  const { showToast } = useOptionalToast();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const match = findSecret(draft);
  if (!match || match.value === dismissed) return null;

  const store = async () => {
    setBusy(true);
    try {
      const secret = await addSecret(agentId, match.name, match.kind, match.value);
      setDraft(draft.split(match.value).join(secretVars(secret)));
      showToast(`Saved to your Keychain for ${agentName} as ${secretVars(secret)}`, 'success');
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConversationBar
      icon={<LockedIcon size={12} />}
      title={`That looks like ${match.label}`}
      detail="Keep it out of the chat: it goes to your Keychain for this agent instead."
      actions={
        <>
          <TextButton disabled={busy} onClick={() => setDismissed(match.value)}>
            Dismiss
          </TextButton>
          <Button size="compact" variant="secondary" disabled={busy} onClick={() => void store()}>
            Store it securely
          </Button>
        </>
      }
    />
  );
}
