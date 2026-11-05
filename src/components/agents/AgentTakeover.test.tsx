import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TakeoverBanner, TakeOverButton, TakeoverProvider } from './AgentTakeover';
import {
  canTakeOver,
  isQueued,
  peerState,
  retrySourceFor,
  takeoverPolicy,
  takeoverWhere,
  TRUST_HINT,
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
    if (cmd === 'agents_hand_back') return Promise.resolve('handedBack');
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

  it('a second click while it opens is the same take-over, not an error', async () => {
    let resolve: (v: AgentTakeover) => void = () => {};
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'agents_take_over') return new Promise((r) => (resolve = r));
      if (cmd === 'agents_overview')
        return Promise.resolve({ agents: [], engineReady: true, engines: [] });
      return Promise.resolve(null);
    });
    render(
      <TakeoverProvider>
        <TakeOverButton agent={agent()} />
      </TakeoverProvider>
    );
    const button = screen.getByRole('button', { name: 'Take over' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls('agents_take_over')).toHaveLength(1);
    await act(async () => {
      resolve(view);
      await Promise.resolve();
    });
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
    expect((calls('agents_hand_back')[0][1] as { force?: boolean }).force).toBeUndefined();
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
    expect(screen.getByRole('button', { name: 'Open in acme-site' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show (chat|terminal)/i })).toBeNull();
  });

  it('asks before handing back while the terminal is printing, then forces it', async () => {
    invoke.mockImplementation((cmd: string, args?: { force?: boolean }) => {
      if (cmd === 'agents_hand_back') return Promise.resolve(args?.force ? 'handedBack' : 'busy');
      if (cmd === 'agents_overview')
        return Promise.resolve({ agents: [], engineReady: true, engines: [] });
      return Promise.resolve(null);
    });
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: view })}
          terminalShown
          onToggleTerminal={vi.fn()}
        />
      </TakeoverProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
      await Promise.resolve();
    });
    expect(
      screen.getByText('Finance is in the middle of something in the terminal.', { exact: false })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Anything typed in the terminal but not sent is dropped.')
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back anyway' }));
      await Promise.resolve();
    });
    expect(calls('agents_hand_back').map(([, a]) => (a as { force?: boolean }).force)).toEqual([
      undefined,
      true,
    ]);
  });

  it('keeping on driving hands nothing back', async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'agents_hand_back' ? 'busy' : null)
    );
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: view })}
          terminalShown
          onToggleTerminal={vi.fn()}
        />
      </TakeoverProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Keep driving' }));
    expect(screen.queryByText('Hand back anyway')).toBeNull();
    expect(calls('agents_hand_back')).toHaveLength(1);
  });

  it('says first that Claude Code will ask to trust the folder, and what edits do', () => {
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: { ...view, trustPrompt: true } })}
          terminalShown
          onToggleTerminal={vi.fn()}
        />
      </TakeoverProvider>
    );
    expect(screen.getByText(TRUST_HINT)).toBeInTheDocument();
    expect(TRUST_HINT).toBe(
      'Claude Code will ask whether to trust this folder — choose “Yes, proceed”. Choosing No hands it back.'
    );
    expect(screen.getByText('You’re driving Finance in a terminal')).toHaveAttribute(
      'title',
      'Edits in its projects are accepted automatically while you drive, as they are for Finance. Shift-Tab changes it.'
    );
    expect(takeoverPolicy({ ...view, cli: 'codex' }, 'Ops')).not.toContain('Shift-Tab');
  });

  it('a trusted folder gets no hint', () => {
    render(
      <TakeoverProvider>
        <TakeoverBanner
          agent={agent({ takeover: view })}
          terminalShown
          onToggleTerminal={vi.fn()}
        />
      </TakeoverProvider>
    );
    expect(screen.queryByText(TRUST_HINT)).toBeNull();
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

  it('a terminal that closed by itself offers no Retry; a failed turn does', () => {
    const user = { id: 'u', agentId: 'fin', ts: 1, kind: 'user', text: 'do it' } as AgentMessage;
    const failed = { id: 'e', agentId: 'fin', ts: 2, kind: 'error', text: 'x' } as AgentMessage;
    expect(retrySourceFor([user, failed])).toBe(user);
    expect(retrySourceFor([user, { ...failed, takeover: true }])).toBeNull();
    expect(retrySourceFor([user])).toBeNull();
    // Now recorded as a quiet note: no Retry, and peers don't call it failed.
    const ended = { ...failed, kind: 'note', takeover: true } as AgentMessage;
    expect(retrySourceFor([user, ended])).toBeNull();
    expect(peerState(agent(), ended).kind).toBe('idle');
  });

  it('names where it is driven', () => {
    expect(takeoverWhere(view)).toBe('in a terminal');
    expect(takeoverWhere({ ...view, project: '/p/acme' })).toBe('in acme');
    expect(takeoverWhere({ ...view, project: '/p/acme' }, 'Acme Site')).toBe('in Acme Site');
  });
});
