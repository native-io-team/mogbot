import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const updateAgent = vi.fn(() => Promise.resolve());
vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  updateAgent: (...args: unknown[]) => updateAgent(...(args as [])),
}));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents: vi.fn(() => Promise.resolve()),
  useAgentsSelector: (select: (s: unknown) => unknown) =>
    select({ agents: [{ id: 'main', isMain: true, color: 'white' }] }),
}));

import { ACCENT_COMMIT_DELAY_MS, AccentColorSetting } from './AccentColorSetting';

describe('AccentColorSetting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateAgent.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('previews on arrow keys and saves once, after they rest', async () => {
    render(<AccentColorSetting />);
    const group = screen.getByRole('radiogroup', { name: 'Accent color' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });

    // Painted at once, not written yet.
    expect(screen.getByRole('radio', { checked: true }).getAttribute('data-accent-scope')).toBe(
      'orange'
    );
    expect(document.documentElement.style.getPropertyValue('--accent-user')).not.toBe('');
    expect(updateAgent).not.toHaveBeenCalled();

    await act(() => {
      vi.advanceTimersByTime(ACCENT_COMMIT_DELAY_MS);
      return Promise.resolve();
    });
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledWith('main', { color: 'orange' });
  });

  it('saves immediately on a click', async () => {
    render(<AccentColorSetting />);
    await act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
      return Promise.resolve();
    });
    expect(updateAgent).toHaveBeenCalledWith('main', { color: 'red' });
  });
});
