/**
 * One agent's own level on the desk: the editor's slider (the one control,
 * saved at once, with the way back to the team's) and the row's tiny label (only when it differs from the team's).
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

  it('follows the team by default, on the same slider as everywhere', () => {
    render(<AgentLevelPicker agent={finance} />);
    expect(screen.getByRole('group', { name: 'Independence' })).toBeInTheDocument();
    expect(screen.getByText('Same as team')).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Independence' });
    expect(slider).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText(/asks before anything leaves it/)).toBeInTheDocument();
    // One control: no menu of levels.
    expect(screen.queryByRole('button', { name: /Same as team/ })).toBeNull();
  });

  it('moving the slider gives it a level of its own, saved at once', async () => {
    render(<AgentLevelPicker agent={finance} />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Independence' }), {
        key: 'ArrowRight',
      });
      await Promise.resolve();
    });
    expect(setAgentIndependence).toHaveBeenCalledWith('a1', 'full_send');
    expect(refreshAgents).toHaveBeenCalled();
  });

  it('an agent with its own level shows it, and can go back to the team', async () => {
    const own = { ...finance, independence: 'often' } as Agent;
    store.value = { loaded: true, independence: 'go_hard', agents: [own] };
    render(<AgentLevelPicker agent={own} />);
    expect(screen.getByRole('slider', { name: 'Independence' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use the team’s (Bold)' }));
      await Promise.resolve();
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
    expect(screen.getByText('Unleashed')).toBeInTheDocument();
    rerender(<AgentLevelBadge agent={{ independence: 'often' }} />);
    expect(screen.getByText('Careful')).toBeInTheDocument();
  });
});
