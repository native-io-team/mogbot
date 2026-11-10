import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentRoutineModel, routineOwnChoices } from './AgentRoutineModel';
import { AGENT_MODELS, describeRun, type Agent, type CheckIn } from '../../lib/agents';

vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  refreshAgents: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  clearMocks();
});

const routine = {
  id: 'r1',
  note: 'Check the inbox',
  repeat: { kind: 'every', minutes: 60 },
  nextAt: 0,
  createdAt: 0,
  paused: false,
} as CheckIn;

describe('AgentRoutineModel', () => {
  it('offers its other routines’ model first, its chats’, then each model', () => {
    const agent = { engine: 'claude', model: 'opus' } as Agent;
    const options = routineOwnChoices(agent, AGENT_MODELS);
    expect(options.map((o) => o.value)).toEqual(['', 'same', 'opus', 'sonnet', 'haiku']);
    // An agent on Opus runs its routines on Opus unless told otherwise.
    expect(options[0].detail).toBe(AGENT_MODELS[1].label);
    expect(options[1].detail).toBe(AGENT_MODELS[1].label);
  });

  it('picks a lighter model for one routine, at once', async () => {
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_schedule_model') calls.push(args);
      return null;
    });
    const agent = { id: 'a1', name: 'Inbox', engine: 'claude', checkIns: [routine] } as Agent;
    render(<AgentRoutineModel agent={agent} routine={routine} />);
    const trigger = screen.getByRole('button', { name: /Model for this routine/ });
    // Haiku, by the label the menu gives it.
    expect(trigger).toHaveTextContent(`Like its other routines (${AGENT_MODELS[3].label})`);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText(AGENT_MODELS[2].label));
    await waitFor(() =>
      expect(calls).toEqual([expect.objectContaining({ agentId: 'a1', id: 'r1', model: 'sonnet' })])
    );
  });

  it('a held run says it is waiting for the reset, not that it failed', () => {
    const at = Date.now();
    expect(describeRun({ at, outcome: 'held', attempt: 1 })).toBe('Waiting for the reset');
    expect(
      describeRun({ at, outcome: 'held', attempt: 1, retryAt: at + 2 * 3_600_000 }, at)
    ).toMatch(/^Waiting for the reset · runs /);
  });
});
