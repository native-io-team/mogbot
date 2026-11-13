/**
 * Adding an account signs in through the browser, which signs in as whoever
 * is already signed in there. The sign-in says so before it starts, so the
 * same account isn't added twice (persona review 2026-11-09, the owner's
 * own case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UsageAccount } from '../../lib/agentAccounts';

// The sign-in exits 0 as soon as it mounts, so a test reaches the state after
// the browser sign-in. Which CLI sign-in ran is kept to check.
const ran = vi.hoisted(() => ({ services: [] as string[] }));
vi.mock('../terminal/lazyTerminals', async () => {
  const { useEffect } = await import('react');
  return {
    WorkspaceConnectTerminal: ({
      service,
      onExit,
    }: {
      service: string;
      onExit: (code: number) => void;
    }) => {
      useEffect(() => {
        ran.services.push(service);
        onExit(0);
      }, [service, onExit]);
      return null;
    },
  };
});

const check = vi.hoisted(() => ({ fn: vi.fn<(...a: unknown[]) => unknown>() }));
vi.mock('../../lib/agentsUsage', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentsUsage')>()),
  checkNewAccount: (...a: unknown[]) => check.fn(...a),
}));

import { AccountSignIn } from './AccountSignIn';

const account = (engine: 'claude' | 'codex'): UsageAccount => ({
  id: 'a1',
  engine,
  name: 'Work',
  thisMac: false,
  signedIn: false,
  out: false,
});

afterEach(cleanup);

describe('AccountSignIn', () => {
  it('says the browser decides which Claude account is added', () => {
    render(<AccountSignIn account={account('claude')} onDone={() => {}} />);
    expect(screen.getByTestId('account-signin-warning').textContent).toMatch(
      /whoever is logged into claude\.ai.*sign out there first.*private window/
    );
  });

  it('says the same for a ChatGPT sign-in', () => {
    render(<AccountSignIn account={account('codex')} onDone={() => {}} />);
    expect(screen.getByTestId('account-signin-warning').textContent).toMatch(
      /whoever is logged into chatgpt\.com/i
    );
  });

  const signIn = (props: Partial<Parameters<typeof AccountSignIn>[0]> = {}) => {
    render(<AccountSignIn account={account('claude')} onDone={() => {}} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('checks which account it is in one compact status, with a way out', async () => {
    check.fn.mockReturnValue(new Promise(() => {}));
    const onDone = vi.fn();
    signIn({ onDone });
    const status = await screen.findByTestId('account-signin-checking');
    expect(status).toHaveTextContent('Checking which account this is…');
    expect(status.querySelector('.ss-spinner')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('says a new account is signed in, and waits for Done', async () => {
    check.fn.mockResolvedValue({});
    const onDone = vi.fn();
    signIn({ onDone });
    expect(await screen.findByTestId('account-signin-done')).toHaveTextContent('Work is signed in');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('names the account it turned out to be, in the same layout', async () => {
    check.fn.mockResolvedValue({ sameAs: 'default' });
    signIn({ nameOf: () => 'sam@example.com', onRemove: () => {} });
    const same = await screen.findByTestId('account-signin-same');
    expect(same).toHaveClass('account-signin__status');
    expect(same).toHaveTextContent('sam@example.com');
    expect(screen.getByRole('button', { name: 'Remove it' })).toBeInTheDocument();
  });

  it('signs Claude in with its own login in the account folder, asking for no email', async () => {
    check.fn.mockResolvedValue({});
    ran.services = [];
    render(<AccountSignIn account={account('claude')} onDone={() => {}} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('account-signin-done');
    expect(ran.services).toEqual(['claude']);
  });

  it('says plainly when the check could not run, never closing silently', async () => {
    check.fn.mockRejectedValue(new Error('no'));
    const onDone = vi.fn();
    signIn({ onDone });
    expect(await screen.findByTestId('account-signin-failed')).toHaveTextContent(
      'Signed in, but not checked'
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});
