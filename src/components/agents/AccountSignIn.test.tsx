/**
 * Adding an account signs in through the browser, which signs in as whoever
 * is already signed in there. The sign-in says so before it starts, so the
 * same account isn't added twice (persona review 2026-11-09, the owner's
 * own case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UsageAccount } from '../../lib/agentAccounts';

vi.mock('../terminal/lazyTerminals', () => ({
  ClaudeConnectTerminal: () => null,
  WorkspaceConnectTerminal: () => null,
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
});
