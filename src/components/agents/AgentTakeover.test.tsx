import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TakeoverBanner, TakeOverButton, TakeoverProvider } from './AgentTakeover';
import {
  canTakeOver,
  isQueued,
  takeoverWhere,
  type Agent,
  type AgentMessage,
  type AgentTakeover,
} from '../../lib/agents';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));
// The terminal itself is xterm; these tests are about the chat around it.
vi.mock('../terminal/AttachedTerminal', () => ({ AttachedTerminal: () => null }));

const view: AgentTakeover = { since: 1_000, ptySession: 'pty-1', cli: 'claude-code' };

function agent(extra: Partial<Agent> = {}): Agent {
  return {
    id: 'fin',
    name: 'Finance',
    home: '/h/fin',
    sessionId: 'sess-1',
    status: { state: 'idle', activity: null, since: null },
    ...extra,
  } as Agent;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'agents_take_over') return Promise.resolve(view);
    if (cmd === 'agents_hand_back') return Promise.resolve(true);
    if (cmd === 'agents_overview')
      return Promise.resolve({ agents: [], engineReady: true, engines: [] });
    return Promise.resolve(null);
  });
});

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

describe('Take over', () => {
  it('takes an idle agent over at once, on its own session', async () => {
    render(
      <TakeoverProvider>
        <TakeOverButton agent={agent()} />
      </TakeoverProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
      await Promise.resolve();
    });
    expect(calls('agents_take_over')).toHaveLength(1);
    expect(calls('agents_take_over')[0][1]).toMatchObject({ agentId: 'fin', stopFirst: undefined });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before stopping a working agent, and waiting does nothing', async () => {
    const working = agent({ status: { state: 'working', activity: 'Editing a.ts', since: 5 } });
    render(
      <TakeoverProvider>
        <TakeOverButton agent={working} />
      </TakeoverProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(screen.getByText('Finance is working')).toBeInTheDocument();
    expect(calls('agents_take_over')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(screen.queryByText('Finance is working')).toBeNull();
    expect(calls('agents_take_over')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop and take over' }));
      await Promise.resolve();
    });
    expect(calls('agents_take_over')[0][1]).toMatchObject({ agentId: 'fin', stopFirst: true });
  });

  it('is offered only once there is a conversation to step into, and not twice', () => {
    const { rerender } = render(
      <TakeoverProvider>
        <TakeOverButton agent={agent({ sessionId: null })} />
      </TakeoverProvider>
    );
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    rerender(
      <TakeoverProvider>
        <TakeOverButton agent={agent({ takeover: view })} />
      </TakeoverProvider>
    );
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    // A new engine's first turn starts a new conversation: there's nothing to resume.
    expect(canTakeOver({ sessionId: 's', newEngine: true })).toBe(false);
    expect(canTakeOver({ sessionId: 's' })).toBe(true);
  });

  it('outside Agents mode there is nothing to take over with', () => {
    render(<TakeOverButton agent={agent()} />);
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });
});

describe('TakeoverBanner', () => {
  it('says you are driving it here, and hands back', async () => {
    const onToggle = vi.fn();
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: view })}
          terminalShown
          onToggleTerminal={onToggle}
        />
      </TakeoverProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('You’re driving Finance in a terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Show chat' }));
    expect(onToggle).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
      await Promise.resolve();
    });
    expect(calls('agents_hand_back')[0][1]).toEqual({ agentId: 'fin' });
  });

  it('for a bound agent names the project and offers to open it', () => {
    const bound = { ...view, project: '/u/ShipStudio/acme-site' };
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: bound })}
          terminalShown={false}
          onToggleTerminal={vi.fn()}
        />
      </TakeoverProvider>
    );
    expect(screen.getByRole('status')).toHaveTextContent('You’re driving Finance in acme-site');
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show (chat|terminal)/i })).toBeNull();
  });

  it('is nothing when nobody is driving', () => {
    const { container } = render(
      <TakeoverBanner agent={agent()} terminalShown={false} onToggleTerminal={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('while you drive', () => {
  it('what you send in the chat waits for the hand-back, whatever the status says', () => {
    const msg = (ts: number): AgentMessage =>
      ({ id: `m${ts}`, agentId: 'fin', ts, kind: 'user', text: 'hi' }) as AgentMessage;
    const driven = agent({ takeover: view });
    expect(isQueued(msg(2_000), driven)).toBe(true);
    expect(isQueued(msg(500), driven)).toBe(false);
    expect(isQueued(msg(2_000), agent())).toBe(false);
  });

  it('names where it is driven', () => {
    expect(takeoverWhere(view)).toBe('in a terminal');
    expect(takeoverWhere({ ...view, project: '/p/acme' })).toBe('in acme');
    expect(takeoverWhere({ ...view, project: '/p/acme' }, 'Acme Site')).toBe('in Acme Site');
  });
});
