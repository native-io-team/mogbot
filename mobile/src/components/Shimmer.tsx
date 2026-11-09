/**
 * The working line's words while they're live: they breathe, softly, so the
 * line says "working" without dots (the desk passes a light over them,
 * `agents-work-shimmer`). One shared value on the UI thread; still under
 * Reduce Motion and whenever `live` is false (no progress for a while).
 */

import { useEffect, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SHIMMER_LOW_OPACITY, SHIMMER_PERIOD_MS } from '../lib/typingDots';
import { useMoving } from '../lib/moving';

export function Shimmer({
  live,
  style,
  children,
}: {
  live: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  // Reduce Motion, the background, or a screen not showing: no loop.
  const moving = useMoving(!live);
  const level = useSharedValue(1);
  useEffect(() => {
    if (!moving) {
      cancelAnimation(level);
      level.set(1);
      return;
    }
    level.set(
      withRepeat(
        withTiming(SHIMMER_LOW_OPACITY, {
          duration: SHIMMER_PERIOD_MS / 2,
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true
      )
    );
    return () => cancelAnimation(level);
  }, [level, moving]);
  const faded = useAnimatedStyle(() => ({ opacity: level.get() }));
  return <Animated.View style={[style, faded]}>{children}</Animated.View>;
}
