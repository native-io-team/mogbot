/**
 * A card whose payload the desk can't read (an older or newer build, a bug in
 * one of its parts) must never blank the chat, and a request must stay
 * answerable: a request card that fails to draw still offers Deny, never
 * Allow, so the turn waiting on it isn't stuck.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { ApprovalFallback } from './AgentApprovalFallback';
import { ResultCardView } from './AgentResult';
import { guardRow } from './AgentsErrorBoundary';
import type { AgentMessage } from '../../lib/agents';

const logError = vi.hoisted(() => vi.fn());
vi.mock('../../lib/logger', () => ({
  logger: { logError, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  cleanup();
  logError.mockClear();
  vi.restoreAllMocks();
});

function approval(extra: Record<string, unknown>, status = 'pending'): AgentMessage {
  return {
    id: 'm1',
    agentId: 'acme',
    ts: 1,
    kind: 'approval',
    text: '',
    approval: { requestId: 'r1', title: 'Post to Slack', detail: 'd', status, ...extra },
  } as unknown as AgentMessage;
}

// Each of these drew nothing but an exception before: a part of the card
// that arrived empty.
const malformed: [string, Record<string, unknown>][] = [
  ['a session question with no options', { prompt: { kind: 'permission' } }],
  ['a secret request with nothing in it', { secret: {} }],
  ['a settings change with no changes', { settings: {} }],
  ['a plan with no actions', { plan: {} }],
  ['an "Always allow" with no scope words', { always: {} }],
];

describe('a request card that can’t be drawn', () => {
  it.each(malformed)('%s: keeps its title and offers Deny only', async (_, extra) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approval(extra)} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.getByTestId('approval-fallback')).toBeTruthy();
    expect(screen.getByText('Post to Slack')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'approval-card' }),
      'frontend-crash'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false);
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('an answered one, or one with no readable request, offers nothing', () => {
    render(<ApprovalFallback message={approval({}, 'allowed')} onAnswer={vi.fn()} />);
    expect(screen.getByText('Post to Slack')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const garbage = { id: 'm', kind: 'approval', approval: 'nonsense' } as unknown as AgentMessage;
    render(<ApprovalFallback message={garbage} onAnswer={vi.fn()} />);
    expect(screen.getByText('A request')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a failed Deny says so and can be tried again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error('offline'));
    render(
      <ApprovalCard
        message={approval({ plan: {} })}
        agentName="Acme"
        paused={false}
        onAnswer={onAnswer}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(screen.getByText('Couldn’t deny it. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  it('a well-formed card is untouched', () => {
    render(
      <ApprovalCard message={approval({})} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    expect(screen.queryByTestId('approval-fallback')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });
});

describe('a result card that can’t be drawn', () => {
  const agent = { id: 'acme', name: 'Acme', color: 'blue' } as never;
  const cards: [string, Record<string, unknown>][] = [
    ['a file item with no file', { items: [{ kind: 'file' }] }],
    ['a checked list that is not a list', { checked: 'all of it' }],
  ];

  it.each(cards)('%s: one muted line, the lines around it still show', (_, extra) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const card = { id: 'c', version: 1, title: 'Homepage', summary: 's', ...extra };
    const m = { id: 'm2', agentId: 'acme', ts: 1, kind: 'agent', text: '', result: card };
    const rows = [
      <p key="a">before</p>,
      <ResultCardView
        key="m2"
        message={m as unknown as AgentMessage}
        card={card as never}
        agent={agent}
        newest
        onAskForChanges={vi.fn()}
      />,
      <p key="b">after</p>,
    ].map(guardRow);
    render(<div>{rows}</div>);
    expect(screen.getByText('before')).toBeTruthy();
    expect(screen.getByText('after')).toBeTruthy();
    expect(screen.getByText("This line couldn't be shown.")).toBeTruthy();
  });
});
