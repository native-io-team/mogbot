import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { appActivity, appQuiet, onAppActivity, resetAppActivityForTests } from './appActivity';
import { ExponentialPoller } from './polling';
import { usePolling } from '../hooks/usePolling';

/** Make the window hidden or visible, as WebKit reports it. */
function setHidden(hidden: boolean) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible');
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Another app takes focus (or gives it back). */
async function setBackground(background: boolean) {
  vi.spyOn(document, 'hasFocus').mockReturnValue(!background);
  window.dispatchEvent(new Event(background ? 'blur' : 'focus'));
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(async () => {
  vi.useFakeTimers();
  setHidden(false);
  await setBackground(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetAppActivityForTests();
});

describe('app activity', () => {
  it('mirrors hidden and background onto the root and tells subscribers', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    onAppActivity((s) => seen.push(`${s.hidden}/${s.background}`));
    expect(appActivity()).toEqual({ hidden: false, background: false });

    await setBackground(true);
    expect(appQuiet()).toBe(true);
    expect(document.documentElement.hasAttribute('data-app-background')).toBe(true);
    expect(document.documentElement.hasAttribute('data-app-hidden')).toBe(false);

    setHidden(true);
    expect(document.documentElement.hasAttribute('data-app-hidden')).toBe(true);

    setHidden(false);
    await setBackground(false);
    expect(appQuiet()).toBe(false);
    expect(document.documentElement.hasAttribute('data-app-background')).toBe(false);
    expect(seen).toEqual(['false/true', 'true/true', 'false/true', 'false/false']);
  });

  it('a blur into one of our own iframes is not the background', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(0);
    expect(appActivity().background).toBe(false);
  });
});

describe('polling while hidden', () => {
  it('the poller holds while paused and resumes on its own cadence', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(1);
    const p = new ExponentialPoller(fetcher, () => {}, {
      initialInterval: 1000,
      maxInterval: 1000,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Paused 400ms into the interval: nothing runs, however long it lasts.
    await vi.advanceTimersByTimeAsync(400);
    p.pause();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Overdue: it runs at once on resume, then every interval again.
    p.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Not yet due: a quick hide-and-show waits out the rest of the interval.
    await vi.advanceTimersByTimeAsync(300);
    p.pause();
    p.resume();
    await vi.advanceTimersByTimeAsync(600);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it('a poll in flight when paused schedules nothing after it', async () => {
    vi.useFakeTimers();
    let finish: (v: number) => void = () => {};
    const fetcher = vi.fn(() => new Promise<number>((r) => (finish = r)));
    const p = new ExponentialPoller(fetcher, () => {}, {
      initialInterval: 1000,
      maxInterval: 1000,
    });
    p.start();
    p.pause();
    finish(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    p.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('usePolling stops polling while the window is hidden and catches up when seen', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('only the background (visible, unfocused) keeps polling', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(fn, { intervalMs: 1000 }));
    await setBackground(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    unmount();
  });

  it('whileHidden keeps a poll with an effect outside the window going', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(fn, { intervalMs: 1000, whileHidden: true }));
    setHidden(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3);
    unmount();
  });
});
