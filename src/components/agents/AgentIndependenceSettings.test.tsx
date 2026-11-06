/**
 * Settings → Agents → Independence: shows what the Mac says (the default when
 * it says nothing), saves a click for every agent, and says what always asks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const setIndependence = vi.hoisted(() => vi.fn());
vi.mock('../../lib/agentIndependence', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentIndependence')>()),
  setIndependence,
}));
const refreshAgents = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const store = vi.hoisted(() => ({ value: { loaded: true, independence: null as string | null } }));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents,
  useAgentsSelector: (select: (s: unknown) => unknown) => select(store.value),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', () => ({ useOptionalToast: () => ({ showToast }) }));

import { AgentIndependenceSettings } from './AgentIndependenceSettings';

describe('AgentIndependenceSettings', () => {
  beforeEach(() => {
    setIndependence.mockReset().mockImplementation(async (l: string) => l);
    refreshAgents.mockClear();
    showToast.mockClear();
    store.value = { loaded: true, independence: null };
  });

  it('a Mac that sends no level shows the default, and the line that always holds', () => {
    render(<AgentIndependenceSettings />);
    expect(
      screen.getByRole('radiogroup', { name: 'How much should your agents do on their own?' })
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('Use good judgement');
    expect(
      screen.getByText(
        'You’ll always be asked before anything that spends money, sends as you, or deletes.'
      )
    ).toBeInTheDocument();
  });

  it('shows the saved level and saves a click', async () => {
    store.value = { loaded: true, independence: 'often' };
    render(<AgentIndependenceSettings />);
    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('Check with me often');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Go hard/ }));
    });
    expect(setIndependence).toHaveBeenCalledWith('go_hard');
    expect(refreshAgents).toHaveBeenCalled();
    // Clicking the one already chosen writes nothing.
    setIndependence.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Check with me often/ }));
    });
    expect(setIndependence).not.toHaveBeenCalled();
  });

  it('offers Full send, with what still asks there', async () => {
    store.value = { loaded: true, independence: 'full_send' };
    render(<AgentIndependenceSettings />);
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent(
      'Full send — let it rip'
    );
    expect(screen.getByText(/Still asks before spending money/)).toBeInTheDocument();
    expect(screen.queryByText(/sends as you, or deletes/)).not.toBeInTheDocument();
  });

  it('a failed save says why and goes back to what is saved', async () => {
    store.value = { loaded: true, independence: 'judgement' };
    setIndependence.mockRejectedValue({ type: 'Other', message: 'Disk full' });
    render(<AgentIndependenceSettings />);
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Go hard/ }));
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Disk full'), 'error');
    expect(screen.getByRole('radio', { checked: true })).toHaveTextContent('Use good judgement');
  });
});
