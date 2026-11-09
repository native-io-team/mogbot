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
    setIndependence.mockReset().mockImplementation((l: string) => Promise.resolve(l));
    refreshAgents.mockClear();
    showToast.mockClear();
    store.value = { loaded: true, independence: null };
  });

  const slider = () => screen.getByRole('slider', { name: 'How much it does on its own' });
  const stop = (name: string) =>
    document.querySelector(`.independence-slider__stop[data-level="${name}"]`) as HTMLElement;

  it('a Mac that sends no level shows the default, its line, and the line that always holds', () => {
    render(<AgentIndependenceSettings />);
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
    expect(slider()).toHaveAttribute(
      'aria-valuetext',
      'Steady. Reads and edits; asks before running changes or anything leaving this Mac.'
    );
    expect(screen.getByText('Asks a lot')).toBeInTheDocument();
    expect(screen.getByText('Just does it')).toBeInTheDocument();
    for (const name of ['Careful', 'Steady', 'Bold', 'Unleashed']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'Always asks before spending money, using your passwords, or deleting for good.'
      )
    ).toBeInTheDocument();
  });

  it('shows the saved level and saves a click on a stop', async () => {
    store.value = { loaded: true, independence: 'often' };
    render(<AgentIndependenceSettings />);
    expect(slider()).toHaveAttribute('aria-valuenow', '0');
    expect(
      screen.getByText('Reads and looks around; asks before bigger changes.')
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(stop('go_hard'));
      await Promise.resolve();
    });
    expect(setIndependence).toHaveBeenCalledWith('go_hard');
    expect(refreshAgents).toHaveBeenCalled();
    // Clicking the one already chosen writes nothing.
    setIndependence.mockClear();
    await act(async () => {
      fireEvent.click(stop('often'));
      await Promise.resolve();
    });
    expect(setIndependence).not.toHaveBeenCalled();
  });

  it('moves one stop per arrow key, holds at the ends, and jumps with Home and End', async () => {
    store.value = { loaded: true, independence: 'judgement' };
    render(<AgentIndependenceSettings />);
    await act(async () => {
      fireEvent.keyDown(slider(), { key: 'ArrowRight' });
      await Promise.resolve();
    });
    expect(setIndependence).toHaveBeenLastCalledWith('go_hard');
    await act(async () => {
      fireEvent.keyDown(slider(), { key: 'End' });
      await Promise.resolve();
    });
    expect(setIndependence).toHaveBeenLastCalledWith('full_send');
    setIndependence.mockClear();
    store.value = { loaded: true, independence: 'often' };
    render(<AgentIndependenceSettings />);
    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole('slider')[1], { key: 'ArrowLeft' });
      await Promise.resolve();
    });
    expect(setIndependence).not.toHaveBeenCalled();
  });

  it('offers Unleashed, with what it still stops for', () => {
    store.value = { loaded: true, independence: 'full_send' };
    render(<AgentIndependenceSettings />);
    expect(slider()).toHaveAttribute('aria-valuenow', '3');
    expect(
      screen.getByText(/only stops for money, logins, deleting for good or going live/)
    ).toBeInTheDocument();
  });

  it('a failed save says why and goes back to what is saved', async () => {
    store.value = { loaded: true, independence: 'judgement' };
    setIndependence.mockRejectedValue({ type: 'Other', message: 'Disk full' });
    render(<AgentIndependenceSettings />);
    await act(async () => {
      fireEvent.click(stop('go_hard'));
      await Promise.resolve();
    });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Disk full'), 'error');
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
  });

  it('two quick presses: the first save finishing never snaps the slider back', async () => {
    store.value = { loaded: true, independence: 'often' };
    const pending: Array<() => void> = [];
    setIndependence.mockImplementation(
      (l: string) => new Promise((resolve) => pending.push(() => resolve(l)))
    );
    render(<AgentIndependenceSettings />);
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    expect(setIndependence).toHaveBeenLastCalledWith('go_hard');
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    // The first (Steady) answers while Bold is still saving.
    await act(async () => {
      pending[0]();
      await Promise.resolve();
    });
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    expect(refreshAgents).not.toHaveBeenCalled();
    store.value = { loaded: true, independence: 'go_hard' };
    await act(async () => {
      pending[1]();
      await Promise.resolve();
    });
    expect(refreshAgents).toHaveBeenCalledTimes(1);
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
  });

  it('says how many agents are set on their own, only when any are', () => {
    render(<AgentIndependenceSettings />);
    expect(screen.queryByText(/Agents set on their own/)).not.toBeInTheDocument();
    store.value = {
      loaded: true,
      independence: 'go_hard',
      agents: [{ independence: 'full_send' }, {}, { independence: 'often' }],
    } as typeof store.value;
    render(<AgentIndependenceSettings />);
    expect(screen.getByText('Agents set on their own: 2')).toBeInTheDocument();
  });
});
