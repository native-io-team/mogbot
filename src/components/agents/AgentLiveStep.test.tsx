import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { WorkingIndicator } from './AgentChatItems';
import { AgentBubble } from './AgentChatItems';
import type { Agent, AgentMessage, LiveCall, TurnWork } from '../../lib/agents';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

const T0 = 1_762_290_000_000;
const agent = {
  id: 'acme',
  name: 'Acme Site',
  home: '/h/acme',
  status: { state: 'working' },
} as Agent;

const call = (over: Partial<LiveCall> = {}): LiveCall => ({
  kind: 'command',
  label: 'Running the Cypress tests',
  startedAt: T0,
  slow: 'tests',
  streams: true,
  canStop: true,
  output: ['  ✓ renders the pricing page (812ms)', '  ✓ checks out (1.2s)'],
  ...over,
});

const live = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: T0 - 60_000,
  stepCount: 2,
  fileCount: 0,
  steps: [
    { at: T0 - 50_000, kind: 'read', label: 'Read cypress.config.ts' },
    { at: T0, kind: 'command', label: 'Ran the Cypress tests' },
  ],
  doing: 'Running the Cypress tests',
  current: call(),
  lastSignAt: T0 + 328_000,
  ...over,
});

const at = (ms: number) => vi.setSystemTime(T0 + ms);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  mockIPC(() => null, { shouldMockEvents: true });
});

afterEach(() => {
  // Unmounted while the event mocks are still there: the store stops listening cleanly.
  cleanup();
  vi.useRealTimers();
  clearMocks();
});

describe('the step it is on right now', () => {
  it('is one line: what it is doing, its steps so far and the turn’s time', async () => {
    at(332_000);
    render(<WorkingIndicator activity="Running the Cypress tests" work={live()} agent={agent} />);
    expect(screen.getByText('Running the Cypress tests')).toBeInTheDocument();
    // The turn started a minute before the call: the line times the turn.
    expect(screen.getByText('· 2 steps · 6:32')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText('· 2 steps · 6:34')).toBeInTheDocument();
    // No pill, no dots, no second toggle: the line is the toggle.
    const line = screen.getByRole('button', { name: /^Running the Cypress tests · 2 steps/ });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Show output' })).toBeNull();
  });

  it('opens into the steps, ending on this one with its own live timer', () => {
    at(332_000);
    render(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live()}
        agent={{ ...agent, id: 'opens' }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Running the Cypress tests/ }));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Read cypress.config.ts');
    // The running call, in its present-tense words, not its past-tense step too.
    expect(rows[1]).toHaveAttribute('data-current');
    expect(rows[1].textContent).toContain('Running the Cypress tests');
    expect(rows[1].textContent).toContain('5:32');
    expect(screen.queryByText('Ran the Cypress tests')).toBeNull();
  });

  it('gives a known slow tool a quiet hint only after a minute', async () => {
    at(30_000);
    const { rerender } = render(
      <WorkingIndicator activity="Running the Cypress tests" work={live()} agent={agent} />
    );
    expect(screen.queryByText('Test runs usually take a few minutes')).toBeNull();
    at(61_000);
    rerender(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live({ stepCount: 2 })}
        agent={agent}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText('Test runs usually take a few minutes')).toBeInTheDocument();
  });

  it('peeks at the output, or says when it will appear', () => {
    at(5_000);
    const { unmount } = render(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live()}
        agent={{ ...agent, id: 'peek-1' }}
      />
    );
    // Output belongs to its step, inside the opened timeline.
    fireEvent.click(screen.getByRole('button', { name: /^Running the Cypress tests/ }));
    const peek = screen.getByRole('button', { name: 'Show output' });
    expect(peek).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(peek);
    expect(screen.getByText(/renders the pricing page/)).toBeInTheDocument();
    unmount();
    // Claude Code doesn't stream what a command prints.
    render(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live({ current: call({ streams: false, output: undefined }) })}
        agent={{ ...agent, id: 'peek-2' }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Running the Cypress tests/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByText('Output appears when it finishes')).toBeInTheDocument();
  });

  it('says whether it is alive only when asked', () => {
    at(332_000);
    render(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live({ current: call({ busy: true }) })}
        agent={{ ...agent, id: 'alive' }}
      />
    );
    expect(screen.queryByText(/Last activity/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Running the Cypress tests/ }));
    expect(screen.getByText('Last activity 4s ago · busy')).toBeInTheDocument();
  });

  it('offers to stop just this step after ten minutes', async () => {
    const calls: string[] = [];
    mockIPC(
      (cmd) => {
        calls.push(cmd);
        return cmd === 'agents_stop_step' ? 'Stopped that step. It carries on from there.' : null;
      },
      { shouldMockEvents: true }
    );
    at(9 * 60_000);
    const { rerender } = render(
      <WorkingIndicator activity="Running the Cypress tests" work={live()} agent={agent} />
    );
    expect(screen.queryByRole('button', { name: 'Stop this step' })).toBeNull();
    at(10 * 60_000);
    rerender(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live({ stepCount: 2 })}
        agent={agent}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop this step' }));
      await Promise.resolve();
    });
    expect(calls).toContain('agents_stop_step');
    expect(screen.getByText('Stopped that step. It carries on from there.')).toBeInTheDocument();
  });

  it('says so gently once there has been no progress, with Check on it and Stop', async () => {
    const calls: string[] = [];
    mockIPC(
      (cmd) => {
        calls.push(cmd);
        if (cmd === 'agents_check_on') return 'It’s still running but sitting idle.';
        return cmd === 'agents_stop' ? true : null;
      },
      { shouldMockEvents: true }
    );
    at(300_000);
    render(
      <WorkingIndicator
        activity="Running the Cypress tests"
        work={live({ quietSince: T0, current: call({ busy: false }) })}
        agent={agent}
      />
    );
    expect(
      screen.getByText('No progress for 5 min · Running the Cypress tests')
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check on it' }));
      await Promise.resolve();
    });
    expect(calls).toContain('agents_check_on');
    expect(screen.getByText('It’s still running but sitting idle.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await Promise.resolve();
    });
    expect(calls).toContain('agents_stop');
  });

  it('shows its own browser as a live card while it has a page open there', () => {
    at(1_000);
    const browsing = call({
      kind: 'web',
      label: 'Using its own browser · example.com',
      slow: undefined,
      streams: false,
      canStop: false,
      output: [],
    });
    const { rerender } = render(
      <WorkingIndicator
        activity="Using its own browser · example.com"
        work={live({ current: browsing, doing: browsing.label })}
        agent={agent}
      />
    );
    expect(screen.getByText('Using its own browser · example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Watch Acme Site/ })).toBeNull();
    rerender(
      <WorkingIndicator
        activity="Using its own browser · example.com"
        work={live({ current: browsing, doing: browsing.label, ownBrowser: true })}
        agent={agent}
      />
    );
    // The old text button is gone; the card names the site from the step.
    expect(screen.queryByRole('button', { name: 'Watch its browser' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Watch Acme Site on example.com' })
    ).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('is the plain working line between calls', () => {
    at(1_000);
    render(
      <WorkingIndicator
        activity="Thinking"
        work={live({ current: undefined, doing: undefined })}
        agent={agent}
      />
    );
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show output' })).toBeNull();
  });
});

describe('a finished step', () => {
  it('keeps its plain words, how long it took and what a test run came to', () => {
    const message: AgentMessage = {
      id: 'r1',
      agentId: 'acme',
      ts: T0 + 400_000,
      kind: 'agent',
      text: 'Three tests fail on the pricing page.',
      work: {
        startedAt: T0,
        endedAt: T0 + 400_000,
        stepCount: 1,
        fileCount: 0,
        steps: [
          {
            at: T0,
            kind: 'command',
            label: 'Tried to run the Cypress tests',
            outcome: 'failed',
            endedAt: T0 + 372_000,
            summary: '42 passed, 3 failed',
            output: ['  ✖  3 of 12 failed (25%)   06:12   45   42   3'],
          },
        ],
      },
    };
    render(
      <AgentBubble
        message={message}
        agent={{ ...agent, status: { state: 'idle', activity: null, since: null } }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Worked/ }));
    expect(
      screen.getByText('Tried to run the Cypress tests · 6m 12s · 42 passed, 3 failed')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByText(/3 of 12 failed/)).toBeInTheDocument();
  });
});
