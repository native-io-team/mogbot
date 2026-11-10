import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/errorReporting', () => ({
  reportError: vi.fn(),
}));

import { toastDuration, useToasts } from './useToasts';
import { reportError } from '../lib/errorReporting';

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty toasts array', () => {
    const { result } = renderHook(() => useToasts());
    expect(result.current.toasts).toEqual([]);
  });

  it('adds a toast with default success type', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Hello');
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({
      message: 'Hello',
      type: 'success',
    });
  });

  it('adds a toast with specified type', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Error occurred', 'error');
    });

    expect(result.current.toasts[0].type).toBe('error');
  });

  it('assigns unique incrementing IDs', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('First');
      result.current.showToast('Second');
    });

    expect(result.current.toasts[0].id).toBeLessThan(result.current.toasts[1].id);
  });

  it('dismisses a toast by ID', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Keep me');
      result.current.showToast('Remove me');
    });

    const toRemove = result.current.toasts[1].id;

    act(() => {
      result.current.dismissToast(toRemove);
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Keep me');
  });

  it('auto-dismisses after 4000ms', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Temporary');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('auto-dismisses info toasts after 4000ms', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('FYI', 'info');
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('never auto-dismisses error toasts', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke: detail here', 'error');
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].type).toBe('error');
  });

  it('error toasts can still be dismissed manually', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke', 'error');
    });
    const id = result.current.toasts[0].id;

    act(() => {
      result.current.dismissToast(id);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('success toasts auto-dismiss while an error toast persists', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Something broke', 'error');
      result.current.showToast('All good');
    });
    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].type).toBe('error');
  });

  it('keeps max 5 toasts, removing oldest first', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let i = 1; i <= 6; i++) {
        result.current.showToast(`Toast ${i}`);
      }
    });

    expect(result.current.toasts).toHaveLength(5);
    expect(result.current.toasts[0].message).toBe('Toast 2');
    expect(result.current.toasts[4].message).toBe('Toast 6');
  });

  it('does nothing when dismissing non-existent ID', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Stays');
    });

    act(() => {
      result.current.dismissToast(9999);
    });

    expect(result.current.toasts).toHaveLength(1);
  });

  it('handles multiple auto-dismiss timers independently', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('First');
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    act(() => {
      result.current.showToast('Second');
    });

    // First toast should dismiss at 4000ms total
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('Second');

    // Second toast should dismiss at 6000ms total
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('reports error toasts to the admin agent', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Failed to create branch', 'error');
    });

    expect(vi.mocked(reportError)).toHaveBeenCalledWith({
      message: 'Failed to create branch',
      source: 'toast',
    });
  });

  it('does not report success or info toasts', () => {
    vi.mocked(reportError).mockClear();
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Saved', 'success');
      result.current.showToast('FYI', 'info');
    });

    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  /**
   * Issue #920: a refusal the app decided on ("that project already has the
   * maximum number of agent tabs") is a problem for the user and belongs in
   * an error toast, but it is not a malfunction and must not be filed as one.
   * Before this, the only way to stay out of telemetry was to demote the
   * message to `info`, which is why the same report kept coming back from a
   * different call site each time.
   */
  it('does not report an error toast the caller marked expected', () => {
    vi.mocked(reportError).mockClear();
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Close a tab and send this again.', 'error', undefined, {
        expected: true,
      });
    });

    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('still shows an expected error toast, and still keeps it on screen', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Close a tab and send this again.', 'error', undefined, {
        expected: true,
      });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({
      message: 'Close a tab and send this again.',
      type: 'error',
    });

    // Error toasts persist until dismissed — being expected doesn't change
    // that, only whether it is reported.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.toasts).toHaveLength(1);
  });

  it('reports an error toast that explicitly says it is not expected', () => {
    vi.mocked(reportError).mockClear();
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.showToast('Real failure', 'error', undefined, { expected: false });
    });

    expect(vi.mocked(reportError)).toHaveBeenCalledWith({
      message: 'Real failure',
      source: 'toast',
    });
  });

  it('counts the same message on its toast instead of stacking a copy, and restarts its clock', () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.showToast('Saved'));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => result.current.showToast('Saved'));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].count).toBe(2);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('holds a pointed-at toast and gives it its whole time again after', () => {
    const { result } = renderHook(() => useToasts());
    act(() => result.current.showToast('Saved'));
    const id = result.current.toasts[0].id;
    act(() => result.current.holdToast?.(id, true));
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => result.current.holdToast?.(id, false));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('gives a long toast longer, up to 10 s', () => {
    expect(toastDuration('Short')).toBe(4000);
    expect(toastDuration('x'.repeat(110))).toBe(6000);
    expect(toastDuration('x'.repeat(1000))).toBe(10000);
  });
});
