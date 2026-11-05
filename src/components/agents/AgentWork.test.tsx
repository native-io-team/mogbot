import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentBubble, WorkingIndicator } from './AgentChatItems';
import type { Agent, AgentMessage, TurnWork } from '../../lib/agents';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const agent = { id: 'acme', name: 'Acme', home: '/h/acme', status: { state: 'idle' } } as Agent;

const work: TurnWork = {
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 6 * 60_000,
  stepCount: 3,
  fileCount: 1,
  files: ['Hero.tsx'],
  steps: [
    { at: 1_000_000 + 2_000, kind: 'read', label: 'Read Hero.tsx' },
    { at: 1_000_000 + 40_000, kind: 'edit', label: 'Edited Hero.tsx' },
    { at: 1_000_000 + 75_000, kind: 'command', label: 'Ran npm test' },
  ],
};

const reply = (w?: TurnWork): AgentMessage => ({
  id: 'r1',
  agentId: 'acme',
  ts: 1_000_000 + 6 * 60_000,
  kind: 'agent',
  text: 'Done: the hero is fixed.',
  work: w,
});

describe('the timeline under a reply', () => {
  it('is one folded line of what was observed', () => {
    render(<AgentBubble message={reply(work)} agent={agent} />);
    const toggle = screen.getByRole('button', { name: 'Worked 6 min · 3 steps · edited 1 file' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Read Hero.tsx')).toBeNull();
  });

  it('opens into the steps in order, timed from the start, then folds again', () => {
    render(<AgentBubble message={reply(work)} agent={agent} />);
    const toggle = screen.getByRole('button', { name: /^Worked/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Read Hero.tsx0:02', 'Edited Hero.tsx0:40', 'Ran npm test1:15']);
    expect(screen.getByText('Hero.tsx', { exact: false, selector: 'p' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('says how many earlier steps were not kept', () => {
    render(<AgentBubble message={reply({ ...work, stepCount: 10 })} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(screen.getByText('7 earlier steps')).toBeInTheDocument();
  });

  it('is absent when the turn did nothing but reply', () => {
    render(<AgentBubble message={reply()} agent={agent} />);
    expect(screen.queryByRole('button', { name: /steps?/ })).toBeNull();
  });
});

describe('the working line, live', () => {
  const live: TurnWork = { ...work, endedAt: undefined };

  it('is still one line, with the steps so far folded beside it', () => {
    render(<WorkingIndicator activity="Running npm test" work={live} agent={agent} />);
    expect(screen.getByText('Running npm test')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '3 steps · edited 1 file' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens above the current step, which is not listed twice', () => {
    render(<WorkingIndicator activity="Running npm test" work={live} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /steps/ }));
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Read Hero.tsx0:02', 'Edited Hero.tsx0:40']);
  });

  it('without a timeline is the plain working line', () => {
    render(<WorkingIndicator activity="Thinking" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
