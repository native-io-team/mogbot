import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhoneSetupSteps } from './PhoneSetupSteps';
import { phoneStep, type PhoneStatus } from '../../lib/companion';

const status = (over: Partial<PhoneStatus> = {}): PhoneStatus => ({
  enabled: false,
  running: false,
  serve: { state: 'off' },
  tailscale: { state: 'connected', dnsName: 'mac.tail1.ts.net', login: 'julian@example.com' },
  devices: [],
  pairing: { active: false },
  activity: {},
  methods: [],
  push: { available: false, enabled: false },
  ...over,
});

function show(s: PhoneStatus, haveApp = false) {
  const handlers = { onHaveApp: vi.fn(), onEnable: vi.fn(), onRetry: vi.fn() };
  render(
    <PhoneSetupSteps status={s} step={phoneStep(s)} busy={null} haveApp={haveApp} {...handlers} />
  );
  return handlers;
}

const steps = () => screen.getAllByRole('listitem');

describe('PhoneSetupSteps', () => {
  it('ticks only what this Mac can see: its own Tailscale', () => {
    show(status());
    const done = steps().filter((li) => li.hasAttribute('data-done'));
    expect(done.map((li) => li.querySelector('h3')?.textContent)).toEqual([
      'Tailscale on this MacDone',
    ]);
  });

  it('says the phone app step is done on the user’s word, not as a check', () => {
    show(status(), true);
    expect(steps()[0].textContent).toMatch(/You said done/);
  });

  it('gives each step its one button, and turning on is step 4', () => {
    const { onEnable, onHaveApp } = show(status());
    fireEvent.click(screen.getByRole('button', { name: 'I have it' }));
    expect(onHaveApp).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on phone access' }));
    expect(onEnable).toHaveBeenCalled();
    expect(steps()[2].textContent).toMatch(/sign in as julian@example\.com/);
  });

  it('points the HTTPS switch at Tailscale, then checks again', () => {
    const { onRetry } = show(
      status({
        enabled: true,
        running: true,
        serve: { state: 'needsApproval', url: 'https://login.tailscale.com/f/serve' },
      })
    );
    expect(screen.getByRole('button', { name: /Open Tailscale/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I’ve switched it on' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('waits on this Mac’s Tailscale rather than offering to turn on twice', () => {
    show(status({ enabled: true, running: true, tailscale: { state: 'notInstalled' } }));
    expect(screen.getByRole('button', { name: /Get Tailscale for Mac/ })).toBeTruthy();
    expect(steps()[3].textContent).toMatch(/Waiting for Tailscale on this Mac/);
  });
});

/**
 * Step 1, "Get the app", in each kind of build: an App Store link when there
 * is one, a build on this Mac when that's possible, otherwise a plain line,
 * never a button into nothing.
 */
describe('PhoneSetupSteps: getting the app', () => {
  const base = { onHaveApp: vi.fn(), onEnable: vi.fn(), onRetry: vi.fn() };
  const s = status();

  it('links to the App Store when the page is known, ahead of a build here', async () => {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    render(
      <PhoneSetupSteps
        status={s}
        step={phoneStep(s)}
        busy={null}
        haveApp={false}
        storeUrl="https://apps.apple.com/app/id1"
        onInstall={vi.fn()}
        {...base}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Get it on the App Store/ }));
    expect(openUrl).toHaveBeenCalledWith('https://apps.apple.com/app/id1');
    expect(screen.queryByRole('button', { name: 'Get the app…' })).not.toBeInTheDocument();
  });

  it('offers the build on this Mac with no store page', () => {
    const onInstall = vi.fn();
    render(
      <PhoneSetupSteps
        status={s}
        step={phoneStep(s)}
        busy={null}
        haveApp={false}
        storeUrl={null}
        onInstall={onInstall}
        {...base}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Get the app…' }));
    expect(onInstall).toHaveBeenCalled();
  });

  it('says the app isn’t out yet when this build can’t get it', async () => {
    const { PHONE_APP_NOT_OUT } = await import('../../lib/phoneApp');
    const { TESTFLIGHT_URL } = await import('../../lib/companionInstall');
    render(
      <PhoneSetupSteps
        status={s}
        step={phoneStep(s)}
        busy={null}
        haveApp={false}
        storeUrl={null}
        {...base}
      />
    );
    if (!TESTFLIGHT_URL) expect(screen.getByText(PHONE_APP_NOT_OUT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I have it' })).toBeInTheDocument();
  });
});
