import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Agent } from '../../lib/agents';
import { RESORT_MS, SETTLE_MS, useAttentionOrder, useSteadyList } from './useAttentionOrder';

const a = (id: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    name: id,
    pinned: false,
    hidden: false,
    pendingApprovals: 0,
    lastActivityAt: 0,
    status: { state: 'idle' },
    ...over,
  }) as unknown as Agent;

const ids = (list: Agent[]) => list.map((x) => x.id);

describe('useAttentionOrder', () => {
  let el: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    document.body.appendChild(el);
  });
  afterEach(() => {
    vi.useRealTimers();
    el.remove();
  });

  const setup = () => {
    const ref = { current: el };
    const first = [
      a('x', { lastActivityAt: 3 }),
      a('y', { lastActivityAt: 2 }),
      a('z', { lastActivityAt: 1 }),
    ];
    const hook = renderHook(({ agents }) => useAttentionOrder(agents, ref), {
      initialProps: { agents: first },
    });
    return { hook, first };
  };

  it('re-sorts straight away while nobody is using the list', () => {
    const { hook, first } = setup();
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);
    hook.rerender({ agents: [first[0], first[1], a('z', { pendingApprovals: 1 })] });
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
  });

  it('holds rows still under the pointer, and sorts 2s after it leaves', () => {
    const { hook, first } = setup();
    act(() => void el.dispatchEvent(new Event('pointerenter')));
    hook.rerender({ agents: [first[0], first[1], a('z', { pendingApprovals: 1 })] });
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);
    act(() => void vi.advanceTimersByTime(SETTLE_MS * 3));
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);

    act(() => void el.dispatchEvent(new Event('pointerleave')));
    act(() => void vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);
    act(() => void vi.advanceTimersByTime(1));
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
  });

  it('holds still while scrolling, until 2s after the last scroll', () => {
    const { hook, first } = setup();
    act(() => void el.dispatchEvent(new Event('wheel')));
    hook.rerender({
      agents: [
        first[0],
        first[1],
        a('z', { status: { state: 'working' } } as unknown as Partial<Agent>),
      ],
    });
    act(() => void vi.advanceTimersByTime(SETTLE_MS - 500));
    act(() => void el.dispatchEvent(new Event('scroll')));
    act(() => void vi.advanceTimersByTime(SETTLE_MS - 1));
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);
    act(() => void vi.advanceTimersByTime(1));
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
  });

  it('sorts when the window comes back to the front', () => {
    const { hook, first } = setup();
    act(() => void el.dispatchEvent(new Event('keydown')));
    hook.rerender({ agents: [first[0], first[1], a('z', { pendingApprovals: 1 })] });
    expect(ids(hook.result.current)).toEqual(['x', 'y', 'z']);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
  });

  it('a pin moves its row at once, even while the list is in use', () => {
    const { hook, first } = setup();
    act(() => void el.dispatchEvent(new Event('pointerenter')));
    hook.rerender({ agents: [first[0], first[1], a('z', { pinned: true })] });
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
  });

  it('shows the latest data for each row even while the order holds', () => {
    const { hook, first } = setup();
    act(() => void el.dispatchEvent(new Event('pointerenter')));
    hook.rerender({ agents: [first[0], first[1], a('z', { pendingApprovals: 4 })] });
    expect(hook.result.current[2].pendingApprovals).toBe(4);
  });

  it('re-sorts at most once every few seconds, however busy the team is', () => {
    const { hook, first } = setup();
    hook.rerender({ agents: [first[0], first[1], a('z', { lastActivityAt: 9 })] });
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
    // y does something a moment later: it waits its turn.
    hook.rerender({
      agents: [first[0], a('y', { lastActivityAt: 10 }), a('z', { lastActivityAt: 9 })],
    });
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
    act(() => void vi.advanceTimersByTime(RESORT_MS - 1));
    expect(ids(hook.result.current)).toEqual(['z', 'x', 'y']);
    act(() => void vi.advanceTimersByTime(1));
    expect(ids(hook.result.current)).toEqual(['y', 'z', 'x']);
  });

  it('brings the Needs your OK row in and out with the order, never under the pointer', () => {
    const ref = { current: el };
    const agents = [a('x'), a('y')];
    const hook = renderHook(({ waiting }) => useSteadyList(agents, ref, waiting), {
      initialProps: { waiting: false },
    });
    act(() => void el.dispatchEvent(new Event('pointerenter')));
    hook.rerender({ waiting: true });
    expect(hook.result.current.waiting).toBe(false);
    act(() => void el.dispatchEvent(new Event('pointerleave')));
    act(() => void vi.advanceTimersByTime(SETTLE_MS));
    expect(hook.result.current.waiting).toBe(true);
    // Answered at once: it stays its moment before it goes.
    hook.rerender({ waiting: false });
    expect(hook.result.current.waiting).toBe(true);
    act(() => void vi.advanceTimersByTime(RESORT_MS));
    expect(hook.result.current.waiting).toBe(false);
  });
});
