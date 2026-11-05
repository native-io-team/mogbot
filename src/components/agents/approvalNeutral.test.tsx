import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import type { AgentMessage, Approval } from '../../lib/agents';

/**
 * The owner's rule: an answer on an approval or prompt card is never the
 * accent. The accent is whatever colour the user (or the agent) picked — red
 * is in the palette — and a red Allow reads as the destructive choice.
 */

const base: Approval = { requestId: 'r1', title: 'Run a command', detail: 'npm test', status: 'pending' };

const message = (approval: Approval): AgentMessage => ({
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval,
});

const cards: [string, Approval][] = [
  ['approval', base],
  [
    'approval with Always allow',
    { ...base, always: { kind: 'command_prefix', value: 'npm', label: 'npm' } },
  ],
  [
    'session prompt',
    {
      ...base,
      prompt: {
        kind: 'choice',
        project: '/Users/me/ShipStudio/site',
        sessionId: 's1',
        tab: 1,
        question: 'Proceed?',
        options: [
          { label: 'Yes', keys: ['1'], role: 'allow' },
          { label: 'Yes, and don’t ask again', keys: ['2'], role: 'other' },
          { label: 'No', keys: ['3'], role: 'deny' },
        ],
        owner: { id: 'acme', name: 'Acme' },
        chats: ['acme'],
      },
    },
  ],
  [
    'secret request',
    {
      ...base,
      title: 'Secure input · key',
      secret: {
        name: 'key',
        purpose: 'Pull payouts',
        kind: 'api_key',
        fields: [{ label: 'API key', env: 'KEY' }],
        reference: 'secret:acme/key',
      },
    },
  ],
];

describe('approval and prompt answers are neutral', () => {
  for (const [name, approval] of cards) {
    it(`${name}: no answer button takes the accent`, () => {
      const { container } = render(
        <ApprovalCard message={message(approval)} agentName="Acme" paused={false} onAnswer={vi.fn()} />
      );
      const buttons = [...container.querySelectorAll('button')];
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.className, button.textContent ?? '').not.toMatch(/button--primary/);
      }
      const allow = container.querySelector('[data-allow]');
      expect(allow, 'the affirmative answer is marked').not.toBeNull();
      expect(allow!.className).toMatch(/button--strong/);
    });
  }
});
