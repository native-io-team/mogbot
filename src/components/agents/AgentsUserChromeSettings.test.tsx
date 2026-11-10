import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentsUserChromeSettings } from './AgentsUserChromeSettings';
import {
  USER_CHROME_CONNECTED,
  currentStep,
  managedAdvice,
  routeLine,
  routeWhy,
  setupSteps,
  userChromeLine,
  type ChromeProfile,
  type UserChromeStatus,
} from '../../lib/userChrome';
import { ToastContext } from '../../contexts/ToastContext';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));

const STEPS = {
  chrome: true,
  host: true,
  files: true,
  developerMode: null,
  loadedIn: null,
  turnedOff: false,
  otherFolder: false,
  connected: false,
};

const status = (over: Partial<UserChromeStatus> = {}): UserChromeStatus => ({
  supported: true,
  enabled: true,
  listening: true,
  error: null,
  chromeInstalled: true,
  host: 'current',
  // Developer mode on already: the extension step is the one to do.
  steps: { ...STEPS, developerMode: 'Personal' },
  extensionDir: '/x',
  extensionVersion: '0.1.0',
  webStoreUrl: null,
  extensionId: 'id',
  browsers: [],
  updateNeeded: false,
  management: { machine: [], profiles: [] },
  route: { route: 'claude_in_chrome', why: 'your_chrome_not_connected' },
  ...over,
});

const work: ChromeProfile = {
  dir: 'Profile 1',
  name: 'Work',
  domain: 'example.com',
  managed: true,
  lastUsed: true,
};
const personal: ChromeProfile = {
  dir: 'Default',
  name: 'Personal',
  managed: false,
  lastUsed: false,
};

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
    invoke.mockResolvedValue(
      status({ chromeInstalled: false, host: 'missing', steps: { ...STEPS, host: false } })
    );
    render(<AgentsUserChromeSettings />);
    expect(
      await screen.findByText(/Install Google Chrome on this Mac, then come back/)
    ).toBeTruthy();
    expect(screen.getByText(/Press Set it up again/)).toBeTruthy();
    // Installing Chrome comes first: no buttons for later steps yet.
    expect(screen.queryByRole('button', { name: 'Open Chrome’s extensions' })).toBeNull();
  });

  it('numbers the steps and gives buttons only to the one to do now', async () => {
    invoke.mockResolvedValue(status({ steps: STEPS }));
    render(<AgentsUserChromeSettings />);
    const list = await screen.findByRole('list', { name: 'Steps to connect your Chrome' });
    const items = Array.from(list.querySelectorAll('li'));
    expect(items.map((li) => li.getAttribute('data-step'))).toEqual([
      'host',
      'developerMode',
      'load',
      'connect',
    ]);
    expect(items[0].querySelector('[aria-label="Done"]')).toBeTruthy();
    expect(items[1].getAttribute('aria-current')).toBe('step');
    expect(items[1].querySelectorAll('button')).toHaveLength(1);
    expect(items[2].querySelectorAll('button')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open Chrome’s extensions' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_user_chrome_open_extensions_page')
    );
  });

  it('shows the folder in Finder for dragging onto Chrome', async () => {
    invoke.mockResolvedValue(status());
    render(<AgentsUserChromeSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the folder in Finder' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('agents_user_chrome_show_extension'));
  });

  it('copies the folder path for Load unpacked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    invoke.mockResolvedValue(status({ extensionDir: '/Users/you/Library/App/chrome-extension' }));
    render(<AgentsUserChromeSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy folder path' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('/Users/you/Library/App/chrome-extension')
    );
  });

  it('says Connected once the extension appears, with no buttons left', async () => {
    const showToast = vi.fn();
    invoke.mockResolvedValue(status());
    render(
      <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: () => {} }}>
        <AgentsUserChromeSettings />
      </ToastContext.Provider>
    );
    await screen.findByRole('button', { name: 'Copy folder path' });
    expect(showToast).not.toHaveBeenCalled();
    // Load unpacked: the next read finds it connected.
    invoke.mockResolvedValue(
      status({
        browsers: [{ profileId: 'p', label: '', extensionVersion: '0.1.0', connectedAt: 1 }],
      })
    );
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(USER_CHROME_CONNECTED, 'success'));
    expect(screen.getByText(/^Connected \(extension 0\.1\.0\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy folder path' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Steps to connect your Chrome' })).toBeNull();
    // Once only.
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('opening the page already connected says nothing', async () => {
    const showToast = vi.fn();
    invoke.mockResolvedValue(
      status({
        browsers: [{ profileId: 'p', label: '', extensionVersion: '0.1.0', connectedAt: 1 }],
      })
    );
    render(
      <ToastContext.Provider value={{ toasts: [], showToast, dismissToast: () => {} }}>
        <AgentsUserChromeSettings />
      </ToastContext.Provider>
    );
    await screen.findByText(/^Connected \(extension 0\.1\.0\)/);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('setupSteps', () => {
  const ids = (st: ReturnType<typeof setupSteps>) => st.filter((x) => x.done).map((x) => x.id);

  it('ticks each step from what was read, never from a click', () => {
    expect(ids(setupSteps(status({ steps: STEPS })))).toEqual(['host']);
    expect(ids(setupSteps(status()))).toEqual(['host', 'developerMode']);
    const loaded = setupSteps(
      status({ steps: { ...STEPS, developerMode: 'Personal', loadedIn: 'Personal' } })
    );
    expect(ids(loaded)).toEqual(['host', 'developerMode', 'load']);
    expect(currentStep(loaded)?.id).toBe('connect');
    expect(currentStep(loaded)?.line).toMatch(/press Try again/);
    const connected = setupSteps(
      status({
        browsers: [{ profileId: 'p', label: '', extensionVersion: '0.1.0', connectedAt: 1 }],
      })
    );
    expect(currentStep(connected)).toBeNull();
  });

  it('a later step done counts for the earlier ones Chrome hasn’t written yet', () => {
    // Chrome writes Developer mode a few seconds late; the extension can't
    // be in Chrome without it.
    const st = setupSteps(status({ steps: { ...STEPS, loadedIn: 'Personal' } }));
    expect(st.find((x) => x.id === 'developerMode')?.done).toBe(true);
  });

  it('an extension turned off in Chrome is not done, and says how to fix it', () => {
    const st = setupSteps(
      status({
        steps: { ...STEPS, developerMode: 'Personal', loadedIn: 'Personal', turnedOff: true },
      })
    );
    expect(currentStep(st)?.id).toBe('load');
    expect(currentStep(st)?.line).toBe(
      'Not done yet: it’s in “Personal” but turned off. Turn it on in Chrome’s extensions page.'
    );
  });

  it('a host that couldn’t start, or moved, is the step to do', () => {
    expect(currentStep(setupSteps(status({ host: 'stale' })))?.id).toBe('host');
    const err = currentStep(setupSteps(status({ error: 'Socket busy.' })));
    expect(err?.id).toBe('host');
    expect(err?.line).toBe('Not done yet: it couldn’t start (Socket busy). Press Set it up again.');
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

describe('which way agents use, and why', () => {
  it('says Your Chrome needs no sign-in on an account switch, and Claude in Chrome might', () => {
    expect(routeLine({ route: 'your_chrome', why: 'your_chrome_connected' })).toMatch(
      /any account\. Switching accounts never needs a browser sign-in/
    );
    expect(routeLine({ route: 'claude_in_chrome', why: 'your_chrome_off' })).toMatch(
      /switching accounts can mean signing in again/
    );
    expect(routeLine({ route: 'claude_in_chrome', why: 'your_chrome_not_connected' })).toMatch(
      /^Claude in Chrome for now, because Your Chrome isn’t connected/
    );
    expect(routeWhy({ route: 'none', why: 'off_for_agent' }, 'Ops')).toBe(
      'None: you took the browser away from Ops.'
    );
  });

  it('shows the route under the switch, even while Your Chrome is off', async () => {
    invoke.mockResolvedValue(
      status({ enabled: false, route: { route: 'claude_in_chrome', why: 'your_chrome_off' } })
    );
    render(<AgentsUserChromeSettings />);
    expect(await screen.findByText('Agents use now')).toBeTruthy();
    expect(screen.getByText(/tied to the Claude account signed in to its extension/)).toBeTruthy();
  });
});

describe('a Chrome profile managed by work', () => {
  it('names the managed profile and offers a personal one, or a new one', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'agents_user_chrome_status'
          ? status({ management: { machine: [], profiles: [work, personal] } })
          : 'Default'
      )
    );
    render(<AgentsUserChromeSettings />);
    expect(
      await screen.findByText(
        /This Chrome profile \(“Work”, example\.com\) is managed by your work, so it can’t add the app’s extension\. Use a personal Chrome profile for your agents’ browsing\./
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open “Personal”' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_user_chrome_open_profile', { dir: 'Default' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open a new Chrome profile' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_user_chrome_open_profile', { dir: null })
    );
  });

  it('this Mac’s policy: every profile, so no profile buttons', () => {
    const a = managedAdvice(status({ management: { machine: ['developer_mode'], profiles: [] } }));
    expect(a?.everyProfile).toBe(true);
    expect(a?.line).toMatch(/turns off Developer mode in every profile/);
  });

  it('says nothing until something says it’s in the way, then believes the user', async () => {
    expect(managedAdvice(status({ management: { machine: [], profiles: [personal] } }))).toBeNull();
    invoke.mockResolvedValue(status());
    render(<AgentsUserChromeSettings />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Developer mode greyed out in Chrome?' })
    );
    expect(await screen.findByRole('button', { name: 'Open a new Chrome profile' })).toBeTruthy();
  });

  it('a connected extension needs no advice', async () => {
    invoke.mockResolvedValue(
      status({
        management: { machine: [], profiles: [work] },
        browsers: [{ profileId: 'p', label: '', extensionVersion: '0.1.0', connectedAt: 1 }],
      })
    );
    render(<AgentsUserChromeSettings />);
    await screen.findByText(/^Connected \(extension 0\.1\.0\)/);
    expect(screen.queryByText('Chrome is managed by your work')).toBeNull();
  });
});
