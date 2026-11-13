/**
 * The photo viewer's pages, on the UI thread: pinch to zoom (to 5×) about the
 * fingers, drag to look around while zoomed (with an edge that gives and a
 * glide when let go), double-tap to zoom in at the point tapped and back,
 * swipe sideways for the next picture and down to close — those two only at
 * fit. One tap shows or hides what's drawn over the picture (`overlay`).
 *
 * Only the picture shown and its neighbours are mounted. The maths is
 * `lib/zoom` (worklets, tested); this wires it to the gestures.
 */

import { Image, type ImageSource } from 'expo-image';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  GestureDetector,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  MAX_OVERSHOOT,
  CLOSE_PULL,
  clampOffset,
  clampScale,
  doubleTapTarget,
  dragBy,
  finiteOr,
  fitSize,
  isZoomed,
  offsetLimit,
  pageAfterSwipe,
  pageDrag,
  shouldClose,
  usableEvent,
  zoomOffset,
  type Size,
} from '../lib/zoom';

export interface ZoomPage {
  key: string;
  source: ImageSource | null;
  placeholder?: ImageSource | null;
  label: string;
  onError: () => void;
}

const TIMING = { duration: 220 };
const SPRING = { damping: 22, stiffness: 240 };
/** Pan modes, decided on a drag's first move. */
const UNDECIDED = 0;
const PAN = 1;
const PAGE = 2;
const CLOSE = 3;
const NONE = 4;
/** A drag at fit picks its direction after this many points. */
const DECIDE_PX = 10;

function logGestureError(message: string) {
  console.warn(`Photo viewer: a gesture failed and was reset (${message})`);
}

export function ZoomGallery({
  pages,
  start,
  width,
  height,
  onIndex,
  onClose,
  overlay,
}: {
  pages: readonly ZoomPage[];
  start: number;
  width: number;
  height: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Drawn over the picture; a tap hides it, a pull to close fades it. */
  overlay?: ReactNode;
}) {
  const count = pages.length;
  const [index, setIndex] = useState(start);
  const [chrome, setChrome] = useState(true);

  const at = useSharedValue(start);
  const strip = useSharedValue(-start * width);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const drop = useSharedValue(0);
  const pinching = useSharedValue(false);
  const mode = useSharedValue(UNDECIDED);
  const base = useSharedValue({ scale: 1, x: 0, y: 0, fx: 0, fy: 0 });
  // Each page's picture at fit, once its size is known; the screen until then.
  const fits = useSharedValue<Record<number, Size>>({});

  // A rotation keeps the page shown on screen.
  useEffect(() => {
    strip.set(-at.get() * width);
  }, [width, at, strip]);

  const landed = useCallback(
    (next: number) => {
      setIndex(next);
      onIndex(next);
    },
    [onIndex]
  );
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const pageTo = (next: number) => {
    'worklet';
    const target = Math.min(Math.max(next, 0), Math.max(count - 1, 0));
    strip.set(withTiming(-target * width, TIMING));
    if (target === at.get()) return;
    at.set(target);
    scale.set(1);
    x.set(0);
    y.set(0);
    scheduleOnRN(landed, target);
  };

  const contentNow = (): Size => {
    'worklet';
    return fits.get()[at.get()] ?? { width, height };
  };

  /** After a pinch: back inside 1–5×, and no gap at an edge. */
  const settle = () => {
    'worklet';
    const content = contentNow();
    const to = clampScale(scale.get());
    if (!isZoomed(to)) {
      scale.set(withTiming(1, TIMING));
      x.set(withTiming(0, TIMING));
      y.set(withTiming(0, TIMING));
      return;
    }
    const ratio = to / scale.get();
    scale.set(withSpring(to, SPRING));
    x.set(withSpring(clampOffset(x.get() * ratio, offsetLimit(content.width, to, width)), SPRING));
    y.set(
      withSpring(clampOffset(y.get() * ratio, offsetLimit(content.height, to, height)), SPRING)
    );
  };

  /**
   * A throw from a gesture callback on the UI runtime aborts the whole app,
   * so none leaves one: the picture goes back to fit and it is logged once.
   */
  const failed = useSharedValue(false);
  const recover = (err: unknown) => {
    'worklet';
    cancelAnimation(scale);
    cancelAnimation(x);
    cancelAnimation(y);
    cancelAnimation(drop);
    scale.set(1);
    x.set(0);
    y.set(0);
    drop.set(0);
    pinching.set(false);
    mode.set(UNDECIDED);
    strip.set(-at.get() * width);
    if (failed.get()) return;
    failed.set(true);
    scheduleOnRN(logGestureError, err instanceof Error ? err.message : String(err));
  };
  const guard =
    <E,>(fn: (e: E) => void) =>
    (e: E) => {
      'worklet';
      try {
        fn(e);
      } catch (err) {
        recover(err);
      }
    };

  const pinch = usePinchGesture({
    testID: 'viewer-pinch',
    onActivate: guard((e) => {
      'worklet';
      // A pinch with no usable focal point never starts (see `finiteOr`).
      if (!usableEvent([e.focalX, e.focalY])) return;
      pinching.set(true);
      cancelAnimation(scale);
      cancelAnimation(x);
      cancelAnimation(y);
      base.set({
        scale: scale.get(),
        x: x.get(),
        y: y.get(),
        fx: e.focalX - width / 2,
        fy: e.focalY - height / 2,
      });
    }),
    onUpdate: guard((e) => {
      'worklet';
      if (!pinching.get() || drop.get() !== 0) return;
      if (!usableEvent([e.scale, e.focalX, e.focalY]) || e.scale <= 0) return;
      const b = base.get();
      const to = Math.min(Math.max(b.scale * e.scale, 0.6), MAX_OVERSHOOT);
      // The picture point that was between the fingers stays between them.
      const nx = zoomOffset(b.x, b.scale, to, b.fx, e.focalX - width / 2);
      const ny = zoomOffset(b.y, b.scale, to, b.fy, e.focalY - height / 2);
      if (!usableEvent([nx, ny, to])) return;
      x.set(nx);
      y.set(ny);
      scale.set(to);
    }),
    onDeactivate: guard(() => {
      'worklet';
      if (!pinching.get()) return;
      pinching.set(false);
      settle();
    }),
  });

  const pan = usePanGesture({
    testID: 'viewer-pan',
    maxPointers: 1,
    onActivate: guard(() => {
      'worklet';
      mode.set(isZoomed(scale.get()) ? PAN : UNDECIDED);
      if (mode.get() === PAN) {
        cancelAnimation(x);
        cancelAnimation(y);
      }
    }),
    onUpdate: guard((e) => {
      'worklet';
      if (pinching.get() || e.numberOfPointers > 1) return;
      if (!usableEvent([e.translationX, e.translationY, e.changeX, e.changeY])) return;
      if (mode.get() === UNDECIDED) {
        const ax = Math.abs(e.translationX);
        const ay = Math.abs(e.translationY);
        if (Math.max(ax, ay) < DECIDE_PX) return;
        mode.set(ax > ay ? (count > 1 ? PAGE : NONE) : e.translationY > 0 ? CLOSE : NONE);
      }
      if (mode.get() === PAN) {
        const content = contentNow();
        x.set(dragBy(x.get(), e.changeX, offsetLimit(content.width, scale.get(), width)));
        y.set(dragBy(y.get(), e.changeY, offsetLimit(content.height, scale.get(), height)));
      } else if (mode.get() === PAGE) {
        strip.set(-at.get() * width + pageDrag(at.get(), e.translationX, count));
      } else if (mode.get() === CLOSE) {
        drop.set(Math.max(0, e.translationY));
      }
    }),
    onDeactivate: guard((e) => {
      'worklet';
      const was = mode.get();
      mode.set(UNDECIDED);
      if (was === PAN) {
        const content = contentNow();
        const lx = offsetLimit(content.width, scale.get(), width);
        const ly = offsetLimit(content.height, scale.get(), height);
        const vx = finiteOr(e.velocityX, 0);
        const vy = finiteOr(e.velocityY, 0);
        x.set(withDecay({ velocity: vx, clamp: [-lx, lx], rubberBandEffect: true }));
        y.set(withDecay({ velocity: vy, clamp: [-ly, ly], rubberBandEffect: true }));
      } else if (was === PAGE) {
        const dx = finiteOr(e.translationX, 0);
        pageTo(pageAfterSwipe(at.get(), dx, finiteOr(e.velocityX, 0), width, count));
      } else if (was === CLOSE) {
        const dy = finiteOr(e.translationY, 0);
        if (shouldClose(dy, finiteOr(e.velocityY, 0))) scheduleOnRN(onClose);
        else drop.set(withSpring(0, SPRING));
      }
    }),
  });

  const doubleTap = useTapGesture({
    testID: 'viewer-double-tap',
    numberOfTaps: 2,
    onActivate: guard((e) => {
      'worklet';
      if (!usableEvent([e.x, e.y])) return;
      const t = doubleTapTarget(
        scale.get(),
        { x: e.x - width / 2, y: e.y - height / 2 },
        contentNow(),
        { width, height }
      );
      scale.set(withTiming(t.scale, TIMING));
      x.set(withTiming(t.x, TIMING));
      y.set(withTiming(t.y, TIMING));
    }),
  });
  const singleTap = useTapGesture({
    testID: 'viewer-tap',
    onActivate: guard(() => {
      'worklet';
      scheduleOnRN(toggleChrome);
    }),
  });
  const taps = useExclusiveGestures(doubleTap, singleTap);
  const gesture = useSimultaneousGestures(pinch, pan, taps);

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: finiteOr(strip.get(), -at.get() * width) }],
  }));
  const overlayStyle = useAnimatedStyle(() => ({
    opacity: interpolate(finiteOr(drop.get(), 0), [0, CLOSE_PULL], [1, 0], 'clamp'),
  }));

  // Each picture's own size, kept so a rotation can fit them to the new screen.
  const sizes = useRef<Record<number, Size>>({});
  const natural = (i: number, size: Size) => {
    sizes.current[i] = size;
    fits.set({ ...fits.get(), [i]: fitSize(size, { width, height }) });
  };
  useEffect(() => {
    const next: Record<number, Size> = {};
    for (const [i, size] of Object.entries(sizes.current)) {
      next[Number(i)] = fitSize(size, { width, height });
    }
    fits.set(next);
  }, [width, height, fits]);

  // VoiceOver can't swipe a picture: it pages with the adjustable actions.
  const step = (delta: number) => {
    const next = Math.min(Math.max(index + delta, 0), count - 1);
    if (next === index) return;
    at.set(next);
    scale.set(1);
    x.set(0);
    y.set(0);
    strip.set(withTiming(-next * width, TIMING));
    landed(next);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={gesture}>
        <View
          style={StyleSheet.absoluteFill}
          testID="viewer-pages"
          accessible={count > 1}
          accessibilityRole={count > 1 ? 'adjustable' : undefined}
          accessibilityLabel={pages[index]?.label}
          accessibilityActions={
            count > 1 ? [{ name: 'increment' }, { name: 'decrement' }] : undefined
          }
          onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        >
          <Animated.View
            style={[styles.strip, { width: width * Math.max(count, 1), height }, stripStyle]}
          >
            {pages.map((page, i) =>
              Math.abs(i - index) > 1 ? null : (
                <Page
                  key={page.key}
                  page={page}
                  i={i}
                  width={width}
                  height={height}
                  at={at}
                  scale={scale}
                  x={x}
                  y={y}
                  drop={drop}
                  onNatural={(size) => natural(i, size)}
                />
              )
            )}
          </Animated.View>
        </View>
      </GestureDetector>
      {chrome && overlay && (
        <Animated.View style={[StyleSheet.absoluteFill, overlayStyle]} pointerEvents="box-none">
          {overlay}
        </Animated.View>
      )}
    </View>
  );
}

function Page({
  page,
  i,
  width,
  height,
  at,
  scale,
  x,
  y,
  drop,
  onNatural,
}: {
  page: ZoomPage;
  i: number;
  width: number;
  height: number;
  at: SharedValue<number>;
  scale: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  drop: SharedValue<number>;
  onNatural: (size: Size) => void;
}) {
  const style = useAnimatedStyle(() => {
    if (at.get() !== i) return { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    // Pulled down to close, it follows the finger and shrinks a little.
    const pull = finiteOr(drop.get(), 0);
    const shrink = interpolate(pull, [0, Math.max(height, 1)], [1, 0.7], 'clamp');
    // Never a NaN into a transform: Core Animation throws on one and the app ends.
    const s = finiteOr(scale.get(), 1);
    return {
      transform: [
        { translateX: finiteOr(x.get(), 0) },
        { translateY: finiteOr(y.get(), 0) + pull },
        { scale: (s > 0 ? s : 1) * shrink },
      ],
    };
  });
  return (
    <Animated.View
      style={[styles.page, { left: i * width, width, height }, style]}
      testID="viewer-page"
      accessibilityLabel={page.label}
    >
      <Image
        source={page.source}
        placeholder={page.placeholder ?? undefined}
        placeholderContentFit="contain"
        style={{ width, height }}
        contentFit="contain"
        // Decoded straight at the screen's size: the size it's drawn at
        // anyway (expo-image downscales to the view), without first holding
        // the whole photo in memory. A 48 MP photo is ~190 MB decoded, and the
        // page beside it loads too; together they could get the app killed.
        enforceEarlyResizing
        transition={150}
        recyclingKey={page.key}
        onLoad={(e) => {
          const { width: w, height: h } = e.source;
          if (w && h) onNatural({ width: w, height: h });
        }}
        onError={page.onError}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', top: 0, left: 0 },
  page: { position: 'absolute', top: 0 },
});
