/**
 * Usage at a glance, from the sidebar's foot: one line and the stack as a
 * segmented meter; the Usage view lists every account as a key, and "Use
 * this one now" swaps at once from the order the Mac answers with. ⌘K opens it. Per agent,
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

import { AccountSwitcher, AgentAccountChip, glanceStatus, rowPill } from './AccountSwitcher';
import { AgentsUsageView } from './AgentsUsageView';
import { AgentAccountItems } from './AgentModelMenu';
import { requestSwitcher, switcherMounted, takeUsageAdd } from '../../lib/agentAccounts';

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
      if (cmd === 'agents_account_add') return { ...work, id: 'a9', name: 'Account 2' };
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

describe('AccountSwitcher (the sidebar’s usage glance)', () => {
  it('answers in one line over the whole stack, and opens Usage', async () => {
    store.engines = [claude];
    store.agents = [{ id: 'r', name: 'Riley', engine: 'claude', account: 'a1' } as Agent];
    const calls = mock([mac, work]);
    const onOpen = vi.fn();
    render(<AccountSwitcher collapsed={false} onOpen={onOpen} />);

    const row = await screen.findByTestId('account-switcher');
    await waitFor(() => expect(row).toHaveTextContent('Plenty of room'));
    expect(row).toHaveTextContent('2 accounts');
    // One segment per account: Work has no reading, so its slot is empty, never full.
    const meter = within(row).getByRole('img', { name: /Room left/ });
    expect(meter).toHaveAccessibleName(/sam@example.com: 62% left; Work: no reading yet/);
    // The row itself never asks for a reading: a glance.
    expect(
      calls.some(
        (c) => c.cmd === 'agents_usage_overview' && (c.args as { look?: boolean }).look === false
      )
    ).toBe(true);
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens from ⌘K, and asks Usage to start adding when that was asked', async () => {
    store.engines = [claude];
    store.agents = [];
    mock([mac]);
    const onOpen = vi.fn();
    render(<AccountSwitcher collapsed={false} onOpen={onOpen} />);
    await screen.findByTestId('account-switcher');
    expect(switcherMounted()).toBe(true);
    act(() => {
      requestSwitcher('add');
    });
    expect(onOpen).toHaveBeenCalled();
    expect(takeUsageAdd()).toBe(true);
    expect(takeUsageAdd()).toBe(false);
  });

  it('shows nothing with no engine on this Mac', async () => {
    store.engines = [{ ...claude, installed: false }];
    mock([mac]);
    const { container } = render(<AccountSwitcher collapsed={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="account-switcher"]')).toBeNull();
  });
});

describe('Usage view', () => {
  it('lists every account as a key in order, and swaps in one click', async () => {
    store.engines = [claude];
    store.agents = [{ id: 'r', name: 'Riley', engine: 'claude', account: 'a1' } as Agent];
    const calls = mock([mac, work]);
    render(<AgentsUsageView />);

    const keys = await screen.findAllByRole('article');
    await waitFor(() => expect(keys[0]).toHaveTextContent('In use'));
    expect(keys[0]).toHaveTextContent('Max plan');
    expect(keys[0]).toHaveTextContent('5-hour62% left');
    expect(keys[1]).toHaveTextContent('Next');
    expect(keys[1]).toHaveTextContent('me@work.example');
    expect(keys[1]).toHaveTextContent('Riley runs only on this one');
    expect(within(keys[0]).queryByRole('button', { name: 'Use this one now' })).toBeNull();
    // Someone is looking: a full read.
    expect(
      calls.some(
        (c) => c.cmd === 'agents_usage_overview' && (c.args as { look?: boolean }).look !== false
      )
    ).toBe(true);

    await act(async () => {
      fireEvent.click(within(keys[1]).getByRole('button', { name: 'Use this one now' }));
      await Promise.resolve();
    });
    expect(calls.some((c) => c.cmd === 'agents_account_use')).toBe(true);
    await waitFor(() => expect(screen.getAllByRole('article')[0]).toHaveTextContent('Work'));
  });

  it('adds an account in one click, once, with a name not taken', async () => {
    store.engines = [claude];
    store.agents = [];
    const calls = mock([mac]);
    render(<AgentsUsageView />);
    const add = await screen.findByRole('button', { name: 'Add a Claude Code account' });
    await act(async () => {
      fireEvent.click(add);
      await Promise.resolve();
    });
    const adds = calls.filter((c) => c.cmd === 'agents_account_add');
    expect(adds).toHaveLength(1);
    expect(adds[0].args).toMatchObject({ engine: 'claude', name: 'Account 2' });
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
    expect(rowPill(line({ tone: 'out', room: 'Out of usage until 3:20 PM' }))).toBe('out');
    expect(rowPill(line({ tone: 'warning', away: true, room: 'on Codex' }))).toBe('running');
    expect(rowPill(line({ tone: 'warning', room: '12% left' }))).toBeNull();
    expect(rowPill(line({ room: '62% left' }))).toBeNull();
  });
});

describe('glanceStatus (the usage row’s corner dot)', () => {
  const key = (left: number | null) => ({ left }) as never;
  it('shows no dot before anything was read: a green one would claim the limits are fine', () => {
    expect(glanceStatus({ tone: 'calm', keys: [key(null), key(null)] })).toBe('off');
  });
  it('is green once a reading says there is room, amber and red as before', () => {
    expect(glanceStatus({ tone: 'calm', keys: [key(null), key(60)] })).toBe('ok');
    expect(glanceStatus({ tone: 'warning', keys: [key(null)] })).toBe('warn');
    expect(glanceStatus({ tone: 'limited', keys: [key(0)] })).toBe('down');
  });
});
