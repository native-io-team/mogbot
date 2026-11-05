import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentAccounts } from './AgentAccounts';
import type { EngineInfo } from '../../lib/agents';
import {
  accountState,
  moved,
  requestAccountsOnOpen,
  suggestName,
  type UsageAccount,
} from '../../lib/agentAccounts';

afterEach(() => {
  cleanup();
  clearMocks();
});

const EVENTS = { shouldMockEvents: true };
const NOW = Date.UTC(2026, 10, 5, 8, 0, 0);
const H = 3_600_000;

const engine = (id: 'claude' | 'codex', installed = true): EngineInfo =>
  ({ id, label: id, installed, signedIn: true, asks: true, models: [] }) as EngineInfo;

const mac = (e: 'claude' | 'codex'): UsageAccount => ({
  id: 'default',
  engine: e,
  name: 'This Mac',
  thisMac: true,
  signedIn: true,
  out: false,
});

const work: UsageAccount = {
  id: 'a1',
  engine: 'claude',
  name: 'Work',
  thisMac: false,
  signedIn: true,
  limit: { at: NOW - H, resetsAt: NOW + 2 * H },
  out: true,
};

describe('accountState', () => {
  it('says only what is known about a limit', () => {
    expect(accountState(work, NOW)).toMatch(/^Out of usage until /);
    expect(accountState({ ...work, limit: { at: NOW } }, NOW)).toBe(
      'Out of usage · reset time not reported'
    );
    expect(accountState({ ...work, signedIn: false }, NOW)).toBe('Not signed in');
    expect(accountState({ ...work, out: false, limit: undefined, email: 'a@b.c' }, NOW)).toBe(
      'Signed in as a@b.c'
    );
    expect(accountState({ ...work, out: false }, NOW)).toMatch(/^Signed in · last limit /);
  });

  it('moves one account and refuses past either end', () => {
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b'], 0, -1)).toBeNull();
    expect(moved(['a', 'b'], 1, 1)).toBeNull();
  });

  it('suggests a name nobody has', () => {
    expect(suggestName([mac('claude'), { ...work, name: 'Account 2' }], 'claude')).toBe(
      'Account 3'
    );
    expect(suggestName([mac('claude'), { ...work, name: 'Account 2' }], 'codex')).toBe('Account 2');
  });
});

describe('AgentAccounts', () => {
  it('lists each installed engine’s accounts in order, with honest states', async () => {
    const live = { ...work, limit: { at: Date.now() - H, resetsAt: Date.now() + 2 * H } };
    mockIPC(
      (cmd) => (cmd === 'agents_accounts' ? [mac('claude'), live, mac('codex')] : null),
      EVENTS
    );
    render(<AgentAccounts engines={[engine('claude'), engine('codex', false)]} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('Work')).toBeTruthy();
    expect(within(rows[1]).getByText(/Out of usage until/)).toBeTruthy();
    // This Mac's own sign-in can't be removed; an added one can.
    expect(within(rows[0]).queryByText('Remove')).toBeNull();
    expect(within(rows[1]).getByText('Remove')).toBeTruthy();
    // First can't move up, last can't move down.
    expect(within(rows[0]).getByLabelText('Try This Mac earlier')).toHaveProperty('disabled', true);
    expect(within(rows[1]).getByLabelText('Try Work later')).toHaveProperty('disabled', true);
    // Codex isn't installed here: nothing to add for it.
    expect(screen.queryByText('Add a Codex account')).toBeNull();
    expect(screen.getByText('Add a Claude Code account')).toBeTruthy();
  });

  it('moving an account down sends the whole new order', async () => {
    const sent: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_accounts') return [mac('claude'), work];
      if (cmd === 'agents_account_reorder') {
        sent.push(args);
        return [];
      }
      return null;
    }, EVENTS);
    render(<AgentAccounts engines={[engine('claude')]} />);
    fireEvent.click(await screen.findByLabelText('Try This Mac later'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ engine: 'claude', ids: ['a1', 'default'] });
  });

  it('removing asks first, then removes', async () => {
    const removed: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_accounts') return [mac('claude'), work];
      if (cmd === 'agents_account_remove') removed.push(args);
      return null;
    }, EVENTS);
    render(<AgentAccounts engines={[engine('claude')]} />);
    fireEvent.click(await screen.findByText('Remove'));
    expect(screen.getByText('Remove its sign-in from this Mac?')).toBeTruthy();
    expect(removed).toHaveLength(0);
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(removed).toEqual([{ engine: 'claude', id: 'a1' }]));
  });

  it('opens on adding one when the palette asked for it', async () => {
    mockIPC((cmd) => (cmd === 'agents_accounts' ? [mac('claude')] : null), EVENTS);
    requestAccountsOnOpen('claude');
    render(<AgentAccounts engines={[engine('claude')]} />);
    expect(await screen.findByLabelText('Name for the new Claude Code account')).toBeTruthy();
    expect(screen.getByText('Add and sign in')).toBeTruthy();
  });
});
