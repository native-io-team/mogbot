/**
 * Which account is working, from the sidebar's foot: the row names it and
 * its room, the popover lists every account, and "Use this one now" swaps
 * at once from the order the Mac answers with. ⌘K opens it. Per agent,
 * "Runs on" pins one account; the chat header names the account a turn ran on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import type { Agent, EngineInfo } from '../../lib/agents';
import type { UsageAccount } from '../../lib/agentAccounts';

const updateAgent = vi.hoisted(() => vi.fn((_id: string, _change: unknown) => Promise.resolve()));
vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  updateAgent,
}));

const store = vi.hoisted(() => ({
  engines: [] as EngineInfo[],
  agents: [] as Agent[],
}));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents: () => Promise.resolve(),
  useAgentsSelector: (select: (s: unknown) => unknown) => select(store),
}));

import { AccountSwitcher, AgentAccountChip, rowPill } from './AccountSwitcher';
import { AgentAccountItems } from './AgentModelMenu';
import { requestSwitcher, switcherMounted } from '../../lib/agentAccounts';

afterEach(() => {
  cleanup();
  clearMocks();
});

const NOW = Date.now();
const H = 3_600_000;

const claude: EngineInfo = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  signedIn: true,
  asks: true,
  models: [],
} as EngineInfo;

const mac: UsageAccount = {
  id: 'default',
  engine: 'claude',
  name: 'sam@example.com',
  named: false,
  email: 'sam@example.com',
  plan: 'Max',
  thisMac: true,
  signedIn: true,
  out: false,
};
const work: UsageAccount = {
  id: 'a1',
  engine: 'claude',
  name: 'Work',
  named: true,
  email: 'me@work.example',
  thisMac: false,
  signedIn: true,
  out: false,
};

const window5h = (used: number) => ({
  kind: 'five_hour',
  usedPercent: used,
  resetsAt: NOW + 2 * H,
  limited: false,
  observedAt: NOW - 60_000,
});

function mock(order: UsageAccount[], calls: { cmd: string; args: unknown }[] = []) {
  let accounts = order;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'agents_accounts') return accounts;
      if (cmd === 'agents_account_use') {
        const { id } = args as { id: string };
        accounts = [...accounts.filter((a) => a.id === id), ...accounts.filter((a) => a.id !== id)];
        return accounts;
      }
      if (cmd === 'agents_usage_overview') {
        return {
          mode: 'normal',
          engines: [],
          accounts: [
            {
              engine: 'claude',
              id: 'default',
              name: mac.name,
              thisMac: true,
              signedIn: true,
              out: false,
              next: true,
              windows: [window5h(38)],
              learned: [],
            },
          ],
          local: [],
          spare: [],
          backlog: [],
          agents: [],
          routines: [],
          now: NOW,
        };
      }
      return null;
    },
    { shouldMockEvents: true }
  );
  return calls;
}

describe('AccountSwitcher', () => {
  it('names the account in use and its room, and swaps in one click', async () => {
    store.engines = [claude];
    store.agents = [{ id: 'r', name: 'Riley', engine: 'claude', account: 'a1' } as Agent];
    const calls = mock([mac, work]);
    render(<AccountSwitcher collapsed={false} />);

    const row = await screen.findByTestId('account-switcher');
    await waitFor(() => expect(row).toHaveTextContent('sam@example.com'));
    await waitFor(() => expect(row).toHaveTextContent('62% left'));
    // The row itself never asks for a reading: a glance.
    expect(
      calls.some(
        (c) => c.cmd === 'agents_usage_overview' && (c.args as { look?: boolean }).look === false
      )
    ).toBe(true);

    fireEvent.click(row);
    const pop = await screen.findByRole('dialog', { name: 'Accounts' });
    const rows = within(pop).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('In use');
    expect(rows[0]).toHaveTextContent('Max plan');
    expect(rows[0]).toHaveTextContent('5-hour 62% left');
    expect(rows[1]).toHaveTextContent('Ready');
    expect(rows[1]).toHaveTextContent('me@work.example');
    expect(rows[1]).toHaveTextContent('Riley runs only on this one');
    // Only one "Use this one now": on the account not in use.
    expect(within(rows[0]).queryByRole('button', { name: 'Use this one now' })).toBeNull();

    await act(async () => {
      fireEvent.click(within(rows[1]).getByRole('button', { name: 'Use this one now' }));
      await Promise.resolve();
    });
    expect(calls.some((c) => c.cmd === 'agents_account_use')).toBe(true);
    // The order the Mac answered with shows at once.
    await waitFor(() => expect(within(pop).getAllByRole('listitem')[0]).toHaveTextContent('Work'));
    expect(within(pop).getAllByRole('listitem')[0]).toHaveTextContent('In use');
    await waitFor(() => expect(row).toHaveTextContent('Work'));
  });

  it('opens from ⌘K, straight into adding when asked', async () => {
    store.engines = [claude];
    store.agents = [];
    mock([mac]);
    render(<AccountSwitcher collapsed={false} />);
    await screen.findByTestId('account-switcher');
    expect(switcherMounted()).toBe(true);
    act(() => {
      requestSwitcher('add');
    });
    const pop = await screen.findByRole('dialog', { name: 'Accounts' });
    expect(
      within(pop).getByRole('textbox', { name: /Name for the new Claude Code account/ })
    ).toHaveValue('Account 2');
    expect(within(pop).getByRole('button', { name: 'Add and sign in' })).toBeEnabled();
  });

  it('adds once however often Enter is pressed, and never with an empty name', async () => {
    store.engines = [claude];
    store.agents = [];
    const calls = mock([mac]);
    let release: (() => void) | undefined;
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'agents_accounts') return [mac];
        if (cmd === 'agents_account_add') {
          return new Promise((r) => {
            release = () => r({ ...work, signedIn: false });
          });
        }
        return null;
      },
      { shouldMockEvents: true }
    );
    render(<AccountSwitcher collapsed={false} />);
    await screen.findByTestId('account-switcher');
    act(() => {
      requestSwitcher('add');
    });
    const pop = await screen.findByRole('dialog', { name: 'Accounts' });
    const field = within(pop).getByRole('textbox', { name: /Name for the new/ });

    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(calls.filter((c) => c.cmd === 'agents_account_add')).toHaveLength(0);

    fireEvent.change(field, { target: { value: 'Work' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      fireEvent.keyDown(field, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(calls.filter((c) => c.cmd === 'agents_account_add')).toHaveLength(1);
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
  });

  it('shows nothing with no engine on this Mac', async () => {
    store.engines = [{ ...claude, installed: false }];
    mock([mac]);
    const { container } = render(<AccountSwitcher collapsed={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="account-switcher"]')).toBeNull();
  });
});

describe('Runs on, per agent', () => {
  it('offers any account or one, once its engine has two', async () => {
    mock([mac, work]);
    const save = vi.fn(() => Promise.resolve());
    const riley = { id: 'r', name: 'Riley', engine: 'claude' } as Agent;
    render(<AgentAccountItems agent={riley} save={save} />);
    expect(await screen.findByText('Runs on · Any account')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Work/ }));
    expect(save).toHaveBeenCalledWith({ account: 'a1' });
  });

  it('isn’t offered with one account', async () => {
    mock([mac]);
    const { container } = render(
      <AgentAccountItems agent={{ id: 'r', engine: 'claude' } as Agent} save={vi.fn()} />
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('the chat header names the account a turn ran on, "only" when pinned there', () => {
    const { rerender } = render(
      <AgentAccountChip agent={{ id: 'r', name: 'Riley', engine: 'claude' } as Agent} />
    );
    expect(screen.queryByTestId('agent-account-chip')).toBeNull();
    rerender(
      <AgentAccountChip
        agent={
          {
            id: 'r',
            name: 'Riley',
            engine: 'claude',
            account: 'a1',
            ranOn: { id: 'a1', name: 'Work' },
          } as Agent
        }
      />
    );
    expect(screen.getByTestId('agent-account-chip')).toHaveTextContent('Work· only');
  });
});

describe('the sidebar row pill', () => {
  const line = (over: object) =>
    ({
      engine: 'claude',
      name: 'Work',
      tone: 'ok',
      detail: '',
      several: false,
      ...over,
    }) as Parameters<typeof rowPill>[0];
  it('is the shared StatusPill tone: out of usage neutral, carrying on running', () => {
    expect(rowPill(line({ tone: 'out', room: 'Out until 3:20 PM' }))).toBe('out');
    expect(rowPill(line({ tone: 'warning', away: true, room: 'on Codex' }))).toBe('running');
    expect(rowPill(line({ tone: 'warning', room: '12% left' }))).toBeNull();
    expect(rowPill(line({ room: '62% left' }))).toBeNull();
  });
});
