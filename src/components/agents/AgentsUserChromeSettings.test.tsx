import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsUserChromeSettings } from './AgentsUserChromeSettings';
import { userChromeLine, type UserChromeStatus } from '../../lib/userChrome';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));

const status = (over: Partial<UserChromeStatus> = {}): UserChromeStatus => ({
  supported: true,
  enabled: true,
  listening: true,
  error: null,
  chromeInstalled: true,
  host: 'current',
  extensionDir: '/x',
  extensionVersion: '0.1.0',
  webStoreUrl: null,
  extensionId: 'id',
  browsers: [],
  updateNeeded: false,
  ...over,
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const switchOn = () =>
  screen.getByRole('switch', { name: 'Let agents use your Chrome' }).getAttribute('aria-checked');

describe('AgentsUserChromeSettings', () => {
  beforeEach(() => invoke.mockReset());

  it('a read started before the switch never flips it back', async () => {
    // The first read answers; then a focus read is in flight, slow, with the
    // state from before the switch.
    // One profile connected, so the setup poll is off and only focus reads.
    const on = status({
      browsers: [{ profileId: 'p', label: 'Work', extensionVersion: '0.1.0', connectedAt: 0 }],
    });
    const slowRead = deferred<UserChromeStatus>();
    let reads = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'agents_user_chrome_status') {
        reads += 1;
        return reads === 1 ? slowRead.promise : Promise.resolve(status({ enabled: false }));
      }
      if (cmd === 'agents_user_chrome_set_enabled')
        return Promise.resolve(status({ enabled: false }));
      return Promise.resolve(null);
    });
    invoke.mockImplementationOnce(() => Promise.resolve(on));
    render(<AgentsUserChromeSettings />);
    await waitFor(() => expect(switchOn()).toBe('true'));

    act(() => void window.dispatchEvent(new Event('focus')));
    fireEvent.click(screen.getByRole('switch', { name: 'Let agents use your Chrome' }));
    // The stale read answers last, saying it is still on.
    await act(() => {
      slowRead.resolve(on);
      return slowRead.promise;
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_user_chrome_set_enabled', { on: false })
    );
    await waitFor(() => expect(switchOn()).toBe('false'));
    // And the switch went to the Mac after the read, not alongside it.
    const order = invoke.mock.calls.map(([c]) => c as string);
    expect(order.lastIndexOf('agents_user_chrome_set_enabled')).toBeGreaterThan(
      order.lastIndexOf('agents_user_chrome_status')
    );
  });

  it('shows the steps while on and nothing is connected', async () => {
    invoke.mockResolvedValue(status({ chromeInstalled: false, host: 'missing' }));
    render(<AgentsUserChromeSettings />);
    expect(await screen.findByText(/Install Google Chrome on this Mac first/)).toBeTruthy();
    expect(screen.getByText(/Turn Your Chrome off and on to set it up/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Chrome’s extensions' })).toBeTruthy();
  });
});

describe('userChromeLine', () => {
  it('ends an error in one full stop, never two', () => {
    expect(userChromeLine(status({ error: 'The socket folder is not writable.' }))).toBe(
      'On, but it couldn’t start: The socket folder is not writable.'
    );
    expect(userChromeLine(status({ error: 'Port in use' }))).toBe(
      'On, but it couldn’t start: Port in use.'
    );
  });
});
