import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentWorkingLine } from './AgentWorkingLine';
import { AgentAvatar } from './AgentAvatar';
import type { Agent } from '../../lib/agents';

const T0 = 1_762_290_000_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const agent = (status: Agent['status']) => ({ id: 'a', name: 'Acme Site', status }) as Agent;

describe('a working agent in a list', () => {
  it('says the step it is on and for how long, not "Working…"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 332_000);
    render(
      <AgentWorkingLine
        agent={agent({
          state: 'working',
          activity: 'Running the Cypress tests',
          since: T0 - 60_000,
          work: {
            startedAt: T0 - 60_000,
            stepCount: 3,
            fileCount: 0,
            steps: [],
            current: {
              kind: 'command',
              label: 'Running the Cypress tests',
              startedAt: T0,
              streams: false,
              canStop: true,
            },
          },
        })}
      />
    );
    expect(screen.getByText(/Running the Cypress tests/).textContent).toBe(
      'Running the Cypress tests · 5m'
    );
  });

  it('between calls says it is thinking, timed from the turn', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 12_000);
    render(<AgentWorkingLine agent={agent({ state: 'working', activity: null, since: T0 })} />);
    expect(screen.getByText(/Thinking/).textContent).toBe('Thinking · 12s');
  });

  it('marks a working badge, which holds still under Reduce Motion (CSS)', () => {
    const { container } = render(<AgentAvatar name="Acme Site" color="green" working />);
    expect(container.querySelector('.agent-avatar--working')).not.toBeNull();
  });
});
