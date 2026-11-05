import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ApprovalCard } from './AgentChatItems';
import { ARM_MS } from './useCardGuard';
import type { AgentMessage, Approval } from '../../lib/agents';
import type { LoginRequest } from '../../lib/agentLogins';
import { loginCardView } from '../../lib/agentLogins';

const GMAIL: LoginRequest = {
  service: 'gmail',
  title: 'Gmail',
  askedAs: 'gmail work',
  why: 'Screen applications',
  abilities: [
    { id: 'read', label: 'Read and search your email' },
    { id: 'write', label: 'Draft and send email — it asks you on a card each time' },
  ],
  options: [
    { id: 'claude_ai', method: 'claude_ai', label: 'Connect Gmail', detail: 'Uses claude.ai.' },
    { id: 'browser', method: 'browser', label: 'Use my browser', detail: 'Your Chrome.' },
  ],
};

const X: LoginRequest = {
  service: 'x',
  title: 'X',
  why: 'Post the update',
  abilities: [{ id: 'read', label: 'Read your timeline' }],
  options: [
    { id: 'browser', method: 'browser', label: 'Use my browser', detail: 'Your Chrome.' },
    { id: 'key', method: 'key', label: 'Enter an API key', detail: 'A key, never a password.' },
  ],
  key: {
    name: 'x_key',
    purpose: 'Post',
    kind: 'api_key',
    fields: [{ label: 'X API bearer token', env: 'X_KEY' }],
    reference: 'secret:social/x_key',
  },
};

const card = (login: LoginRequest, over: Partial<Approval> = {}): AgentMessage => ({
  id: 'm1',
  agentId: 'recruiter',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'r1',
    title: 'Recruiter needs your Gmail',
    detail: login.why,
    status: 'pending',
    login,
    ...over,
  },
});

const renderCard = (m: AgentMessage, onAnswer = vi.fn()) =>
  render(<ApprovalCard message={m} agentName="Recruiter" paused={false} onAnswer={onAnswer} />);

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

describe('loginCardView', () => {
  const pending = { status: 'pending' as const, login: GMAIL };
  it('reads each phase from the status and the live flow', () => {
    expect(loginCardView(pending, 'Recruiter').phase).toBe('choose');
    expect(loginCardView(pending, 'Recruiter').primary?.id).toBe('claude_ai');
    const flow = (state: 'starting' | 'waiting' | 'failed' | 'cancelled') => ({
      ...pending,
      login: { ...GMAIL, flow: { state, option: 'claude_ai', startedAt: 0, message: 'Boom' } },
    });
    expect(loginCardView(flow('waiting'), 'Recruiter').phase).toBe('signing-in');
    expect(loginCardView(flow('starting'), 'Recruiter').phase).toBe('signing-in');
    expect(loginCardView(flow('failed'), 'Recruiter')).toMatchObject({
      phase: 'failed',
      flowLine: 'Boom',
    });
    expect(loginCardView(flow('cancelled'), 'Recruiter').phase).toBe('cancelled');
    expect(
      loginCardView({ status: 'allowed', choice: 'Connected · Gmail', login: GMAIL }, 'Recruiter')
    ).toMatchObject({ phase: 'connected', outcome: 'Connected · Gmail' });
    expect(
      loginCardView({ status: 'denied', note: 'Not needed', login: GMAIL }, 'Recruiter').outcome
    ).toBe('Not needed');
    expect(
      loginCardView({ status: 'expired', note: 'Moved', login: GMAIL }, 'Recruiter')
    ).toMatchObject({
      phase: 'covered',
      outcome: 'Moved',
    });
  });
});

describe('LoginCard', () => {
  it('leads with Connect, neutral, says what it can do, and has no password field', () => {
    renderCard(card(GMAIL));
    const connect = screen.getByRole('button', { name: 'Connect Gmail' });
    expect(connect.className).not.toMatch(/primary/);
    expect(connect.className).toMatch(/strong/);
    expect(screen.getByText(/asks you on a card each time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my browser' })).toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('Connect starts the sign-in on the Mac with the option chosen', async () => {
    vi.useFakeTimers();
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    renderCard(card(GMAIL));
    act(() => {
      vi.advanceTimersByTime(ARM_MS + 10);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }), { detail: 1 });
      await Promise.resolve();
    });
    expect(calls).toEqual([
      ['agents_login_start', { agentId: 'recruiter', requestId: 'r1', optionId: 'claude_ai' }],
    ]);
  });

  it('while signing in it says where, and only offers Cancel', async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
      return null;
    });
    renderCard(
      card({
        ...GMAIL,
        flow: {
          state: 'waiting',
          option: 'claude_ai',
          startedAt: 0,
          fromPhone: true,
          message: 'Open on your Mac.',
        },
      })
    );
    expect(document.querySelector('.agent-login__flow')).toHaveTextContent('Open on your Mac.');
    expect(screen.getByText('Started from your phone')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await Promise.resolve();
    });
    expect(calls).toEqual(['agents_login_cancel']);
  });

  it('only a key option opens a masked field, and the key goes only to the save command', async () => {
    vi.useFakeTimers();
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return { id: 's1' };
    });
    renderCard(card(X));
    expect(document.querySelector('input[type="password"]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(ARM_MS + 10);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enter an API key' }), { detail: 1 });
    const field = screen.getByLabelText('X API bearer token');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'xkey-123456789' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
      await Promise.resolve();
    });
    expect(calls).toEqual([
      ['agents_login_save_key', { agentId: 'recruiter', requestId: 'r1', value: 'xkey-123456789' }],
    ]);
  });

  it('a card nothing here can answer says why and offers only Not now', () => {
    renderCard(card({ ...GMAIL, options: [], noConnector: 'Recruiter runs on Codex.' }));
    expect(screen.getByText('Recruiter runs on Codex.')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Not now']);
  });

  it('an answered card shows its outcome', () => {
    renderCard(card(GMAIL, { status: 'allowed', choice: 'Connected · Gmail (work@acme.com)' }));
    expect(screen.getByText('Connected · Gmail (work@acme.com)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull();
  });
});
