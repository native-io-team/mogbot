import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { expiryLine, type AgentMessage, type Approval } from '../../lib/agents';

/** Cards expire: one quiet line, no buttons, never another ask. */

const base: Approval = {
  requestId: 'r1',
  title: 'Run a command',
  detail: 'npm test',
  status: 'expired',
};

const message = (approval: Approval): AgentMessage => ({
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval,
});

describe('an expired card', () => {
  it('says why in one line', () => {
    expect(expiryLine({ ...base, expiry: 'moved_on' })).toBe(
      'Expired — the agent moved on · Run a command'
    );
    expect(expiryLine({ ...base, expiry: 'no_answer' })).toBe(
      'No answer — ask again later if it still matters · Run a command'
    );
    expect(expiryLine({ ...base, expiry: 'maybe_later' })).toBe('Maybe later · Run a command');
    expect(expiryLine(base)).toBeNull();
  });

  it.each([
    ['a permission card', { ...base, expiry: 'moved_on' as const }],
    [
      'a secure input',
      {
        ...base,
        title: 'Secure input · STRIPE_KEY',
        expiry: 'maybe_later' as const,
        secret: {
          name: 'STRIPE_KEY',
          purpose: 'To read invoices',
          kind: 'api_key',
          fields: [],
          reference: '$STRIPE_KEY',
        } as unknown as Approval['secret'],
      },
    ],
  ])('collapses %s to a receipt with nothing to press', (_, approval) => {
    const { container } = render(
      <ApprovalCard message={message(approval)} agentName="Acme" paused onAnswer={async () => {}} />
    );
    expect(container.querySelector('.agent-note--expired')?.textContent).toBe(expiryLine(approval));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
