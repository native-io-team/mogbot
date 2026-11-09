import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __armedClocks, useNow } from './useNow';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 300));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the interval boundary, and every hook on one interval shares one timer', () => {
    const a = renderHook(() => useNow(true, 5_000));
    const b = renderHook(() => useNow(true, 5_000));
    expect(__armedClocks()).toBe(1);
    const start = a.result.current;
    act(() => {
      vi.advanceTimersByTime(4_699);
    });
    expect(a.result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(a.result.current % 5_000).toBe(0);
    expect(b.result.current).toBe(a.result.current);
    a.unmount();
    b.unmount();
    expect(__armedClocks()).toBe(0);
  });

  it('has no timer while disabled, and starts from now when enabled after a while', () => {
    const { result, rerender, unmount } = renderHook(({ on }) => useNow(on, 1_000), {
      initialProps: { on: false },
    });
    expect(__armedClocks()).toBe(0);
    vi.setSystemTime(Date.now() + 60_000);
    rerender({ on: true });
    expect(result.current).toBe(Date.now());
    expect(__armedClocks()).toBe(1);
    unmount();
  });

  it('holds while the window is hidden and catches up when it shows', () => {
    const { result, unmount } = renderHook(() => useNow(true, 1_000));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(__armedClocks()).toBe(0);
    const held = result.current;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(held);
    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(Date.now());
    expect(__armedClocks()).toBe(1);
    visibility.mockRestore();
    unmount();
  });
});
