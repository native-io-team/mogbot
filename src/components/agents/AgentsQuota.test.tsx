import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentsQuota } from './AgentsQuota';
import type { Quota } from '../../lib/agents';

// Midday, so "an hour ago" is today ("reported it at …"), whatever time the suite runs.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 0, 15, 12, 0));
});

// Unmount (which stops listening) before the IPC mock goes.
afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
});

const HOUR = 3_600_000;

function serve(quotas: Quota[]) {
  mockIPC((cmd) => (cmd === 'agents_quota' ? quotas : null), { shouldMockEvents: true });
}

const claude = (usedPercent: number, extra: Partial<Quota['windows'][number]> = {}): Quota => ({
  engine: 'claude',
  windows: [
    {
      kind: 'seven_day',
      usedPercent,
      resetsAt: Date.now() + 50 * HOUR,
      limited: false,
      observedAt: Date.now() - HOUR,
      ...extra,
    },
  ],
});

describe('AgentsQuota', () => {
  it('says nothing when no engine reported its plan', async () => {
    serve([]);
    const { container } = render(<AgentsQuota place="sidebar" />);
    // Give the read a chance to land; still nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('a calm line below 90%, with which window and when in its tooltip', async () => {
    serve([claude(85)]);
    render(<AgentsQuota place="sidebar" />);
    const line = await screen.findByText(/^Claude usage 85% · refills /);
    expect(line).toHaveAttribute('data-tone', 'calm');
    expect(line.getAttribute('title')).toMatch(/As Claude Code reported it at .*weekly limit/);
  });

  it('amber from 90%, and at the limit itself', async () => {
    serve([claude(91)]);
    const { unmount } = render(<AgentsQuota place="team" />);
    expect(await screen.findByText(/^Claude usage 91%/)).toHaveAttribute('data-tone', 'warning');
    unmount();
    clearMocks();
    serve([claude(100, { limited: true })]);
    render(<AgentsQuota place="team" />);
    await waitFor(() =>
      expect(screen.getByText(/^Claude out of usage until /)).toHaveAttribute(
        'data-tone',
        'limited'
      )
    );
  });
});
