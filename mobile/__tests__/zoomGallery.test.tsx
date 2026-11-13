/**
 * The photo viewer's gestures, driven through Gesture Handler's test
 * controller: a swipe at fit turns the page, a swipe while zoomed doesn't,
 * a pull down closes, and one tap hides what's drawn over the picture.
 *
 * Every gesture callback runs as the UI runtime would rebuild it (./uiRuntime),
 * and none may fail: on the phone a throw there kills the app, and here the
 * viewer's guard would only log it.
 */

import 'react-native-gesture-handler/jestSetup';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { ZoomGallery, type ZoomPage } from '../src/components/ZoomGallery';

jest.mock('react-native-worklets', () =>
  jest.requireActual<typeof import('./reanimatedStub')>('./reanimatedStub').worklets()
);
/** Every number the viewer put in a shared value: what its transforms are drawn from. */
const mockNumbersSet: number[] = [];
jest.mock('react-native-reanimated', () => {
  const base = jest
    .requireActual<typeof import('./reanimatedStub')>('./reanimatedStub')
    .reanimated();
  const useShared = base.useSharedValue;
  const recorded = new WeakSet<object>();
  return {
    ...base,
    useSharedValue: <T,>(start: T) => {
      const sv = useShared(start);
      if (recorded.has(sv)) return sv;
      recorded.add(sv);
      const set = sv.set.bind(sv);
      sv.set = (next) => {
        if (typeof next === 'number') mockNumbersSet.push(next);
        set(next);
      };
      return sv;
    },
  };
});
jest.mock('react-native-gesture-handler', () => {
  const actual = jest.requireActual<Record<string, unknown>>('react-native-gesture-handler');
  const { isWorklet, onUiRuntime } =
    jest.requireActual<typeof import('./uiRuntime')>('./uiRuntime');
  const onUi = (name: string) => (config: Record<string, unknown>) =>
    (actual[name] as (config: Record<string, unknown>) => unknown)(
      Object.fromEntries(
        Object.entries(config).map(([k, v]) => [k, isWorklet(v) ? onUiRuntime(v) : v])
      )
    );
  return {
    ...actual,
    usePinchGesture: onUi('usePinchGesture'),
    usePanGesture: onUi('usePanGesture'),
    useTapGesture: onUi('useTapGesture'),
  };
});
jest.mock('expo-image', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: () => <View /> };
});

const page = (key: string): ZoomPage => ({
  key,
  source: { uri: `file:///${key}` },
  label: key,
  onError: () => {},
});

async function draw(onIndex = jest.fn(), onClose = jest.fn()) {
  await render(
    <GestureHandlerRootView>
      <ZoomGallery
        pages={[page('a'), page('b'), page('c')]}
        start={1}
        width={400}
        height={800}
        onIndex={onIndex}
        onClose={onClose}
        overlay={<Text>over</Text>}
      />
    </GestureHandlerRootView>
  );
  return { onIndex, onClose };
}

// The test controller fills unset values with its own (translationX 100), so
// every pan here sets both axes.

/** One gesture, start to end, and any animation it starts run out. */
const fire = (id: string, events: Record<string, number>[]) =>
  act(() => {
    fireGestureHandler(getByGestureTestId(id), events);
    jest.runAllTimers();
  });

let warn: jest.SpyInstance<void, unknown[]>;
beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, 'warn');
});
afterEach(() => {
  jest.useRealTimers();
  const failures = warn.mock.calls.filter((c) => String(c[0] as string).startsWith('Photo viewer'));
  warn.mockRestore();
  expect(failures).toEqual([]);
});

describe('the gallery’s gestures', () => {
  it('mounts the picture shown and its neighbours', async () => {
    await draw();
    expect(screen.getAllByTestId('viewer-page')).toHaveLength(3);
  });

  it('turns the page on a swipe at fit', async () => {
    const { onIndex } = await draw();
    await fire('viewer-pan', [
      { translationX: 0, translationY: 0, velocityX: 0 },
      { translationX: -60, translationY: 0, changeX: -60, velocityX: -100 },
      { translationX: -200, translationY: 0, changeX: -140, velocityX: -100 },
    ]);
    expect(onIndex).toHaveBeenCalledWith(2);
  });

  it('pans rather than turning the page once zoomed in', async () => {
    const { onIndex } = await draw();
    await fire('viewer-double-tap', [{ x: 200, y: 400 }]);
    await fire('viewer-pan', [
      { translationX: 0, translationY: 0, velocityX: 0 },
      { translationX: -60, translationY: 0, changeX: -60, velocityX: -100 },
      { translationX: -200, translationY: 0, changeX: -140, velocityX: -100 },
    ]);
    expect(onIndex).not.toHaveBeenCalled();
  });

  it('a pinch zooms, and a pinch back out returns to paging', async () => {
    const { onIndex } = await draw();
    const pinch = (scale: number) =>
      fire('viewer-pinch', [
        { scale: 1, focalX: 200, focalY: 400 },
        { scale: (1 + scale) / 2, focalX: 200, focalY: 400 },
        { scale, focalX: 200, focalY: 400 },
        { scale, focalX: 200, focalY: 400 },
      ]);
    const swipe = () =>
      fire('viewer-pan', [
        { translationX: 0, translationY: 0, velocityX: 0 },
        { translationX: -60, translationY: 0, changeX: -60, velocityX: -100 },
        { translationX: -200, translationY: 0, changeX: -140, velocityX: -100 },
      ]);
    await pinch(3);
    await swipe();
    expect(onIndex).not.toHaveBeenCalled();
    // Pinched below fit, it springs back to fit, and a swipe turns the page again.
    await pinch(0.2);
    await swipe();
    expect(onIndex).toHaveBeenCalledWith(2);
  });

  it('a pinch whose numbers are unusable never puts a NaN into a transform (#3)', async () => {
    const { onIndex } = await draw();
    mockNumbersSet.length = 0;
    // On the phone a NaN transform reaches Core Animation, which throws and ends the app.
    await fire('viewer-pinch', [
      { scale: 1, focalX: Number.NaN, focalY: 400 },
      { scale: 2, focalX: Number.NaN, focalY: 400 },
      { scale: 2, focalX: Number.NaN, focalY: 400 },
    ]);
    await fire('viewer-pinch', [
      { scale: 1, focalX: 200, focalY: 400 },
      { scale: Number.POSITIVE_INFINITY, focalX: 200, focalY: 400 },
      { scale: Number.NaN, focalX: 200, focalY: 400 },
      { scale: 0, focalX: 200, focalY: 400 },
    ]);
    // Not a frame of it held a NaN or Infinity, not only the picture it settled on.
    expect(mockNumbersSet.filter((n) => !Number.isFinite(n))).toEqual([]);
    // Still at fit: a swipe turns the page.
    await fire('viewer-pan', [
      { translationX: 0, translationY: 0, velocityX: 0 },
      { translationX: -60, translationY: 0, changeX: -60, velocityX: -100 },
      { translationX: -200, translationY: 0, changeX: -140, velocityX: -100 },
    ]);
    expect(onIndex).toHaveBeenCalledWith(2);
  });

  it('closes on a long pull down, and not on a short one', async () => {
    const { onClose } = await draw();
    await fire('viewer-pan', [
      { translationX: 0, translationY: 0 },
      { translationX: 0, translationY: 20, changeY: 20, velocityY: 50 },
      { translationX: 0, translationY: 40, changeY: 20, velocityY: 50 },
      { translationX: 0, translationY: 60, changeY: 20, velocityY: 50 },
    ]);
    expect(onClose).not.toHaveBeenCalled();
    await fire('viewer-pan', [
      { translationX: 0, translationY: 0 },
      { translationX: 0, translationY: 80, changeY: 80, velocityY: 50 },
      { translationX: 0, translationY: 140, changeY: 60, velocityY: 50 },
      { translationX: 0, translationY: 200, changeY: 60, velocityY: 50 },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides and shows what’s over the picture on one tap', async () => {
    await draw();
    expect(screen.getByText('over')).toBeTruthy();
    await fire('viewer-tap', [{}]);
    expect(screen.queryByText('over')).toBeNull();
    await fire('viewer-tap', [{}]);
    expect(screen.getByText('over')).toBeTruthy();
  });
});

describe('a picture that is slow or fails', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const state = (failed: boolean) => <Text>{failed ? 'retrying' : 'loading'}</Text>;

  it('shows a spinner while it comes, never plain black', async () => {
    await render(
      <GestureHandlerRootView>
        <ZoomGallery
          pages={[page('a')]}
          start={0}
          width={400}
          height={800}
          onIndex={jest.fn()}
          onClose={jest.fn()}
          renderState={state}
        />
      </GestureHandlerRootView>
    );
    expect(screen.queryByText('loading')).toBeNull();
    await act(() => jest.advanceTimersByTime(500));
    expect(screen.getByText('loading')).toBeTruthy();
  });

  it('with no source says so and tries again', async () => {
    const retry = jest.fn();
    const missing: ZoomPage = { ...page('a'), source: null, retry };
    await render(
      <GestureHandlerRootView>
        <ZoomGallery
          pages={[missing]}
          start={0}
          width={400}
          height={800}
          onIndex={jest.fn()}
          onClose={jest.fn()}
          renderState={state}
        />
      </GestureHandlerRootView>
    );
    await act(() => jest.advanceTimersByTime(500));
    expect(screen.getByText('retrying')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(5_000));
    expect(retry).toHaveBeenCalledTimes(1);
    await act(() => jest.advanceTimersByTime(5_000));
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
