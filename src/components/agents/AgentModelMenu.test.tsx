/**
 * The conversation menu's model and effort: the effort is offered on either
 * engine, the current one ticked, and a pick saved as the agent's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Agent } from '../../lib/agents';

const updateAgent = vi.hoisted(() => vi.fn((_id: string, _change: unknown) => Promise.resolve()));
vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  updateAgent,
}));
const refreshAgents = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents,
  useAgentsSelector: (select: (s: unknown) => unknown) =>
    select({
      engines: [
        {
          id: 'claude',
          label: 'Claude Code',
          installed: true,
          signedIn: true,
          asks: true,
          models: [
            { value: 'opus', label: 'Opus' },
            { value: 'haiku', label: 'Haiku' },
          ],
        },
      ],
    }),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

import { AgentModelItems } from './AgentModelMenu';

const finance = { id: 'a1', name: 'Finance', engine: 'claude', model: 'opus' } as Agent;

describe('AgentModelItems effort', () => {
  beforeEach(() => {
    updateAgent.mockClear();
  });

  it('offers the engine’s default and three levels, and saves a pick', async () => {
    render(<AgentModelItems agent={{ ...finance, effort: 'medium' }} />);
    expect(screen.getByText('Effort · how hard it thinks')).toBeInTheDocument();
    for (const level of ['Low', 'Medium', 'High']) {
      expect(screen.getByRole('menuitem', { name: level })).toBeInTheDocument();
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'High' }));
      await Promise.resolve();
    });
    expect(updateAgent).toHaveBeenCalledWith('a1', { effort: 'high' });
  });

  it('picking the level it already has saves nothing; default clears it', async () => {
    render(<AgentModelItems agent={{ ...finance, effort: 'high' }} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'High' }));
    expect(updateAgent).not.toHaveBeenCalled();
    const defaults = screen.getAllByRole('menuitem', { name: 'Engine’s default' });
    await act(async () => {
      // The second "Engine's default" is the effort's (the first, the model's).
      fireEvent.click(defaults[defaults.length - 1]);
      await Promise.resolve();
    });
    expect(updateAgent).toHaveBeenCalledWith('a1', { effort: '' });
  });
});

describe('AgentModelItems routines', () => {
  it('heads the section like the others and says what Automatic comes to beside it', () => {
    const repeating = { id: 'r', note: 'x', nextAt: 0, createdAt: 0, paused: false, repeat: {} };
    render(
      <AgentModelItems
        agent={{ ...finance, model: null, checkIns: [repeating] } as unknown as Agent}
      />
    );
    // Never "Routines run on Fastest" above a ticked "Automatic".
    expect(screen.getByText('Routines · the model they wake on')).toBeInTheDocument();
    expect(screen.queryByText(/^Routines run on/)).toBeNull();
    expect(screen.getByRole('menuitem', { name: /^Automatic/ })).toHaveTextContent('Fastest');
  });
});
