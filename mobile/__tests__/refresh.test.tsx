import { act, renderHook } from '@testing-library/react-native';
import { REFRESH_DONE_MS, REFRESH_TIMEOUT_MS, useRefresh } from '../src/lib/refresh';

const MIN_REFRESH_MS = 0; // there is no minimum any more

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** Let resolved promises run, then move the clock. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('useRefresh: the spinner always lets go', () => {
  it('a fast refresh ends as soon as it settles: no artificial minimum spin', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => useRefresh(run));
    expect(result.current.refreshing).toBe(false);
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(0);
    expect(result.current.refreshing).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a slow refresh ends when it settles, not before', async () => {
    let finish!: () => void;
    const run = jest.fn(() => new Promise<void>((r) => (finish = r)));
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(2000);
    expect(result.current.refreshing).toBe(true);
    await act(() => finish());
    await advance(0);
    expect(result.current.refreshing).toBe(false);
  });

  it('a failed refresh ends too', async () => {
    const run = jest.fn().mockRejectedValue(new Error('offline'));
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(MIN_REFRESH_MS);
    expect(result.current.refreshing).toBe(false);
  });

  it('a refresh that never answers is let go', async () => {
    const run = jest.fn(() => new Promise<void>(() => {}));
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(REFRESH_TIMEOUT_MS);
    expect(result.current.refreshing).toBe(false);
  });

  it('a second pull joins the one in flight', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
      void result.current.onRefresh();
    });
    await advance(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(false);
  });

  it('sets nothing after the screen is gone', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await unmount();
    await advance(MIN_REFRESH_MS);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('goes false → true → false exactly once per pull, whatever the outcome', async () => {
    for (const run of [
      jest.fn().mockResolvedValue(undefined), // the same data back
      jest.fn().mockRejectedValue(new Error('timed out')),
      jest.fn(() => {
        throw new Error('thrown before any promise');
      }),
      jest.fn(() => undefined), // offline: nothing to do
    ]) {
      const seen: boolean[] = [];
      const { result } = await renderHook(() => {
        const r = useRefresh(run);
        if (seen[seen.length - 1] !== r.refreshing) seen.push(r.refreshing);
        return r;
      });
      // A second pull while the first is in flight: joins, never flips it.
      await act(() => {
        void result.current.onRefresh();
        void result.current.onRefresh();
      });
      await advance(0);
      expect(seen).toEqual([false, true, false]);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

describe('useRefresh: it says how it went', () => {
  it('a refresh that worked is "done" for a moment, then idle again', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => useRefresh(run));
    expect(result.current.outcome).toBe('idle');
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(0);
    expect(result.current.outcome).toBe('done');
    await advance(REFRESH_DONE_MS);
    expect(result.current.outcome).toBe('idle');
  });

  it('a failed refresh stays "failed" until it is dismissed', async () => {
    const run = jest.fn().mockRejectedValue(new Error('offline'));
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(REFRESH_DONE_MS * 4);
    expect(result.current.outcome).toBe('failed');
    await act(() => result.current.dismiss());
    expect(result.current.outcome).toBe('idle');
  });

  it('a refresh that never answers is a failure, and trying again clears it', async () => {
    let calls = 0;
    const run = jest.fn(() => (++calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()));
    const { result } = await renderHook(() => useRefresh(run));
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(REFRESH_TIMEOUT_MS);
    expect(result.current.outcome).toBe('failed');
    await act(() => {
      void result.current.onRefresh();
    });
    await advance(0);
    expect(result.current.outcome).toBe('done');
  });
});
