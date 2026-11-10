/**
 * The phone, one screen per step: each tick is this Mac's own check, the
 * code gets its own screen, and a phone's request takes over whichever
 * screen is up, answered with a neutral Allow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PhoneStatus } from '../../lib/companion';

const getPhoneStatus = vi.hoisted(() => vi.fn());
const getTailnetPhones = vi.hoisted(() => vi.fn());
const startPairing = vi.hoisted(() => vi.fn());
const decidePairing = vi.hoisted(() => vi.fn());
const getLinkQr = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn());
vi.mock('../../lib/companion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/companion')>();
  return { ...actual, getPhoneStatus, getTailnetPhones, startPairing, decidePairing, getLinkQr };
});
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

import { PanelStepShell, PhoneFlow, prevPhoneStep, type PhoneFlowStep } from './PhoneFlow';
import { SCAN_LINE } from '../../../packages/companion-protocol/src/pairWords';
import { PHONE_APP_TESTFLIGHT_URL } from '../../lib/phoneApp';

const status = (over: Partial<PhoneStatus> = {}): PhoneStatus => ({
  enabled: true,
  running: true,
  serve: { state: 'on', url: 'https://mac.tail1.ts.net' },
  tailscale: { state: 'connected', dnsName: 'mac.tail1.ts.net', login: 'sam@example.com' },
  devices: [],
  pairing: { active: false },
  activity: {},
  methods: [],
  push: { available: false, enabled: false },
  ...over,
});

function show(step: PhoneFlowStep) {
  const go = vi.fn();
  const onDone = vi.fn();
  render(
    <PhoneFlow
      step={step}
      go={go}
      onSkip={vi.fn()}
      onDone={onDone}
      doneLabel="Done"
      render={(s, view) => <PanelStepShell step={s} view={view} />}
    />
  );
  return { go, onDone };
}

describe('PhoneFlow', () => {
  beforeEach(() => {
    getPhoneStatus.mockReset().mockResolvedValue(status());
    getTailnetPhones.mockReset().mockResolvedValue([]);
    startPairing.mockReset().mockResolvedValue({
      link: 'x://pair?d=1',
      qr: { size: 21, modules: '0'.repeat(441) },
      expiresAt: Date.now() + 300_000,
    });
    decidePairing.mockReset().mockResolvedValue(undefined);
    getLinkQr.mockReset().mockResolvedValue({ size: 21, modules: '0'.repeat(441) });
    openUrl.mockReset().mockResolvedValue(undefined);
  });

  it('asks for the app on the person’s word, never a tick', () => {
    const { go } = show('phoneGetApp');
    expect(screen.queryByText(/Done\./)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I have it' }));
    expect(go).toHaveBeenCalledWith('phoneMacTailscale');
  });

  it('offers TestFlight as the big button with a code of its link', async () => {
    show('phoneGetApp');
    fireEvent.click(screen.getByRole('button', { name: /Get it on TestFlight/ }));
    expect(openUrl).toHaveBeenCalledWith(PHONE_APP_TESTFLIGHT_URL);
    expect(
      await screen.findByRole('img', { name: 'Code for the phone app on TestFlight' })
    ).toBeInTheDocument();
    expect(getLinkQr).toHaveBeenCalledWith(PHONE_APP_TESTFLIGHT_URL);
  });

  it('ticks Tailscale on this Mac from its own status, with the account', async () => {
    show('phoneMacTailscale');
    expect(await screen.findByText(/signed in as sam@example\.com/)).toBeInTheDocument();
  });

  it('names the Mac’s account for the phone, and ticks when a phone is on the tailnet', async () => {
    getTailnetPhones.mockResolvedValue([{ name: 'Sam’s iPhone', os: 'ios', online: true }]);
    show('phonePhoneTailscale');
    expect(await screen.findByText(/sign in as sam@example\.com/)).toBeInTheDocument();
    expect(await screen.findByText(/Sam’s iPhone is on your Tailscale/)).toBeInTheDocument();
  });

  it('shows the code alone with the phone’s own words', async () => {
    show('phoneScan');
    expect(await screen.findByRole('heading', { name: SCAN_LINE })).toBeInTheDocument();
    await waitFor(() => expect(startPairing).toHaveBeenCalledTimes(1));
  });

  it('a request takes the screen; Allow is the neutral answer and ends on Paired', async () => {
    getPhoneStatus.mockResolvedValue(
      status({
        pairing: {
          active: true,
          request: {
            id: 'r1',
            device: { name: 'Sam’s iPhone', platform: 'ios', appVersion: '1.0', build: 'official' },
            requestedAt: Date.now(),
            codeHint: 'K7Q2',
            replaces: [],
          },
        },
      })
    );
    const { go } = show('phoneAllow');
    const allow = await screen.findByRole('button', { name: 'Allow' });
    expect(allow.className).toMatch(/strong/);
    expect(allow.className).not.toMatch(/primary/);
    fireEvent.click(allow);
    await waitFor(() => expect(decidePairing).toHaveBeenCalledWith('r1', true, []));
    await waitFor(() => expect(go).toHaveBeenCalledWith('phonePaired'));
  });

  it('Back from an answer goes to the code', () => {
    expect(prevPhoneStep('phoneAllow')).toBe('phoneScan');
    expect(prevPhoneStep('phoneMacTailscale')).toBe('phoneGetApp');
    expect(prevPhoneStep('phoneGetApp')).toBeNull();
  });
});
