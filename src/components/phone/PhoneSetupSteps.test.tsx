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
