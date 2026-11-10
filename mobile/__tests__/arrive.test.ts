/**
 * The arrival rise is native only. On the web (qa:web), Reanimated's entering
 * animation for a customised preset can end on its timer and pin the row
 * `position: absolute` at window coordinates, which inside the chat's
 * inverted list drew an arrived row ~1,300px from where it belongs
 * (qa:web `torture-events`; Arrive.tsx).
 */

import { Platform } from 'react-native';

jest.mock('react-native-reanimated', () => {
  const chain = { easing: () => chain, withInitialValues: () => chain, reduceMotion: () => chain };
  return {
    __esModule: true,
    default: { View: 'View' },
    Easing: { bezier: () => 'curve' },
    FadeInDown: { duration: () => chain },
    ReduceMotion: { System: 'system' },
  };
});

const load = (os: typeof Platform.OS) => {
  let mod: typeof import('../src/components/Arrive') | undefined;
  jest.isolateModules(() => {
    // The module registry is fresh here, so this is the Platform Arrive reads.
    const rn: typeof import('react-native') = require('react-native');
    Object.defineProperty(rn.Platform, 'OS', { value: os, configurable: true });
    mod = require('../src/components/Arrive');
  });
  return mod!;
};

it('rises in on iOS and Android', () => {
  expect(load('ios').arriving()).toBeDefined();
  expect(load('android').arriving()).toBeDefined();
});

it('holds still on the web, so no row is pinned out of place', () => {
  expect(load('web').arriving()).toBeUndefined();
});
