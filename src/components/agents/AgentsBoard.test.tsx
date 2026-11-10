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

  it('says only the word when the reset is not known (full board)', () => {
    render(
      <AgentsBoard
        agents={[agent('n', 'Native App', { failure: { kind: 'usage_limit' } } as Partial<Agent>)]}
        onOpenAgent={() => {}}
      />
    );
    expect(document.querySelector('.agents-board__state')?.textContent).toBe('Paused');
  });
});

describe('the quiet board (everyone else in What’s in flight)', () => {
  it('names each key with what it last said, since the line is not on the page', () => {
    const open = vi.fn();
    render(
      <AgentsBoard
        variant="quiet"
        label="Everyone else"
        agents={[
          agent('r', 'Research', { preview: 'Two competitors changed pricing.' } as Partial<Agent>),
          agent('x', 'Quiet'),
        ]}
        onOpenAgent={open}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Research. Two competitors changed pricing.' })
    );
    expect(open).toHaveBeenCalledWith('r');
    expect(screen.getByRole('button', { name: 'Quiet' })).toBeInTheDocument();
    // No wall of cut-short previews: only the names are on the page.
    expect(document.querySelector('.agents-board__state')).toBeNull();
    expect(screen.queryByText('Two competitors changed pricing.')).toBeNull();
  });

  it('says a paused key’s return under its name, and its bound letter', () => {
    render(
      <AgentsBoard
        variant="quiet"
        agents={[
          agent('n', 'Native App', {
            failure: { kind: 'usage_limit' },
            boundKey: 'N',
          } as Partial<Agent>),
        ]}
        onOpenAgent={() => {}}
      />
    );
    expect(document.querySelector('.agents-board__news')?.textContent).toBe('Paused');
    const key = screen.getByRole('button', { name: 'Native App. Paused' });
    expect(key).toHaveAttribute('aria-keyshortcuts', 'N');
    expect(key.querySelector('.agents-board__bound')?.textContent).toBe('N');
  });
});
