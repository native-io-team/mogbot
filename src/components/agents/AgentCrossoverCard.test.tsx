import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalCard } from './AgentChatItems';
import { ARM_MS } from './useCardGuard';
import type { AgentMessage, Approval } from '../../lib/agents';

const TITLE =
  'All your Claude Code accounts are out until 4:00 PM. Carry on with Codex until then?';

const card = (over: Partial<Approval> = {}): AgentMessage => ({
  id: 'm1',
  agentId: 'riley',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: {
    requestId: 'r1',
    title: TITLE,
    detail: '',
    summary:
      "Codex can't open Claude Code's conversation, so Riley starts there from your chat and its memory.",
    status: 'pending',
    crossover: { from: 'claude', to: 'codex', until: Date.now() + 3 * 3600_000, resume: true },
    ...over,
  },
});

const renderCard = (m: AgentMessage, onAnswer = vi.fn(async () => {})) =>
  render(<ApprovalCard message={m} agentName="Riley" paused={false} onAnswer={onAnswer} />);

afterEach(() => vi.useRealTimers());

describe('Carry on with the other engine (card)', () => {
  it('asks in plain words with Wait, Just this time and Always, the strong one neutral and last', () => {
    renderCard(card());
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText(/starts there from your chat and its memory/)).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.slice(-3)).toEqual(['Wait', 'Just this time', 'Always']);
    const always = screen.getByRole('button', { name: 'Always' });
    // Answers are neutral, never the accent.
    expect(always.className).not.toMatch(/primary/);
    expect(screen.getByRole('button', { name: 'Wait' }).className).toMatch(/secondary/);
  });

  it('sends Always as allow + always, Just this time as allow, Wait as deny', () => {
    vi.useFakeTimers();
    for (const [label, args] of [
      ['Always', ['r1', true, true]],
      ['Just this time', ['r1', true, false]],
      ['Wait', ['r1', false, false]],
    ] as const) {
      const onAnswer = vi.fn(async () => {});
      const { unmount } = renderCard(card(), onAnswer);
      act(() => {
        vi.advanceTimersByTime(ARM_MS + 10);
      });
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: label }), { detail: 1 });
      });
      expect(onAnswer).toHaveBeenCalledWith(...args);
      unmount();
    }
  });

  it('answered, it is one line saying what happens now', () => {
    const { unmount } = renderCard(card({ status: 'allowed', choice: 'Always' }));
    expect(
      screen.getByText('Always · carrying on with Codex whenever Claude Code is out')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Wait' })).toBeNull();
    unmount();
    renderCard(card({ status: 'denied', choice: 'Wait' }));
    expect(screen.getByText('Waiting · back when Claude Code resets')).toBeTruthy();
  });

  it('closed by the app when the engine has room again, it says so', () => {
    renderCard(
      card({ status: 'expired', setAside: 'Claude Code has room again, so this closed.' })
    );
    expect(screen.getByText('Claude Code has room again, so this closed.')).toBeTruthy();
  });
});
