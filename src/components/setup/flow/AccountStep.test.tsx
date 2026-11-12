/**
 * "Sign in?": Sign in opens the page and waits; the account arriving moves
 * on by itself; "Use without signing in" is remembered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PhoneStatus } from '../../../lib/companion';

const getPhoneStatus = vi.hoisted(() => vi.fn());
const setPhoneAccess = vi.hoisted(() => vi.fn());
const signInAccount = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/companion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/companion')>();
  return { ...actual, getPhoneStatus, setPhoneAccess, signInAccount };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AccountStep } from './AccountStep';
import { readAccountChoice } from '../../../lib/account';
import { overrideRelayForHarness } from '../../../lib/brand';

const status = (over: Partial<PhoneStatus> = {}): PhoneStatus =>
  ({
    enabled: true,
    relay: { state: 'connected', account: null },
    ...over,
  }) as PhoneStatus;

describe('AccountStep', () => {
  beforeEach(() => {
    localStorage.clear();
    overrideRelayForHarness(true);
    getPhoneStatus.mockReset().mockResolvedValue(status());
    setPhoneAccess.mockReset().mockResolvedValue(status());
    signInAccount.mockReset().mockResolvedValue(undefined);
  });

  it('offers one Sign in and a way on without it', async () => {
    render(<AccountStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Sign in?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Google/ })).not.toBeInTheDocument();
    await waitFor(() => expect(getPhoneStatus).toHaveBeenCalled());
  });

  it('“Use without signing in” goes on and is never asked again', () => {
    const onNext = vi.fn();
    render(<AccountStep onNext={onNext} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use without signing in' }));
    expect(onNext).toHaveBeenCalled();
    expect(readAccountChoice()).toBe('without');
  });

  it('turns phone access on first, then waits for the browser', async () => {
    getPhoneStatus.mockResolvedValue(
      status({ enabled: false, relay: { state: 'off', account: null } })
    );
    setPhoneAccess.mockResolvedValue(status());
    render(<AccountStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/also turns on phone access/);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('heading', { name: 'Finish signing in in your browser' })
    ).toBeInTheDocument();
    expect(setPhoneAccess).toHaveBeenCalledWith(true);
    expect(signInAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('moves on by itself once the account arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onNext = vi.fn();
      render(<AccountStep onNext={onNext} onBack={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('heading', { name: 'Finish signing in in your browser' });
      getPhoneStatus.mockResolvedValue(
        status({ relay: { state: 'connected', account: { id: 'u', email: 'sam@example.com' } } })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500);
      });
      expect(await screen.findByText(/Signed in as sam@example.com/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(onNext).toHaveBeenCalled();
      expect(readAccountChoice()).toBe('signedIn');
    } finally {
      vi.useRealTimers();
    }
  });
});
