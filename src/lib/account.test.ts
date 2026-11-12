/**
 * Signing in (docs/relay.md, "Accounts"): asked once on first run and only
 * in a build with the relay, phone access turned on first, the check line's
 * honest states, and the phone's way in remembered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_CHOICE_KEY,
  beginSignIn,
  phoneViaRelay,
  readAccountChoice,
  readPhoneRoute,
  RELAY_CONNECT_WAIT_MS,
  saveAccountChoice,
  savePhoneRoute,
  signedInLine,
  signInCheck,
  type SignInDeps,
} from './account';
import { overrideRelayForHarness } from './brand';
import {
  isPassedOver,
  nextStep,
  prevStep,
  progressOf,
  resumeStep,
  sectionOf,
} from './onboardingFlow';
import { visibleSettingsPages, isSettingsPage, openingPage } from './settingsPages';
import type { PhoneStatus, RelayStatus } from './companion';

const status = (enabled: boolean, relay: RelayStatus): PhoneStatus =>
  ({ enabled, relay }) as unknown as PhoneStatus;

function deps(seq: PhoneStatus[], over: Partial<SignInDeps> = {}) {
  let t = 0;
  const reads = [...seq];
  const d: SignInDeps = {
    getPhoneStatus: vi.fn(() => Promise.resolve(reads.length > 1 ? reads.shift()! : reads[0])),
    setPhoneAccess: vi.fn(() =>
      Promise.resolve(status(true, { state: 'connecting', account: null }))
    ),
    signInAccount: vi.fn(() => Promise.resolve()),
    sleep: vi.fn((ms: number) => {
      t += ms;
      return Promise.resolve();
    }),
    now: () => t,
    ...over,
  };
  return d;
}

beforeEach(() => localStorage.clear());
afterEach(() => overrideRelayForHarness(null));

describe('beginSignIn', () => {
  it('turns phone access on first, waits for the relay, then opens the page', async () => {
    const d = deps([
      status(false, { state: 'off', account: null }),
      status(true, { state: 'connecting', account: null }),
      status(true, { state: 'connected', account: null }),
    ]);
    await expect(beginSignIn(d)).resolves.toBe(true);
    expect(d.setPhoneAccess).toHaveBeenCalledWith(true);
    expect(d.signInAccount).toHaveBeenCalledTimes(1);
  });

  it('leaves phone access alone when it is on and connected', async () => {
    const d = deps([status(true, { state: 'connected', account: null })]);
    await beginSignIn(d);
    expect(d.setPhoneAccess).not.toHaveBeenCalled();
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('says so when the relay never connects, and never opens the page', async () => {
    const d = deps([status(true, { state: 'connecting', account: null })]);
    await expect(beginSignIn(d)).rejects.toThrow(/Couldn’t reach the sign-in service/);
    expect(d.signInAccount).not.toHaveBeenCalled();
    expect((d.sleep as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      RELAY_CONNECT_WAIT_MS / 500
    );
  });
});

describe('the check line', () => {
  const idle = { account: null, starting: false, waiting: false, error: null };
  it('says nothing before anyone pressed Sign in', () => {
    expect(signInCheck(idle)).toBeNull();
  });
  it('waits for the browser neutrally, never amber', () => {
    expect(signInCheck({ ...idle, waiting: true })?.state).toBe('waiting');
  });
  it('a failure to start is the reason; the account is Done', () => {
    expect(signInCheck({ ...idle, error: 'Offline.' })).toEqual({
      state: 'fail',
      line: 'Offline.',
    });
    expect(signInCheck({ ...idle, account: { id: 'u', email: 'sam@example.com' } })).toEqual({
      state: 'pass',
      line: 'Signed in as sam@example.com.',
    });
    expect(signedInLine({ id: 'u', email: null })).toBe('Signed in.');
  });
});

describe('first run’s “Sign in?”', () => {
  it('is never shown in a build with no relay', () => {
    overrideRelayForHarness(false);
    expect(isPassedOver('account')).toBe(true);
    expect(nextStep('welcome')).toBe('engine');
    expect(prevStep('engine')).toBe('welcome');
    // A launch saved on it (a build that had the relay) opens on the engine.
    expect(resumeStep({ v: 1, step: 'account', finished: false })).toBe('engine');
  });

  it('comes after the welcome, inside its part, until it is answered', () => {
    overrideRelayForHarness(true);
    expect(nextStep('welcome')).toBe('account');
    expect(prevStep('engine')).toBe('account');
    expect(sectionOf('account')).toBe('welcome');
    expect(progressOf('account')).toEqual({ section: 1, sections: 3, within: 0.5 });
    expect(resumeStep({ v: 1, step: 'account', finished: false })).toBe('account');

    saveAccountChoice('without');
    expect(readAccountChoice()).toBe('without');
    expect(nextStep('welcome')).toBe('engine');
    expect(prevStep('engine')).toBe('welcome');
    expect(resumeStep({ v: 1, step: 'account', finished: false })).toBe('engine');
  });

  it('reads junk as unanswered', () => {
    localStorage.setItem(ACCOUNT_CHOICE_KEY, 'maybe');
    expect(readAccountChoice()).toBeNull();
  });

  it('a finished onboarding from before still counts as finished', () => {
    overrideRelayForHarness(true);
    expect(resumeStep({ v: 1, step: 'engine', finished: true })).toBe('welcome');
  });
});

describe('the phone’s way in', () => {
  it('goes through signing in with the relay, until “Use Tailscale instead”', () => {
    overrideRelayForHarness(true);
    expect(phoneViaRelay()).toBe(true);
    expect(isPassedOver('phoneMacTailscale')).toBe(true);
    savePhoneRoute('tailscale');
    expect(readPhoneRoute()).toBe('tailscale');
    expect(phoneViaRelay()).toBe(false);
    expect(isPassedOver('phoneMacTailscale')).toBe(false);
    savePhoneRoute('relay');
    expect(phoneViaRelay()).toBe(true);
  });

  it('is always Tailscale with no relay', () => {
    overrideRelayForHarness(false);
    expect(phoneViaRelay()).toBe(false);
  });
});

describe('Settings → Account', () => {
  it('is listed, first, only with the relay', () => {
    overrideRelayForHarness(false);
    expect(visibleSettingsPages().some((p) => p.id === 'account')).toBe(false);
    expect(isSettingsPage('account')).toBe(false);
    expect(openingPage({ tab: 'account' })).toBe('agents');
    overrideRelayForHarness(true);
    expect(visibleSettingsPages()[0].id).toBe('account');
    expect(openingPage({ tab: 'account' })).toBe('account');
  });
});
