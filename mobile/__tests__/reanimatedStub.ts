/**
 * Reanimated and Worklets as the gesture tests need them: worklets run as
 * plain functions, a shared value is a ref, an animated style is computed on
 * render, and every animation lands at once. Real Reanimated needs its native
 * module, which jest doesn't have. Use inside a `jest.mock` factory:
 *
 *   jest.mock('react-native-reanimated', () => require('./reanimatedStub').reanimated());
 *   jest.mock('react-native-worklets', () => require('./reanimatedStub').worklets());
 */

import type { ComponentType } from 'react';

export function worklets() {
  return {
    scheduleOnRN: (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => fn(...args),
    isWorkletFunction: () => false,
  };
}

export function reanimated(extra: Record<string, unknown> = {}) {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const React = jest.requireActual<typeof import('react')>('react');
  const land = (to: number) => to;
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: ComponentType) => c },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
    useSharedValue: <T>(value: T) =>
      React.useRef({
        value,
        get() {
          return this.value;
        },
        set(next: T | ((prev: T) => T)) {
          this.value = typeof next === 'function' ? (next as (prev: T) => T)(this.value) : next;
        },
      }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: land,
    withSpring: land,
    withDecay: () => 0,
    cancelAnimation: () => {},
    interpolate: (v: number, [a, b]: number[], [c, d]: number[]) =>
      c + ((Math.min(Math.max(v, a), b) - a) / (b - a)) * (d - c),
    isSharedValue: () => false,
    // What Gesture Handler reaches for when Reanimated is installed.
    useComposedEventHandler: () => undefined,
    useEvent: () => undefined,
    useHandler: () => ({ doDependenciesDiffer: false, context: {} }),
    ...extra,
  };
}
