import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type React from 'react';
import { AgentAccounts } from './AgentAccounts';
import { ToastContext } from '../../contexts/ToastContext';
import type { EngineInfo } from '../../lib/agents';
import {
  accountDetail,
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

describe('accountDetail', () => {
  it('shows who each account is, This Mac included, only as reported', () => {
    const signed = { ...mac('claude'), email: 'sam@example.com', plan: 'Max' };
    expect(accountDetail(signed, NOW)).toEqual({
      state: 'Ready',
      email: 'sam@example.com',
      plan: 'Max plan',
      note: undefined,
    });
    // Nothing reported: just "Ready", never a made-up address or plan.
    expect(accountDetail(mac('claude'), NOW)).toMatchObject({ state: 'Ready' });
    expect(accountDetail(mac('claude'), NOW).email).toBeUndefined();
    expect(accountDetail(mac('claude'), NOW).plan).toBeUndefined();
    // A file that outlived a sign-out isn't shown.
    expect(accountDetail({ ...signed, signedIn: false }, NOW)).toEqual({
      state: 'Not signed in',
    });
    // Out of usage still says who it is.
    const out = accountDetail({ ...work, email: 'w@example.com' }, NOW);
    expect(out.state).toMatch(/^Out of usage until /);
    expect(out.email).toBe('w@example.com');
    expect(out.note).toBeUndefined();
    // The email comes before a past limit, so it's what truncates.
    const past = accountDetail({ ...work, out: false, email: 'w@example.com' }, NOW);
    expect(past.state).toBe('Ready');
    expect(past.email).toBe('w@example.com');
    expect(past.note).toMatch(/^last limit /);
  });

  it('renders the email on the second line for This Mac too', async () => {
    const personal = {
      ...work,
      out: false,
      limit: undefined,
      name: 'Personal Account',
      email: 'p@example.net',
    };
    mockIPC(
      (cmd) =>
        cmd === 'agents_accounts'
          ? [{ ...mac('claude'), email: 'sam@example.com' }, personal]
          : null,
      EVENTS
    );
    render(<AgentAccounts engines={[engine('claude')]} />);
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]).getByText('sam@example.com')).toBeTruthy();
    expect(within(rows[1]).getByText('Personal Account')).toBeTruthy();
    expect(within(rows[1]).getByText('p@example.net')).toBeTruthy();
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
    // This Mac's own sign-in can't be removed, and says why; an added one can.
    fireEvent.click(within(rows[0]).getByLabelText('More for This Mac'));
    const macRemove = (await screen.findByText('Remove…')).closest('button')!;
    expect(macRemove).toHaveProperty('disabled', true);
    expect(macRemove.parentElement?.getAttribute('title')).toMatch(/stays/);
    fireEvent.click(within(rows[1]).getByLabelText('More for Work'));
    await waitFor(() =>
      expect(screen.getAllByText('Remove…').some((el) => !el.closest('button')?.disabled)).toBe(
        true
      )
    );
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
    fireEvent.click(await screen.findByLabelText('More for Work'));
    fireEvent.click(await screen.findByText('Remove…'));
    expect(screen.getByText('Remove its sign-in from this Mac?')).toBeTruthy();
    expect(removed).toHaveLength(0);
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(removed).toEqual([{ engine: 'claude', id: 'a1' }]));
  });

  it('removing mid-turn says it goes when that turn ends', async () => {
    const said: [string, string | undefined][] = [];
    const toasts = {
      toasts: [],
      dismissToast: () => undefined,
      showToast: (message: string, type?: string) => {
        said.push([message, type]);
        return 0;
      },
    } as unknown as React.ContextType<typeof ToastContext>;
    mockIPC((cmd) => {
      if (cmd === 'agents_accounts') return [mac('claude'), work];
      if (cmd === 'agents_account_remove')
        return { waiting: "Removing after Finance's turn ends." };
      return null;
    }, EVENTS);
    render(
      <ToastContext.Provider value={toasts}>
        <AgentAccounts engines={[engine('claude')]} />
      </ToastContext.Provider>
    );
    fireEvent.click(await screen.findByLabelText('More for Work'));
    fireEvent.click(await screen.findByText('Remove…'));
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(said).toEqual([["Removing after Finance's turn ends.", 'info']]));
  });

  it('opens on adding one when the palette asked for it', async () => {
    mockIPC((cmd) => (cmd === 'agents_accounts' ? [mac('claude')] : null), EVENTS);
    requestAccountsOnOpen('claude');
    render(<AgentAccounts engines={[engine('claude')]} />);
    expect(await screen.findByLabelText('Name for the new Claude Code account')).toBeTruthy();
    expect(screen.getByText('Add and sign in')).toBeTruthy();
  });
});
