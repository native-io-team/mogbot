/**
 * Settings → Agents, "Disk space": hidden while nothing needs saying, each
 * large agent home with Free up space, and what that did in its own words.
 * Fictional agents only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ diskOverview: vi.fn(), freeUpAgentHome: vi.fn() }));
vi.mock('../../lib/agentsDisk', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentsDisk')>()),
  ...api,
}));

import { AgentsDiskSettings } from './AgentsDiskSettings';
import type { DiskOverview } from '../../lib/agentsDisk';
import { requestSettingsSectionOnOpen } from '../../lib/settings';

const FLOOR: DiskOverview = {
  freeBytes: 1_800_000_000,
  level: 'floor',
  lowBytes: 15e9,
  floorBytes: 5e9,
  homes: [
    { agentId: 'ops', name: 'Fictional Ops', bytes: 39.4e9, regenerableBytes: 37.2e9 },
    { agentId: 'notes', name: 'Fictional Notes', bytes: 1.4e9, regenerableBytes: 0 },
  ],
};
const FINE: DiskOverview = { ...FLOOR, freeBytes: 200e9, level: 'fine', homes: [] };

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('AgentsDiskSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says nothing while disk is fine and no home is large', async () => {
    api.diskOverview.mockResolvedValue(FINE);
    const { container } = render(<AgentsDiskSettings />);
    await flush();
    expect(container.textContent).toBe('');
  });

  it('opened from ⌘K with nothing to do, it still answers', async () => {
    api.diskOverview.mockResolvedValue(FINE);
    requestSettingsSectionOnOpen('agent-disk');
    render(<AgentsDiskSettings />);
    await flush();
    expect(screen.getByText('Disk space')).toBeTruthy();
    expect(
      screen.getByText('This Mac has 200 GB free. No agent’s folder is 1 GB or more.')
    ).toBeTruthy();
  });

  it('shows free space, each large home, and Free up space only where it frees something', async () => {
    api.diskOverview.mockResolvedValue(FLOOR);
    render(<AgentsDiskSettings />);
    await flush();
    expect(
      screen.getByText(
        'This Mac has 1.8 GB free. Agents ask before installing packages or cloning.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('Its folder uses 39 GB, 37 GB of it in dependency and build folders.')
    ).toBeTruthy();
    expect(screen.getByText('Its folder uses 1.4 GB.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Free up space/ })).toHaveLength(1);
  });

  it('frees one home and says what it did', async () => {
    api.diskOverview.mockResolvedValueOnce(FLOOR).mockResolvedValueOnce({
      ...FINE,
      homes: [{ ...FLOOR.homes[0], bytes: 2.2e9, regenerableBytes: 0 }],
    });
    api.freeUpAgentHome.mockResolvedValue({ bytes: 37.2e9, removed: 41, kept: 1, busy: false });
    render(<AgentsDiskSettings />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Free up space/ }));
    await flush();
    expect(api.freeUpAgentHome).toHaveBeenCalledWith('ops');
    expect(screen.getByText('Freed 37 GB. Left 1 alone: git doesn’t ignore it.')).toBeTruthy();
    expect(screen.queryByText(/This Mac has/)).toBeNull();
  });
});
