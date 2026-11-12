/**
 * Settings → Account: who this Mac is signed in as, Sign out only after a
 * confirm, Sign in with what it unlocks, and no guess while phone access is
 * off (the relay is what knows).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PhoneStatus } from '../../lib/companion';

const getPhoneStatus = vi.hoisted(() => vi.fn());
const setPhoneAccess = vi.hoisted(() => vi.fn());
const signInAccount = vi.hoisted(() => vi.fn());
const signOutAccount = vi.hoisted(() => vi.fn());
vi.mock('../../lib/companion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/companion')>();
  return { ...actual, getPhoneStatus, setPhoneAccess, signInAccount, signOutAccount };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AccountPage } from './AccountPage';
import { requestAccountOnOpen } from '../../lib/account';

const status = (relay: PhoneStatus['relay'], enabled = true): PhoneStatus =>
  ({ enabled, relay }) as PhoneStatus;
const ACCOUNT = { id: 'u', email: 'sam@example.com' };

describe('AccountPage', () => {
  beforeEach(() => {
    getPhoneStatus.mockReset();
    setPhoneAccess.mockReset();
    signInAccount.mockReset().mockResolvedValue(undefined);
    signOutAccount.mockReset().mockResolvedValue(undefined);
  });

  it('signed in: the address, and Sign out asks first', async () => {
    getPhoneStatus.mockResolvedValue(status({ state: 'connected', account: ACCOUNT }));
    render(<AccountPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out…' }));
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    expect(signOutAccount).not.toHaveBeenCalled();
    getPhoneStatus.mockResolvedValue(status({ state: 'connected', account: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOutAccount).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
  });

  it('signed out: Sign in with what it unlocks, then waiting for the browser', async () => {
    getPhoneStatus.mockResolvedValue(status({ state: 'connected', account: null }));
    render(<AccountPage />);
    expect(await screen.findByText(/reach this Mac from anywhere/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Finish signing in in your browser')).toBeInTheDocument();
    expect(signInAccount).toHaveBeenCalledTimes(1);
  });

  it('phone access off: says it can’t tell, never “Not signed in”', async () => {
    getPhoneStatus.mockResolvedValue(status({ state: 'off', account: null }, false));
    render(<AccountPage />);
    expect(await screen.findByText('Phone access is off')).toBeInTheDocument();
    expect(screen.queryByText('Not signed in')).not.toBeInTheDocument();
  });

  it('⌘K “Sign out” opens on the confirm', async () => {
    getPhoneStatus.mockResolvedValue(status({ state: 'connected', account: ACCOUNT }));
    requestAccountOnOpen('signOut');
    render(<AccountPage />);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(signOutAccount).not.toHaveBeenCalled();
  });

  it('⌘K “Sign in” starts the sign-in on open', async () => {
    getPhoneStatus.mockResolvedValue(status({ state: 'connected', account: null }));
    requestAccountOnOpen('signIn');
    render(<AccountPage />);
    await waitFor(() => expect(signInAccount).toHaveBeenCalledTimes(1));
  });
});
