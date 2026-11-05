import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Agent, AgentMessage } from '../../lib/agents';
import { AgentRequestsBar } from './AgentRequests';
import { ModalProvider } from '../../contexts/ModalContext';

const agent = (id: string, name: string, pendingApprovals = 0, isMain = false): Agent =>
  ({
    id,
    name,
    color: 'teal',
    isMain,
    pendingApprovals,
    status: { state: 'idle', activity: null, since: null },
  }) as unknown as Agent;

const card = (agentId: string, requestId: string): AgentMessage =>
  ({
    id: `m-${requestId}`,
    agentId,
    ts: 1,
    kind: 'approval',
    text: '',
    approval: { requestId, title: 'Run a command', detail: 'npm test', status: 'pending' },
  }) as AgentMessage;

// Fictional team: the Chief, two agents still being set up after an import,
// and one the user already works with.
const chief = agent('chief', 'Chief of Staff', 0, true);
const potter = agent('potter', 'Glazes', 1);
const florist = agent('florist', 'Bouquets', 1);
const books = agent('books', 'Bookkeeper', 1);
const state = vi.hoisted(() => ({
  agents: [] as Agent[],
  messages: {} as Record<string, AgentMessage[]>,
}));
const answerApproval = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  answerApproval,
}));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsSelector: <T,>(pick: (s: typeof state) => T) => pick(state),
  loadMessages: () => Promise.resolve(),
}));

function setTeam(agents: Agent[]) {
  state.agents = [chief, ...agents];
  state.messages = Object.fromEntries(agents.map((a) => [a.id, [card(a.id, `${a.id}-r`)]]));
}

const renderBar = (setup?: { agentIds: Set<string>; onOpen: () => void }) =>
  render(
    <ModalProvider>
      <AgentRequestsBar
        agent={chief}
        peerIds={new Set()}
        shownRequestIds={new Set()}
        onOpenAgent={() => undefined}
        setup={setup}
      />
    </ModalProvider>
  );

describe('AgentRequestsBar with "Setting up your team"', () => {
  it('gives way to the checklist when every request came from the import', () => {
    setTeam([potter, florist]);
    const onOpen = vi.fn();
    renderBar({ agentIds: new Set(['potter', 'florist']), onOpen });
    // The checklist's own bar (in the chat) is the one that shows.
    expect(screen.queryByTestId('agent-requests-bar')).toBeNull();
  });

  it('counts only the other agents, and points at the checklist for the rest', () => {
    setTeam([potter, florist, books]);
    const onOpen = vi.fn();
    renderBar({ agentIds: new Set(['potter', 'florist']), onOpen });
    const bar = screen.getByTestId('agent-requests-bar');
    expect(bar.textContent).toContain('Bookkeeper');
    expect(bar.textContent).not.toContain('Glazes');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByTestId('agent-requests-in-setup').textContent).toContain(
      'A few more are from the agents you imported.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open setting up your team' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is unchanged without a checklist', () => {
    setTeam([potter, books]);
    renderBar();
    const bar = screen.getByTestId('agent-requests-bar');
    expect(bar.textContent).toContain('Glazes');
    expect(bar.textContent).toContain('Bookkeeper');
  });
});

describe('Allow all', () => {
  it('confirms with counts by kind, then answers every Allow card but the login', async () => {
    const potterTwo = agent('potter', 'Glazes', 3);
    state.agents = [chief, potterTwo, books];
    const bash = (id: string, cmd: string) =>
      ({
        ...card('potter', id),
        approval: {
          requestId: id,
          title: 'Run a command',
          detail: cmd,
          status: 'pending',
          tool: 'Bash',
        },
      }) as AgentMessage;
    const login = {
      ...card('potter', 'p-login'),
      approval: {
        requestId: 'p-login',
        title: 'Glazes needs your Gmail',
        detail: '',
        status: 'pending',
        login: { service: 'gmail', title: 'Gmail', why: 'x', abilities: [], options: [] },
      },
    } as unknown as AgentMessage;
    state.messages = {
      potter: [bash('p1', 'ls -la ~/Kiln'), bash('p2', 'mkdir ~/Kiln/new'), login],
      books: [card('books', 'b1')],
    };
    answerApproval.mockClear();
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByTestId('agent-requests-allow-all'));
    const confirm = screen.getByTestId('agent-requests-allow-all-confirm');
    expect(confirm.textContent).toContain('Allow 3 requests? 2 commands, Run a command');
    expect(answerApproval).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Allow all' }));
    await waitFor(() => expect(answerApproval).toHaveBeenCalledTimes(3));
    const answered = answerApproval.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(answered).toEqual([
      ['books', 'b1', true],
      ['potter', 'p1', true],
      ['potter', 'p2', true],
    ]);
    await waitFor(() =>
      expect(screen.queryByTestId('agent-requests-allow-all-confirm')).toBeNull()
    );
  });

  it('per agent: only that agent’s cards, and Cancel answers nothing', () => {
    const bash = (id: string) =>
      ({
        ...card('potter', id),
        approval: {
          requestId: id,
          title: 'Run a command',
          detail: 'ls',
          status: 'pending',
          tool: 'Bash',
        },
      }) as AgentMessage;
    state.agents = [chief, agent('potter', 'Glazes', 2), books];
    state.messages = { potter: [bash('p1'), bash('p2')], books: [card('books', 'b1')] };
    answerApproval.mockClear();
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const rows = screen.getAllByTestId('agent-requests-group-allow-all');
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0]);
    const confirm = screen.getByTestId('agent-requests-allow-all-confirm');
    expect(confirm.textContent).toContain('Glazes: Allow 2 requests? 2 commands');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('agent-requests-allow-all-confirm')).toBeNull();
    expect(answerApproval).not.toHaveBeenCalled();
  });
});
