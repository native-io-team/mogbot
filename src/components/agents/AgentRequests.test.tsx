import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agent, AgentMessage } from '../../lib/agents';
import { AgentRequestsBar } from './AgentRequests';

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
    <AgentRequestsBar
      agent={chief}
      peerIds={new Set()}
      shownRequestIds={new Set()}
      onOpenAgent={() => undefined}
      setup={setup}
    />
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
