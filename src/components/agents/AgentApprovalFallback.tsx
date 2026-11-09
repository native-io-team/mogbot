/**
 * What a request card becomes when it fails to draw (a payload the card
 * can't read, from an older or newer build, or a bug in one of its parts).
 *
 * A request that can't be shown must still be answerable, or the agent's
 * turn waits on it until it times out. So the fallback keeps whatever is
 * safely readable (the title, when it is a string) and offers one answer:
 * Deny. Never Allow — the user can't see what they would be allowing.
 *
 * @module components/agents/AgentApprovalFallback
 */

import { useState } from 'react';
import type { AgentMessage } from '../../lib/agents';
import { Button } from '../primitives/Button';
import { AgentCard } from './AgentCard';

export function ApprovalFallback({
  message,
  onAnswer,
}: {
  message: AgentMessage;
  onAnswer?: (requestId: string, allow: boolean) => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'denied' | 'failed'>('idle');
  // Read defensively: this is drawn precisely because the payload was odd.
  const approval: unknown = message?.approval;
  const fields =
    approval && typeof approval === 'object' ? (approval as Record<string, unknown>) : {};
  const title =
    typeof fields.title === 'string' && fields.title.trim() ? fields.title : 'A request';
  const requestId = typeof fields.requestId === 'string' ? fields.requestId : null;
  const pending = fields.status === 'pending';
  const canDeny = pending && requestId !== null && !!onAnswer && state !== 'denied';

  const deny = async () => {
    if (!requestId || !onAnswer) return;
    setState('busy');
    try {
      await onAnswer(requestId, false);
      setState('denied');
    } catch {
      setState('failed');
    }
  };

  return (
    <AgentCard
      title={title}
      data-testid="approval-fallback"
      note={
        state === 'failed'
          ? 'Couldn’t deny it. Try again.'
          : canDeny
            ? 'It can only be denied from here.'
            : undefined
      }
      actions={
        canDeny ? (
          <Button variant="secondary" disabled={state === 'busy'} onClick={() => void deny()}>
            Deny
          </Button>
        ) : undefined
      }
      outcome={state === 'denied' ? 'Denied' : undefined}
      resolved={state === 'denied'}
    >
      <p>This request couldn’t be shown in full.</p>
    </AgentCard>
  );
}
