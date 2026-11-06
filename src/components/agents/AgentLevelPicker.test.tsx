/**
 * One agent's own level on the desk: the editor's picker (team first, saved
 * at once) and the row's tiny label (only when it differs from the team's).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Agent } from '../../lib/agents';

const setAgentIndependence = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../lib/agentIndependence', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentIndependence')>()),
  setAgentIndependence,
}));
const refreshAgents = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const store = vi.hoisted(() => ({
  value: { loaded: true, independence: 'go_hard', agents: [] as unknown[] },
}));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents,
  useAgentsSelector: (select: (s: unknown) => unknown) => select(store.value),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', () => ({ useOptionalToast: () => ({ showToast }) }));

import { AgentLevelBadge, AgentLevelPicker } from './AgentLevelPicker';

const finance = { id: 'a1', name: 'Finance' } as Agent;

describe('AgentLevelPicker', () => {
  beforeEach(() => {
    setAgentIndependence.mockClear();
    refreshAgents.mockClear();
    store.value = { loaded: true, independence: 'go_hard', agents: [finance] };
  });

  it('follows the team by default, naming the team’s level', () => {
    render(<AgentLevelPicker agent={finance} />);
    expect(screen.getByRole('group', { name: 'How much it does on its own' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Same as team (Go hard)' })).toBeInTheDocument();
    expect(screen.getByText(/try every way they have/)).toBeInTheDocument();
  });

  it('offers the team first, then the four levels, and saves a pick at once', async () => {
    render(<AgentLevelPicker agent={finance} />);
    fireEvent.click(screen.getByRole('button', { name: 'Same as team (Go hard)' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Same as team (Go hard)',
      'Check with me often',
      'Use good judgement',
      'Go hard — get it done',
      'Full send — let it rip',
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Full send — let it rip' }));
      await Promise.resolve();
    });
    expect(setAgentIndependence).toHaveBeenCalledWith('a1', 'full_send');
    expect(refreshAgents).toHaveBeenCalled();
  });

  it('an agent with its own level shows it, and can go back to the team', async () => {
    const own = { ...finance, independence: 'often' } as Agent;
    store.value = { loaded: true, independence: 'go_hard', agents: [own] };
    render(<AgentLevelPicker agent={own} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check with me often' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Same as team (Go hard)' }));
    });
    expect(setAgentIndependence).toHaveBeenCalledWith('a1', 'team');
  });
});

describe('AgentLevelBadge', () => {
  it('shows only when an agent differs from the team', () => {
    store.value = { loaded: true, independence: 'go_hard', agents: [] };
    const { rerender, container } = render(<AgentLevelBadge agent={{}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AgentLevelBadge agent={{ independence: 'go_hard' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AgentLevelBadge agent={{ independence: 'full_send' }} />);
    expect(screen.getByText('Full send')).toBeInTheDocument();
    rerender(<AgentLevelBadge agent={{ independence: 'often' }} />);
    expect(screen.getByText('Checks often')).toBeInTheDocument();
  });
});
