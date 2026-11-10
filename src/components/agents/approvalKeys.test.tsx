import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { approvalKey } from './approvalKeys';
import { ARM_MS } from './useCardGuard';
import type { AgentMessage } from '../../lib/agents';

const key = (k: string, extra: Partial<Parameters<typeof approvalKey>[0]> = {}) =>
  approvalKey({
    key: k,
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: document.body,
    ...extra,
  });

describe('approvalKey', () => {
  it('reads A and D, either case, and nothing else', () => {
    expect(key('a')).toBe('allow');
    expect(key('D')).toBe('deny');
    expect(key('y')).toBeNull();
    expect(key('Enter')).toBeNull();
  });

  it('never with a modifier, a held key, or typing in a field', () => {
    expect(key('a', { metaKey: true })).toBeNull();
    expect(key('a', { shiftKey: true })).toBeNull();
    expect(key('a', { repeat: true })).toBeNull();
    expect(key('a', { defaultPrevented: true })).toBeNull();
    const field = document.createElement('textarea');
    expect(key('a', { target: field })).toBeNull();
  });
});

const card = (): AgentMessage => ({
  id: 'm1',
  agentId: 'acme',
  ts: 1,
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'req1',
    tool: 'Bash',
    title: 'Run a command',
    input: { command: 'npm test' },
    detail: 'npm test',
    status: 'pending',
  },
});

describe('A and D on a focused approval card', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answer only while the card has focus, and Allow only once it is armed', () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<ApprovalCard message={card()} agentName="Acme" paused={false} onAnswer={onAnswer} />);
    const row = document.querySelector<HTMLElement>('[data-keys]')!;
    expect(row).not.toBeNull();
    // Pressed anywhere else, nothing.
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(onAnswer).not.toHaveBeenCalled();
    // On the card before it arms: Allow waits.
    row.focus();
    fireEvent.keyDown(row, { key: 'a' });
    expect(onAnswer).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(ARM_MS + 10);
    });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onAnswer).toHaveBeenCalledWith('req1', true, false, undefined);
  });

  it('D denies, and the buttons carry the hints', () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    render(<ApprovalCard message={card()} agentName="Acme" paused={false} onAnswer={onAnswer} />);
    expect(screen.getByRole('button', { name: /Deny/ })).toHaveAttribute('aria-keyshortcuts', 'D');
    expect(screen.getByRole('button', { name: /Allow/ })).toHaveAttribute(
      'aria-keyshortcuts',
      'A'
    );
    const row = document.querySelector<HTMLElement>('[data-keys]')!;
    fireEvent.keyDown(row, { key: 'd' });
    expect(onAnswer).toHaveBeenCalledWith('req1', false, false, undefined);
  });
});
