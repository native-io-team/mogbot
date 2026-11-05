import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard, ErrorLine, FreshHint, NoteLine } from './AgentChatItems';
import type { Agent, AgentMessage } from '../../lib/agents';

const approvalMessage: AgentMessage = {
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: { requestId: 'r1', title: 'Run a command', detail: 'npm test', status: 'pending' },
};

describe('ApprovalCard', () => {
  it('Deny is one click', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.getAllByRole('button', { name: /^deny/i })).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false, false, undefined);
  });

  it('a note for what to do instead is behind the card’s menu', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More answers' }));
    fireEvent.click(await screen.findByText('Deny with a note…'));
    const field = screen.getByRole('textbox');
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'Draft it first' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false, false, 'Draft it first');
  });

  it('gives focus back to Deny when the note is cancelled', async () => {
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More answers' }));
    fireEvent.click(await screen.findByText('Deny with a note…'));
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
  });

  it('says its place in a run of similar requests', () => {
    render(
      <ApprovalCard
        message={approvalMessage}
        agentName="Acme"
        paused={false}
        onAnswer={vi.fn()}
        series={{ index: 2, total: 3 }}
      />
    );
    expect(screen.getByText('2 of 3 similar requests')).toBeInTheDocument();
  });
});

describe('NoteLine', () => {
  it('quotes a take-over terminal’s last lines quietly, as the screen showed them', () => {
    const message = {
      id: 'n2',
      agentId: 'acme',
      ts: 1,
      kind: 'note',
      takeover: true,
      text: 'Claude Code closed after 2 seconds. The last thing it showed:\n\nTrust it?\n❯ 2. No, exit',
    } as AgentMessage;
    const { container } = render(<NoteLine message={message} />);
    expect(container.querySelector('.agent-note--takeover')).not.toBeNull();
    expect(container.querySelector('.agent-bubble')).toBeNull();
    // The sentence is a Line; the screen is one click away, not a dump in the chat.
    expect(container.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show its last screen' }));
    expect(container.querySelector('pre')?.textContent).toBe('Trust it?\n❯ 2. No, exit');
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('ErrorLine', () => {
  it('quotes an older build’s take-over error as the screen showed it', () => {
    const message = {
      id: 'e2',
      agentId: 'acme',
      ts: 1,
      kind: 'error',
      takeover: true,
      text: 'Claude Code closed after 2 seconds. The last thing it showed:\n\nTrust it?\n❯ 2. No, exit',
    } as AgentMessage;
    const { container } = render(<ErrorLine message={message} />);
    expect(
      screen.getByText('Claude Code closed after 2 seconds. The last thing it showed:')
    ).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('Trust it?\n❯ 2. No, exit');
  });

  it('schedules one retry at the reset however fast the second click comes', async () => {
    let finish = () => {};
    const onRetryAt = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const message: AgentMessage = {
      id: 'e1',
      agentId: 'acme',
      ts: Date.now(),
      kind: 'error',
      text: 'Usage limit reached',
      failure: { kind: 'usage_limit', resetsAt: Date.now() + 3_600_000 },
    };
    render(<ErrorLine message={message} onRetry={vi.fn()} onRetryAt={onRetryAt} />);
    const button = screen.getByRole('button', { name: /retry at/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRetryAt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Scheduling…' })).toBeDisabled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /retry at/i })).toBeEnabled();
  });
});

describe('Start fresh', () => {
  const note = (fresh: boolean): AgentMessage => ({
    id: 'n1',
    agentId: 'acme',
    ts: Date.now(),
    kind: 'note',
    text: 'Started fresh · memory kept',
    fresh,
  });
  const agent = (over: Partial<Agent>): Agent =>
    ({
      id: 'acme',
      name: 'Acme',
      status: { state: 'idle', activity: null, since: null },
      ...over,
    }) as Agent;

  it('draws the fresh start as a divider, and other notes as notes', () => {
    const { rerender } = render(<NoteLine message={note(true)} />);
    expect(screen.getByRole('separator', { name: 'Started fresh · memory kept' })).toBeVisible();
    rerender(<NoteLine message={note(false)} />);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('suggests it only from a reported reading that is nearly full, and only while idle', () => {
    const onStartFresh = vi.fn();
    const full = { context: { used: 174_000, window: 200_000, at: 1 } };
    const { rerender, container } = render(
      <FreshHint agent={agent(full)} onStartFresh={onStartFresh} />
    );
    expect(container).toHaveTextContent(
      'This conversation is getting long — Acme may lose track of early details.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh (memory is kept)' }));
    expect(onStartFresh).toHaveBeenCalledTimes(1);

    // Nothing reported: nothing shown, never a guess.
    rerender(<FreshHint agent={agent({})} onStartFresh={onStartFresh} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <FreshHint
        agent={agent({ context: { used: 100_000, window: 200_000, at: 1 } })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <FreshHint
        agent={agent({ ...full, status: { state: 'working', activity: null, since: 1 } })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
    // Driven by hand: Start fresh can't run, so it isn't offered.
    rerender(
      <FreshHint
        agent={agent({
          ...full,
          takeover: { ptySession: 'p', cli: 'claude', since: 1 } as unknown as Agent['takeover'],
        })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
