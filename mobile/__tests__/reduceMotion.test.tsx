/**
 * Reduce Motion turned on while the app is open: a key's pulse and the
 * loops (`useMoving`) stop at once, not at the next launch
 * (Reanimated's own hook reads the setting only once).
 */

import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo, AppState } from 'react-native';
import { useMoving } from '../src/lib/moving';

jest.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

beforeAll(() => {
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

it('stops moving when Reduce Motion is turned on, and moves again when it is off', async () => {
  let changed: (on: boolean) => void = () => {};
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation((_name: string, fn: (on: boolean) => void) => {
      changed = fn;
      return { remove: jest.fn() } as never;
    });
  const { result } = await renderHook(() => useMoving(false));
  await act(async () => {});
  expect(result.current).toBe(true);
  await act(async () => changed(true));
  expect(result.current).toBe(false);
  await act(async () => changed(false));
  expect(result.current).toBe(true);
});

it('already on at launch: still from the first frame', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const { result } = await renderHook(() => useMoving(false));
  await act(async () => {});
  expect(result.current).toBe(false);
});
