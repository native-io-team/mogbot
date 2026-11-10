import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { resetTurnStepsForTests } from '../../lib/turnSteps';
import { AgentBubble } from './AgentChatItems';
import { AgentBriefingModal } from './AgentWorkDetail';
import type { Agent, AgentMessage, TurnWork } from '../../lib/agents';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

afterEach(() => {
  clearMocks();
  resetTurnStepsForTests();
});

const agent = { id: 'acme', name: 'Acme', home: '/h/acme', status: { state: 'idle' } } as Agent;

const work: TurnWork = {
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 60_000,
  // Two steps fell off the front: the kept ones are steps 2 and 3.
  stepCount: 4,
  fileCount: 0,
  steps: [
    { at: 1_000_000 + 2_000, kind: 'read', label: 'Read Hero.tsx' },
    { at: 1_000_000 + 3_000, kind: 'command', label: 'Ran npm test', hasExact: true },
  ],
  engine: 'Claude Code',
  account: 'work@acme.com',
  model: 'claude-opus-4-6',
};

const reply = (w: TurnWork): AgentMessage => ({
  id: 'r1',
  agentId: 'acme',
  ts: 1_000_000 + 60_000,
  kind: 'agent',
  text: 'Done.',
  work: w,
});

describe('which account and model ran the turn', () => {
  it('sits beside the folded line, only as recorded', () => {
    render(<AgentBubble message={reply(work)} agent={agent} />);
    const line = screen.getByText('Claude Code · work@acme.com · Opus');
    expect(line).toHaveAttribute('title', 'Ran on Claude Code · work@acme.com · claude-opus-4-6');
  });

  it('leaves out what the engine didn’t say', () => {
    render(<AgentBubble message={reply({ ...work, model: undefined })} agent={agent} />);
    expect(screen.getByText('Claude Code · work@acme.com')).toBeInTheDocument();
  });

  it('says nothing for a turn from before it was recorded', () => {
    const { container } = render(
      <AgentBubble
        message={reply({ ...work, engine: undefined, account: undefined, model: undefined })}
        agent={agent}
      />
    );
    expect(container.querySelector('.agent-work__ran-on')).toBeNull();
  });
});

describe('a step’s exact command', () => {
  it('is offered only on a step whose command was kept, and reads it by its index', async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_step_exact') {
        asked.push(args);
        return 'npm test -- --watch=false';
      }
      return null;
    });
    render(<AgentBubble message={reply(work)} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    // The step's own words are the toggle: no separate link per step.
    const shows = screen.getAllByRole('button', { name: /Show exact command$/ });
    expect(shows).toHaveLength(1);
    expect(shows[0]).toHaveTextContent(/^Ran npm test/);
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
    fireEvent.click(shows[0]);
    expect(shows[0]).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('npm test -- --watch=false')).toBeInTheDocument();
    expect(asked).toEqual([{ agentId: 'acme', messageId: 'r1', step: 3 }]);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('says “details” on a step that ran no command', () => {
    mockIPC(() => null);
    const read = { ...work.steps[0], hasExact: true };
    render(
      <AgentBubble message={reply({ ...work, steps: [read, work.steps[1]] })} agent={agent} />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(screen.getAllByRole('button', { name: /, Show / }).map((b) => b.textContent)).toEqual([
      'Read Hero.tsx, Show details',
      'Ran npm test, Show exact command',
    ]);
  });

  it('says so when it is no longer kept', async () => {
    mockIPC(() => null);
    render(<AgentBubble message={reply(work)} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show exact command$/ }));
    expect(await screen.findByText('It isn’t kept for this step any more.')).toBeInTheDocument();
  });
});

describe('What it was told', () => {
  it('shows the turn’s briefing section by section, read-only', async () => {
    mockIPC((cmd, args) => {
      if (cmd === 'agents_turn_briefing') {
        expect(args).toEqual({ agentId: 'acme', messageId: 'r1' });
        return {
          at: 1_000_000,
          sections: [
            { title: 'Who it is', body: 'You are Acme, one of the user’s agents.' },
            { title: 'How much to do on your own', body: 'Steady.' },
          ],
          instructions: '# Acme\n\n## Memory\n\n- Deploys go through Sam.',
        };
      }
      return null;
    });
    render(<AgentBubble message={reply(work)} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    fireEvent.click(screen.getByRole('button', { name: 'What it was told' }));
    expect(await screen.findByText('How much to do on your own')).toBeInTheDocument();
    expect(screen.getByText('Its instructions and memory')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('from the … menu, reads the newest and says when there is none yet', async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_turn_briefing') asked.push(args);
      return null;
    });
    render(<AgentBriefingModal agentId="acme" agentName="Acme" onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: 'What Acme was told' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByText('Nothing kept yet: the next turn’s briefing will be here.')
      ).toBeInTheDocument()
    );
    expect(asked).toEqual([{ agentId: 'acme', messageId: null }]);
  });
});
