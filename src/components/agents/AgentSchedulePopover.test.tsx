import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('a failed run reads as one line: no full stop before “·”, “need” for two apps', async () => {
    mockIPC(() => null);
    const routine = {
      id: 'r1',
      note: 'Brief me.',
      repeat: { kind: 'days', days: [1], hour: 9, minute: 0 },
      nextAt: Date.now() + 86_400_000,
      createdAt: 0,
      paused: false,
      runs: [
        {
          at: Date.now() - 3_600_000,
          outcome: 'failed',
          attempt: 1,
          detail: 'Claude Code is signed out.',
          signIn: ['Gmail', 'Slack'],
        },
      ],
    } as unknown as CheckIn;
    const agent = { id: 'a1', name: 'Finance', checkIns: [routine] } as Agent;
    render(<AgentSchedulePopover agent={agent} open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Past runs/ }));
    const line = await screen.findByText(/need signing in again/);
    expect(line.textContent).toContain(
      'Claude Code is signed out · Gmail, Slack need signing in again'
    );
  });

  it('makes a monthly routine: one more chip, then a sentence', async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === 'agents_schedule_preview') return { nextAt: Date.now() + 86_400_000 };
      if (cmd === 'agents_usage_agent') return null;
      return null;
    });
    const agent = { id: 'a1', name: 'Finance', checkIns: [] } as unknown as Agent;
    render(<AgentSchedulePopover agent={agent} open onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Monthly' }));
    // Every month on the 1st, by default.
    expect(screen.getByRole('button', { name: 'Every month' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const which = screen.getByRole('combobox', { name: 'Which' });
    const kind = screen.getByRole('combobox', { name: 'Day or weekday' });
    expect(which).toHaveValue('1');
    // The last Friday.
    fireEvent.change(kind, { target: { value: '5' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Which' }), {
      target: { value: '-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Every 3 months' }));
    expect(screen.getByText(/^Every 3 months on the last Friday at/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('What Finance should do'), {
      target: { value: 'Close the books' },
    });
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === 'agents_schedule_preview' &&
            c.args.when === 'every 3 months on the last friday at 09:00'
        )
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === 'agents_schedule_create')?.args).toMatchObject({
        when: 'every 3 months on the last friday at 09:00',
        note: 'Close the books',
      })
    );
  });

  it('opens a quarterly routine on its own months, and an unchanged edit keeps them', async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === 'agents_schedule_preview') return { nextAt: Date.now() + 86_400_000 };
      return null;
    });
    const quarterly = {
      id: 'q1',
      note: 'Estimated taxes',
      repeat: { kind: 'monthly', months: 3, on: { day: 15 }, hour: 9, minute: 0, from: 2027 * 12 },
      nextAt: new Date(2027, 0, 15, 9, 0).getTime(),
      createdAt: 0,
      paused: false,
    } as CheckIn;
    const agent = { id: 'a1', name: 'Finance', checkIns: [quarterly] } as Agent;
    render(<AgentSchedulePopover agent={agent} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Every 3 months on the 15th at 9:00 AM')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Estimated taxes”' }));
    expect(screen.getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Which' })).toHaveValue('15');
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === 'agents_schedule_preview' &&
            c.args.when === 'every 3 months on the 15th at 09:00 starting january'
        )
      ).toBe(true)
    );
    fireEvent.change(screen.getByLabelText('What Finance should do'), {
      target: { value: 'Pay estimated taxes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === 'agents_schedule_update')?.args).toMatchObject({
        when: '',
        note: 'Pay estimated taxes',
      })
    );
  });

  it('is a named dialog, not a menu: it holds a list and buttons, not menu items', async () => {
    mockIPC(() => null);
    const agent = { id: 'a1', name: 'Finance', checkIns: [] } as unknown as Agent;
    render(<AgentSchedulePopover agent={agent} open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('dialog', { name: 'Routines for Finance' })).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
