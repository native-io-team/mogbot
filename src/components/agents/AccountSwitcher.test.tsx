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
  subscribeAgents: () => () => {},
  getAgentsSnapshot: () => store,
}));

import { AccountSwitcher, AgentAccountChip, glanceStatus, rowPill } from './AccountSwitcher';
import { AgentsUsageView } from './AgentsUsageView';
import { AccountsPage } from './AgentsSettings';
import { requestAccountSignIn } from '../../lib/settingsFromChat';
import { AgentAccountItems } from './AgentModelMenu';
import {
  requestSwitcher,
  requestUsageAccount,
  switcherMounted,
  takeUsageAdd,
} from '../../lib/agentAccounts';

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
    // What's left and of what, in plain words. The figure is of the one
    // account read, so no "2 accounts" beside it: Work isn't in it.
    await waitFor(() => expect(row).toHaveTextContent('62% left for now'));
    expect(row).toHaveTextContent(/^Usage/);
    expect(row).toHaveTextContent('Resets');
    expect(row).not.toHaveTextContent('2 accounts');
    // One segment per account: Work has no reading, so its slot is empty, never full.
    const meter = within(row).getByRole('img', { name: /Room left/ });
    expect(meter).toHaveAccessibleName(
      /sam@example.com: 62% left, resets in .+; Work: shows after its first reply/
    );
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
  const rows = () => screen.getAllByRole('button', { name: /\. Open$/ });

  it('leads with the total, lists each account as a row in order, and opens its page', async () => {
    store.engines = [claude];
    store.agents = [{ id: 'r', name: 'Riley', engine: 'claude', account: 'a1' } as Agent];
    const calls = mock([mac, work]);
    render(<AgentsUsageView />);

    const hero = await screen.findByTestId('usage-hero');
    await waitFor(() => expect(hero).toHaveTextContent('62% left'));
    // The bar: the account with a reading first, the unread one an empty slot.
    const parts = within(hero).getAllByRole('button');
    expect(parts[0]).toHaveAccessibleName(/^sam@example.com: 62% left/);
    expect(parts[1]).toHaveAccessibleName(/^Work: shows after its first reply/);
    await waitFor(() => expect(rows()[0]).toHaveTextContent('In use'));
    expect(rows()[0]).toHaveTextContent('sam@example.com');
    expect(rows()[1]).toHaveTextContent('Next');
    // Someone is looking: a full read.
    expect(
      calls.some(
        (c) => c.cmd === 'agents_usage_overview' && (c.args as { look?: boolean }).look !== false
      )
    ).toBe(true);

    // Into Work's page: its pins, "Use this one now", and back with Esc.
    fireEvent.click(rows()[1]);
    const page = await screen.findByRole('article');
    expect(page).toHaveTextContent('me@work.example');
    expect(page).toHaveTextContent('Riley runs only on this one');
    expect(
      screen.getByText('Usage', { selector: '.breadcrumb__link, .breadcrumb__link *' })
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(page).getByRole('button', { name: 'Use this one now' }));
      await Promise.resolve();
    });
    expect(calls.some((c) => c.cmd === 'agents_account_use')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    await waitFor(() => expect(rows()[0]).toHaveTextContent('Work'));
  });

  it('an account’s page has its limits against pace, and no "Use this one now" when in use', async () => {
    store.engines = [claude];
    store.agents = [];
    mock([mac, work]);
    render(<AgentsUsageView />);
    await waitFor(() => expect(rows()[0]).toHaveTextContent('62% left'));
    fireEvent.click(rows()[0]);
    const page = await screen.findByRole('article');
    expect(page).toHaveTextContent('Max plan');
    expect(page).toHaveTextContent('5-hour');
    expect(page).toHaveTextContent('Under pace');
    expect(within(page).queryByRole('button', { name: 'Use this one now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Usage' }));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it('moves an account up from its page’s menu', async () => {
    store.engines = [claude];
    store.agents = [];
    const calls = mock([mac, work]);
    render(<AgentsUsageView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(rows()[0]);
    await screen.findByRole('article');
    // The first has nowhere to go up to.
    fireEvent.click(screen.getByRole('button', { name: `More for ${mac.name}` }));
    expect(await screen.findByText('Move down')).toBeInTheDocument();
    expect(screen.queryByText('Move up')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Usage' }));

    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    fireEvent.click(rows()[1]);
    await screen.findByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'More for Work' }));
    await act(async () => {
      fireEvent.click(await screen.findByText('Move up'));
      await Promise.resolve();
    });
    const moves = calls.filter((c) => c.cmd === 'agents_account_reorder');
    expect(moves).toHaveLength(1);
    expect(moves[0].args).toMatchObject({ engine: 'claude', ids: ['a1', 'default'] });
  });

  it('opens straight on an account asked for from elsewhere (the chat header’s chip)', async () => {
    store.engines = [claude];
    store.agents = [];
    mock([mac, work]);
    requestUsageAccount('claude', 'a1');
    render(<AgentsUsageView />);
    const page = await screen.findByRole('article');
    expect(page).toHaveTextContent('Work');
  });

  it('adds an account in one click, once, with a name not taken', async () => {
    store.engines = [claude];
    store.agents = [];
    const calls = mock([mac]);
    render(<AgentsUsageView />);
    const add = await screen.findByRole('button', { name: 'Add an account' });
    await act(async () => {
      fireEvent.click(add);
      await Promise.resolve();
    });
    const adds = calls.filter((c) => c.cmd === 'agents_account_add');
    expect(adds).toHaveLength(1);
    expect(adds[0].args).toMatchObject({ engine: 'claude', name: 'Account 2' });
  });

  it('Settings → Accounts & usage is the same rendering: same total, same rows', async () => {
    store.engines = [claude];
    store.agents = [];
    mock([mac, work]);
    const { unmount } = render(<AgentsUsageView />);
    await waitFor(() => expect(rows()[0]).toHaveTextContent('62% left'));
    const viewText = rows().map((k) => k.textContent);
    const heroText = screen.getByTestId('usage-hero').textContent;
    unmount();

    render(<AccountsPage />);
    await waitFor(() => expect(rows()[0]).toHaveTextContent('62% left'));
    expect(rows().map((k) => k.textContent)).toEqual(viewText);
    expect(screen.getByTestId('usage-hero').textContent).toEqual(heroText);
    // Always "left", never a bare used figure.
    expect(document.body.textContent).not.toMatch(/\b38%/);
    expect(document.body.textContent).not.toMatch(/This Mac\b(?!’s own sign-in)/);
  });

  it('in Settings, an account the Chief added from chat starts its sign-in', async () => {
    store.engines = [claude];
    store.agents = [];
    const pending: UsageAccount = { ...work, id: 'a9', name: 'Account 2', signedIn: false };
    mock([mac, pending]);
    requestAccountSignIn('a9');
    render(<AccountsPage />);
    expect(await screen.findByText(/Sign in “Account 2” to Claude Code/)).toBeInTheDocument();
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
  const row = (needsYou: boolean) => ({ figure: '', refill: null, count: null, needsYou }) as const;
  it('shows no dot when all is well: a green one said nothing anyone could read', () => {
    expect(glanceStatus({ tone: 'calm', row: row(false) })).toBe('off');
  });
  it('shows one only when the user must act, or agents are out', () => {
    expect(glanceStatus({ tone: 'warning', row: row(true) })).toBe('warn');
    expect(glanceStatus({ tone: 'limited', row: row(false) })).toBe('down');
  });
});
