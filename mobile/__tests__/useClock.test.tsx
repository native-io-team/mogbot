/** The shared clock (`useClock.ts`): it stops at its last reading, and one tick serves every row. */

import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
import { useClock, useClockText } from '../src/lib/useClock';

// Each test starts later than the last: the clock is the app's, not the test's.
let start = Math.ceil(Date.now() / 1000) * 1000;
beforeEach(() => {
  start += 3_600_000;
  jest.useFakeTimers({ now: start });
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});
afterEach(() => jest.useRealTimers());
const pass = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

it('counts while active, and keeps its last reading when it stops', async () => {
  const { result, rerender } = await renderHook((on: boolean) => useClock(on), {
    initialProps: true,
  });
  await pass(5000);
  expect(result.current).toBe(start + 5000);
  await rerender(false);
  expect(result.current).toBe(start + 5000);
  await pass(5000);
  await rerender(false);
  expect(result.current).toBe(start + 5000);
  await rerender(true);
  expect(result.current).toBe(start + 10_000);
});

it('never counting, it stays at its first draw while another counts', async () => {
  const still = await renderHook(() => useClock(false));
  await renderHook(() => useClock(true));
  await pass(5000);
  await still.rerender(undefined);
  expect(still.result.current).toBe(start);
});

it('words keep the last reading too, drawn again only when they change', async () => {
  let draws = 0;
  const { result, rerender } = await renderHook(
    (on: boolean) => {
      draws++;
      return useClockText(on, (now) => `${Math.floor((now - start) / 60_000)}m`);
    },
    { initialProps: true }
  );
  const first = draws;
  await pass(50_000);
  expect(draws).toBe(first);
  await pass(130_000);
  expect(result.current).toBe('3m');
  await rerender(false);
  expect(result.current).toBe('3m');
});
