/**
 * Three dots in one calm wave: an agent at work (the working row under a
 * reply, a live import bar). The desktop draws the same wave
 * (src/components/primitives/TypingDots.tsx); the numbers are in
 * `lib/typingDots.ts`.
 *
 * One shared value is the clock, on the UI thread; every dot is a pure
 * function of it, so all three move from the first frame and stay in phase.
 * Under Reduce Motion nothing moves: three still dots. Unmounting cancels
 * the clock.
 */

import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useColors } from '../lib/appearance';
import { useMoving } from '../lib/moving';
import { typingDot } from '../lib/theme';
import {
  TYPING_DOTS,
  TYPING_PERIOD_MS,
  TYPING_STILL_OPACITY,
  dotLevel,
  dotOpacity,
  dotPhase,
} from '../lib/typingDots';

const INDEXES = Array.from({ length: TYPING_DOTS }, (_, i) => i);

export function TypingDots({ color, label }: { color?: string; label?: string }) {
  const colors = useColors();
  color ??= colors.textMuted;
  // Reduce Motion, the background, or a screen not showing: hold still.
  const moving = useMoving(false);
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!moving) return;
    clock.set(
      withRepeat(withTiming(1, { duration: TYPING_PERIOD_MS, easing: Easing.linear }), -1, false)
    );
    return () => cancelAnimation(clock);
  }, [clock, moving]);
  return (
    <View
      accessible={!!label}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'auto' : 'no-hide-descendants'}
      testID="typing-dots"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: typingDot.gap,
        // Room for the crest, so the row's height never changes.
        height: typingDot.size + typingDot.lift * 2,
      }}
    >
      {INDEXES.map((i) => (
        <Dot key={i} index={i} clock={clock} color={color} still={!moving} />
      ))}
    </View>
  );
}

function Dot({
  index,
  clock,
  color,
  still,
}: {
  index: number;
  clock: SharedValue<number>;
  color: string;
  still: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: TYPING_STILL_OPACITY, transform: [{ translateY: 0 }] };
    const level = dotLevel(dotPhase(clock.value, index));
    return {
      opacity: dotOpacity(level),
      transform: [{ translateY: -typingDot.lift * level }],
    };
  });
  return (
    <Animated.View
      style={[
        {
          width: typingDot.size,
          height: typingDot.size,
          borderRadius: typingDot.size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
