/**
 * Admins on the desk: the per-agent switch (on for the Chief by default),
 * Admin activity and Recently deleted in Settings, and an admin's batch of
 * requests answered for the agent that asked. Fictional agents only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  setAdmin: vi.fn(),
  adminActivity: vi.fn(),
  recentlyDeleted: vi.fn(),
  restoreAgent: vi.fn(),
}));
vi.mock('../../lib/agentAdmin', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentAdmin')>()),
  ...api,
}));
const answerApproval = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  answerApproval,
}));
const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const loadMessages = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents: () => Promise.resolve(),
  loadMessages,
  useAgentsSelector: (select: (s: unknown) => unknown) => select(store.value),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', () => ({ useOptionalToast: () => ({ showToast }) }));

import { AgentAdminSettings, DecideCards } from './AgentAdmin';
import { isAdmin, restorableLine } from '../../lib/agentAdmin';
import type { Agent, AgentMessage } from '../../lib/agents';

const agent = (id: string, name: string, over: Partial<Agent> = {}) =>
  ({ id, name, role: '', isMain: false, hidden: false, ...over }) as Agent;

describe('isAdmin', () => {
  it('is on for the Chief unless the user turned it off, off for others unless turned on', () => {
    expect(isAdmin({ isMain: true })).toBe(true);
    expect(isAdmin({ isMain: true, admin: false })).toBe(false);
    expect(isAdmin({ isMain: false })).toBe(false);
    expect(isAdmin({ isMain: false, admin: true })).toBe(true);
  });

  it('says how long a deleted agent can come back', () => {
    const now = 1_000_000_000;
    expect(restorableLine(now + 12 * 86_400_000, now)).toBe('Restorable for 12 more days');
    expect(restorableLine(now + 3_600_000, now)).toBe('Restorable until tomorrow');
    expect(restorableLine(now - 1, now)).toBe('Removed for good soon');
  });
});

describe('AgentAdminSettings', () => {
  beforeEach(() => {
    api.setAdmin.mockReset().mockResolvedValue({});
    api.adminActivity.mockReset().mockResolvedValue([
      {
        ts: Date.now(),
        admin: { id: 'chief', name: 'Chief of Staff' },
        target: { id: 'ledger', name: 'Ledger' },
        action: 'Allowed for Ledger: look inside your Kite folder',
      },
    ]);
    api.recentlyDeleted.mockReset().mockResolvedValue([
      {
        id: 'kite',
        name: 'Kite Watch',
        role: '',
        color: 'teal',
        deletedAt: Date.now(),
        restorableUntil: Date.now() + 30 * 86_400_000,
        deletedBy: { id: 'chief', name: 'Chief of Staff' },
      },
    ]);
    api.restoreAgent.mockReset().mockResolvedValue({});
    store.value = {
      loaded: true,
      agents: [agent('chief', 'Chief of Staff', { isMain: true }), agent('ledger', 'Ledger')],
      messages: {},
    };
  });

  it('shows who is admin, what admins did, and restores a deleted agent', async () => {
    render(<AgentAdminSettings />);
    await screen.findByText('Allowed for Ledger: look inside your Kite folder');
    expect(screen.getByRole('switch', { name: 'Chief of Staff: admin' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: 'Ledger: admin' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(
      screen.getByText('Allowed for Ledger: look inside your Kite folder')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Deleted by Chief of Staff · Restorable for 30 more days/)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Ledger: admin' }));
    await act(() => Promise.resolve());
    expect(api.setAdmin).toHaveBeenCalledWith('ledger', true);

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await act(() => Promise.resolve());
    expect(api.restoreAgent).toHaveBeenCalledWith('kite');
  });
});

describe('DecideCards', () => {
  const push = {
    requestId: 'lg-push',
    title: 'Run a command',
    detail: 'git push origin main',
    summary: 'Push code to the project’s online copy — so the pricing page goes live',
    status: 'pending' as const,
    tool: 'Bash',
    input: { command: 'git push origin main' },
  };
  const batch: AgentMessage = {
    id: 'm1',
    agentId: 'chief',
    ts: Date.now(),
    kind: 'agent',
    text: '1 thing only you can decide:',
    decide: [{ agentId: 'ledger', agentName: 'Ledger', approval: push }],
  } as AgentMessage;

  beforeEach(() => {
    answerApproval.mockClear();
    loadMessages.mockClear();
    store.value = { loaded: true, agents: [], messages: {} };
  });

  it('leads with the plain line, folds the command, and answers for the agent that asked', async () => {
    vi.useFakeTimers();
    render(<DecideCards message={batch} />);
    expect(screen.getByText('Ledger')).toBeInTheDocument();
    expect(screen.getByText(push.summary)).toBeInTheDocument();
    expect(screen.queryByText('git push origin main')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('git push origin main')).toBeInTheDocument();
    // Its chat is read so the card is live here.
    expect(loadMessages).toHaveBeenCalledWith('ledger');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await act(() => Promise.resolve());
    expect(answerApproval).toHaveBeenCalledWith(
      'ledger',
      'lg-push',
      false,
      false,
      undefined,
      undefined
    );
  });
});
