import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Agent } from '../../lib/agents';
import { AgentsBoard } from './AgentsBoard';

afterEach(cleanup);

const agent = (id: string, name: string, over: Partial<Agent> = {}) =>
  ({
    id,
    name,
    role: '',
    isMain: false,
    hidden: false,
    status: { state: 'idle' },
    ...over,
  }) as Agent;

describe('the board of keys, to a screen reader', () => {
  it('names each key by its agent, then its state when that is news', () => {
    const open = vi.fn();
    render(
      <AgentsBoard
        agents={[
          agent('f', 'Finance', { status: { state: 'waiting' } } as Partial<Agent>),
          agent('w', 'Writer', { status: { state: 'working' } } as Partial<Agent>),
          agent('r', 'Research'),
        ]}
        onOpenAgent={open}
        onNewAgent={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finance, needs your OK' }));
    expect(open).toHaveBeenCalledWith('f');
    expect(screen.getByRole('button', { name: 'Writer, working' })).toBeInTheDocument();
    // Idle is not news: just the name.
    expect(screen.getByRole('button', { name: 'Research' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeInTheDocument();
  });
});

describe('a paused key', () => {
  it('says when it is back, run on from the word', () => {
    const resetsAt = Date.now() + 90 * 60_000;
    render(
      <AgentsBoard
        agents={[
          agent('n', 'Native App', {
            failure: { kind: 'usage_limit', resetsAt },
          } as Partial<Agent>),
        ]}
        onOpenAgent={() => {}}
      />
    );
    const line = document.querySelector('.agents-board__state')?.textContent ?? '';
    expect(line).toMatch(/^Paused until /);
    expect(line).not.toContain('·');
  });

  it('says only the word when the reset is not known', () => {
    render(
      <AgentsBoard
        agents={[agent('n', 'Native App', { failure: { kind: 'usage_limit' } } as Partial<Agent>)]}
        onOpenAgent={() => {}}
      />
    );
    expect(document.querySelector('.agents-board__state')?.textContent).toBe('Paused');
  });
});
