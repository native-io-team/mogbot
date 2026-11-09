/**
 * Battery: nothing loops or ticks for a screen nobody can see. In the
 * background (or on a screen under another), the spinner, typing dots and
 * shimmer start no Reanimated loop, the "2 min ago" clock stops, and a live
 * view's polling has no timer at all; back in front, each picks up at once.
 */

import { act, render, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

const mockRepeat = jest.fn((to: unknown) => to);
let mockFocused = true;
jest.mock('react-native-reanimated', () =>
  require('./reanimatedStub').reanimated({
    withRepeat: (a: unknown) => mockRepeat(a),
    useReducedMotion: () => false,
    Easing: {
      inOut: () => (t: number) => t,
      linear: (t: number) => t,
      quad: (t: number) => t,
      sin: (t: number) => t,
    },
  })
);
jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  // usePolling runs on focus; here the screen is focused while mounted.
  useFocusEffect: (fn: () => (() => void) | void) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(fn, [fn]);
  },
}));
jest.mock('../src/lib/session', () => ({ retryNow: jest.fn() }));
jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/store', () => ({
  useApp: (pick: (s: { link: { kind: string } }) => unknown) =>
    pick({ link: { kind: 'connected' } }),
}));

import { Spinner } from '../src/components/agent';
import { TypingDots } from '../src/components/TypingDots';
import { useNow } from '../src/components/ConnectionPill';
import { usePolling } from '../src/lib/usePolling';

let listeners: ((s: AppStateStatus) => void)[] = [];
function setAppState(s: AppStateStatus) {
  Object.defineProperty(AppState, 'currentState', { value: s, configurable: true });
  listeners.forEach((l) => l(s));
}

beforeEach(() => {
  jest.useFakeTimers();
  listeners = [];
  mockFocused = true;
  mockRepeat.mockClear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
    listeners.push(fn as (s: AppStateStatus) => void);
    return {
      remove: () => (listeners = listeners.filter((l) => l !== fn)),
    } as never;
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('loops on the UI thread', () => {
  it('the spinner and typing dots loop only while the app is in front', async () => {
    setAppState('background');
    await render(
      <>
        <Spinner />
        <TypingDots />
      </>
    );
    expect(mockRepeat).not.toHaveBeenCalled();
    await act(async () => setAppState('active'));
    expect(mockRepeat).toHaveBeenCalledTimes(2);
  });

  it('on a screen that is not showing, nothing loops', async () => {
    mockFocused = false;
    await render(<Spinner />);
    expect(mockRepeat).not.toHaveBeenCalled();
  });
});

describe('clocks and polling', () => {
  it('the "2 min ago" clock stops in the background and catches up in front', async () => {
    const { result } = await renderHook(() => useNow(1000));
    const first = result.current;
    await act(async () => jest.advanceTimersByTime(1000));
    expect(result.current).toBeGreaterThan(first);

    const cleared = jest.spyOn(global, 'clearInterval');
    await act(async () => setAppState('background'));
    const held = result.current;
    // Its interval is gone, not left waking to skip.
    expect(cleared).toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(result.current).toBe(held);

    await act(async () => setAppState('active'));
    await act(async () => jest.advanceTimersByTime(0));
    expect(result.current).toBeGreaterThan(held);
  });

  it('a live view polls in front, has no timer in the background, and reads at once on return', async () => {
    const fn = jest.fn(() => Promise.resolve());
    await renderHook(() => usePolling(fn, 1000));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(2);

    const cleared = jest.spyOn(global, 'clearInterval');
    await act(async () => setAppState('background'));
    expect(cleared).toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => setAppState('active'));
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
