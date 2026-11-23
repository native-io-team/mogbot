// A key an approval card owns (A, D, and Catch up's O and L) is the card's,
// even before Allow arms: left unhandled, the same letter also opened the agent
// whose key it is (useAgentKeyShortcuts skips only a handled press).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { Decision } from './AgentsCatchUp';
import type { Agent, AgentMessage } from '../../lib/agents';

vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  answerApproval: vi.fn(() => Promise.resolve()),
}));

const card = (): AgentMessage => ({
  id: 'm1',
  agentId: 'acme',
  ts: 1,
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'req1',
    tool: 'Bash',
    title: 'Run a command',
    input: { command: 'npm test' },
    detail: 'npm test',
    status: 'pending',
  },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('a card key never also reaches the agent keys', () => {
  it('chat card: A before it arms is held, not passed on', () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<ApprovalCard message={card()} agentName="Acme" paused={false} onAnswer={onAnswer} />);
    const row = document.querySelector<HTMLElement>('[data-keys]')!;
    row.focus();
    // fireEvent returns false when the press was claimed (preventDefault).
    expect(fireEvent.keyDown(row, { key: 'a' })).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('Catch up card: A before it arms, O and L are all claimed', () => {
    const onOpenChat = vi.fn();
    const onLater = vi.fn();
    const item = {
      key: 'm1',
      agent: {
        id: 'acme',
        name: 'Acme',
        status: { state: 'waiting' },
        pendingApprovals: 1,
      } as unknown as Agent,
      message: card(),
      ts: 1,
    };
    const { container } = render(
      <Decision item={item} onOpenChat={onOpenChat} onLater={onLater} />
    );
    const article = container.querySelector<HTMLElement>('article')!;
    expect(fireEvent.keyDown(article, { key: 'a' })).toBe(false);
    expect(fireEvent.keyDown(article, { key: 'o' })).toBe(false);
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(article, { key: 'l' })).toBe(false);
    expect(onLater).toHaveBeenCalledTimes(1);
    // A letter the card doesn't use still goes on to the agent keys.
    expect(fireEvent.keyDown(article, { key: 'x' })).toBe(true);
  });
});
