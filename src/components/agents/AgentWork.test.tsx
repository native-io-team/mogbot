import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { resetTurnStepsForTests } from '../../lib/turnSteps';
import { AgentBubble, WorkingIndicator } from './AgentChatItems';
import type { Agent, AgentMessage, TurnWork } from '../../lib/agents';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const agent = { id: 'acme', name: 'Acme', home: '/h/acme', status: { state: 'idle' } } as Agent;

const work: TurnWork = {
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 6 * 60_000,
  stepCount: 3,
  fileCount: 1,
  files: ['Hero.tsx'],
  steps: [
    { at: 1_000_000 + 2_000, kind: 'read', label: 'Read Hero.tsx' },
    { at: 1_000_000 + 40_000, kind: 'edit', label: 'Edited Hero.tsx' },
    { at: 1_000_000 + 75_000, kind: 'command', label: 'Ran npm test' },
  ],
};

const reply = (w?: TurnWork): AgentMessage => ({
  id: 'r1',
  agentId: 'acme',
  ts: 1_000_000 + 6 * 60_000,
  kind: 'agent',
  text: 'Done: the hero is fixed.',
  work: w,
});

describe('the timeline under a reply', () => {
  it('is one folded line of what was observed', () => {
    render(<AgentBubble message={reply(work)} agent={agent} />);
    const toggle = screen.getByRole('button', { name: 'Worked 6 min · 3 steps · edited 1 file' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Read Hero.tsx')).toBeNull();
  });

  it('opens into the steps in order, timed from the start, then folds again', () => {
    render(<AgentBubble message={reply(work)} agent={agent} />);
    const toggle = screen.getByRole('button', { name: /^Worked/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Read Hero.tsx0:02', 'Edited Hero.tsx0:40', 'Ran npm test1:15']);
    expect(screen.getByText('Hero.tsx', { exact: false, selector: 'p' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('says how many earlier steps were not kept', () => {
    render(<AgentBubble message={reply({ ...work, stepCount: 10 })} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(screen.getByText('7 earlier steps')).toBeInTheDocument();
  });

  it('says what was declined and what failed, and marks them quieter', () => {
    const honest: TurnWork = {
      ...work,
      steps: [
        {
          at: 1_000_000 + 2_000,
          kind: 'command',
          label: 'Asked to run rm — you declined',
          outcome: 'declined',
        },
        { at: 1_000_000 + 3_000, kind: 'edit', label: 'Tried to edit Hero.tsx', outcome: 'failed' },
        { at: 1_000_000 + 4_000, kind: 'approval', label: 'You allowed: Run a command' },
      ],
    };
    render(<AgentBubble message={reply(honest)} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    const [declined, failed, allowed] = screen.getAllByRole('listitem');
    expect(declined).toHaveAttribute('data-outcome', 'declined');
    expect(failed).toHaveAttribute('data-outcome', 'failed');
    expect(allowed).not.toHaveAttribute('data-outcome');
  });

  it('is absent when the turn did nothing but reply', () => {
    render(<AgentBubble message={reply()} agent={agent} />);
    expect(screen.queryByRole('button', { name: /steps?/ })).toBeNull();
  });
});

describe('the working line, live', () => {
  const live: TurnWork = { ...work, endedAt: undefined, files: [], doing: 'Running npm test' };

  it('is one line that says its steps so far and is itself the toggle', () => {
    render(<WorkingIndicator activity="Running npm test" work={live} agent={agent} />);
    expect(screen.getByText('Running npm test')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /^Running npm test · 3 steps/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // One control: no separate "3 steps" toggle beside it.
    expect(screen.queryByRole('button', { name: /^3 steps/ })).toBeNull();
  });

  it('opens under the line, and the step it is saying is not listed twice', () => {
    render(<WorkingIndicator activity="Running npm test" work={live} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /steps/ }));
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual(['Read Hero.tsx0:02', 'Edited Hero.tsx0:40']);
  });

  it('never hides the newest step when the line is not saying it', () => {
    // An approval was answered: the status comes back with no activity.
    // A turn of its own: the one above was left open, which this one would inherit.
    render(<WorkingIndicator activity={null} work={{ ...live, startedAt: 2 }} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /steps/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('lists a finished call even while the line still shows its words', () => {
    render(
      <WorkingIndicator
        activity="Running npm test"
        work={{ ...live, startedAt: 3, doing: undefined }}
        agent={agent}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /steps/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('without a timeline is the plain working line', () => {
    render(<WorkingIndicator activity="Thinking" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('a timeline its page sent without steps', () => {
  const folded: TurnWork = { ...work, steps: [], stepsOmitted: true };

  afterEach(() => {
    clearMocks();
    resetTurnStepsForTests();
  });

  it('reads nothing while folded, then its own steps once, when it opens', async () => {
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd !== 'agents_turn_work') return null;
      asked.push(args);
      return work;
    });
    render(<AgentBubble message={reply(folded)} agent={agent} />);
    const toggle = screen.getByRole('button', { name: 'Worked 6 min · 3 steps · edited 1 file' });
    expect(asked).toEqual([]);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('Read Hero.tsx')).toBeInTheDocument());
    expect(screen.queryByText('3 earlier steps')).toBeNull();
    expect(asked).toEqual([{ agentId: 'acme', messageId: 'r1' }]);
    // Folding and opening again reads nothing more.
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(asked).toHaveLength(1);
  });

  it('says so when the steps are no longer kept, and offers a retry when the read fails', async () => {
    let fail = true;
    mockIPC((cmd) => {
      if (cmd !== 'agents_turn_work') return null;
      if (fail) throw new Error('offline');
      return null;
    });
    render(<AgentBubble message={reply(folded)} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Its steps are no longer kept.')).toBeInTheDocument();
  });
});
