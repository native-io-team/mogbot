import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsBrowserSettings } from './AgentsBrowserSettings';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));

const status = (over: Record<string, unknown> = {}) => ({
  compiled: true,
  enabled: true,
  chromeInstalled: true,
  running: false,
  permissions: { screenRecording: false, accessibility: false },
  ...over,
});

describe('AgentsBrowserSettings', () => {
  beforeEach(() => invoke.mockReset());

  it('is on, says it is not your Chrome, and guides the two permissions', async () => {
    invoke.mockResolvedValue(status());
    render(<AgentsBrowserSettings />);
    expect(await screen.findByText(/not your personal one/)).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Agents’ browser' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(screen.getByText(/Google needs one sign-in at the Mac/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Allow…' })[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_agent_browser_permission', {
        which: 'screen_recording',
      })
    );
  });

  it('turns off from the switch, and hides the permissions then', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'agents_agent_browser_set_enabled' ? status({ enabled: false }) : status()
      )
    );
    render(<AgentsBrowserSettings />);
    const toggle = await screen.findByRole('switch', { name: 'Agents’ browser' });
    await screen.findByTestId('agents-browser-permissions');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_agent_browser_set_enabled', { on: false })
    );
    await waitFor(() => expect(screen.queryByTestId('agents-browser-permissions')).toBeNull());
    expect(screen.getByText(/Off\. Agents use only your own Chrome/)).toBeTruthy();
  });

  it('says when both are allowed', async () => {
    invoke.mockResolvedValue(
      status({ permissions: { screenRecording: true, accessibility: true } })
    );
    render(<AgentsBrowserSettings />);
    expect(await screen.findByText('Google sign-ins work from your phone too.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow…' })).toBeNull();
  });
});
