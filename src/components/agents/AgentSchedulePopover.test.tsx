import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentSchedulePopover } from './AgentSchedulePopover';
import type { Agent, CheckIn } from '../../lib/agents';

vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  refreshAgents: () => Promise.resolve(),
}));

afterEach(() => clearMocks());

const COVERAGE =
  'Covers the 300 most recently updated of 412 assigned; an older one that changes may start work as if new.';

describe('AgentSchedulePopover', () => {
  it('shows a “When…” routine’s coverage caveat as text, not behind hover', async () => {
    mockIPC(() => null);
    const watching = {
      id: 'w4',
      note: 'Say which ones are blocked and by whom.',
      nextAt: 0,
      createdAt: 0,
      paused: false,
      watch: {
        source: { kind: 'github_assigned' },
        everyMinutes: 10,
        lastFound: 0,
        failures: 0,
        coverage: COVERAGE,
      },
    } as CheckIn;
    const agent = { id: 'a1', name: 'Finance', checkIns: [watching] } as Agent;
    render(<AgentSchedulePopover agent={agent} open onOpenChange={vi.fn()} />);
    const line = await screen.findByText(COVERAGE);
    expect(line).toBeVisible();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
