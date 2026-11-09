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
  ['a settings change with no changes', { settings: {} }],
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
        message={approval({ settings: {} })}
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

// These are read field by field (`lib/cardShapes`): they draw, with whatever
// was missing left out, and offer only what still makes sense.
describe('a request card with parts missing', () => {
  const answerless: [string, Record<string, unknown>][] = [
    ['a secret request with nothing in it', { secret: {} }],
    ['a secret request whose fields have no variable', { secret: { fields: [{ label: 'Key' }] } }],
    ['a secret request whose fields are not a list', { secret: { name: 'x', fields: 'key' } }],
    ['a plan with no actions', { plan: {} }],
    ['a plan whose actions are not a list', { plan: { actions: 'push it' } }],
    ['a plan whose actions have no summary', { plan: { actions: [{ target: 'repo' }, null] } }],
  ];

  it.each(answerless)('%s: draws, and offers Deny but nothing to allow', async (_, extra) => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approval(extra)} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.queryByTestId('approval-fallback')).toBeNull();
    expect(logError).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /allow|save/i })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer.mock.calls[0].slice(0, 2)).toEqual(['r1', false]);
  });

  it('a plan keeps its readable actions and drops the rest', () => {
    const plan = {
      actions: [{ summary: 'Push main', target: 'acme/site', kind: 9 }, 'junk', { target: 'x' }],
      why: 42,
    };
    render(
      <ApprovalCard
        message={approval({ plan })}
        agentName="Acme"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getByText('Push main')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('a secret keeps its readable fields and can be saved', () => {
    const secret = { name: 'crm', fields: [{ env: 'CRM_KEY' }, { label: 'no env' }, 7] };
    render(
      <ApprovalCard
        message={approval({ secret })}
        agentName="Acme"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getAllByText('CRM_KEY')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('a result card with parts missing or odd', () => {
  const agent = { id: 'acme', name: 'Acme', color: 'blue' } as never;
  const cards: [string, Record<string, unknown>][] = [
    ['a file item with no file', { items: [{ kind: 'file' }] }],
    ['a checked list that is not a list', { checked: 'all of it' }],
    ['items that are not a list', { items: { kind: 'link' } }],
    ['a test report with nonsense steps', { test: { outcome: 'x', steps: [null, 3] } }],
    ['no title or summary', { title: null, summary: { a: 1 } }],
    ['a version that is not a number', { version: 'two' }],
  ];

  it.each(cards)('%s: draws without its fallback', (_, extra) => {
    const card = { id: 'c', version: 1, title: 'Homepage', summary: 's', ...extra };
    const m = { id: 'm2', agentId: 'acme', ts: 1, kind: 'agent', text: '', result: card };
    render(
      <div>
        {[
          <ResultCardView
            key="m2"
            message={m as unknown as AgentMessage}
            card={card as never}
            agent={agent}
            newest
            onAskForChanges={vi.fn()}
          />,
        ].map(guardRow)}
      </div>
    );
    expect(screen.queryByText("This line couldn't be shown.")).toBeNull();
    expect(screen.getByRole('article')).toBeTruthy();
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('a row that can’t be drawn', () => {
  function Throws(): never {
    throw new Error('bad row');
  }

  it('one muted line, the lines around it still show', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [<p key="a">before</p>, <Throws key="m2" />, <p key="b">after</p>].map(guardRow);
    render(<div>{rows}</div>);
    expect(screen.getByText('before')).toBeTruthy();
    expect(screen.getByText('after')).toBeTruthy();
    expect(screen.getByText("This line couldn't be shown.")).toBeTruthy();
  });
});
