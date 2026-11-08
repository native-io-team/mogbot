/**
 * The agent, on a key: what leads the working line while it works (the
 * desk's `AgentKey`; docs/internal/avatars.md, "On a key"). A wide key cap
 * in the site's language, a lit top on a darker side with a hairline ring
 * and a soft drop, faintly tinted with the agent's hue, its avatar on the
 * cap (the solid one: you're looking at that agent). While it's live the cap
 * is typed on: a tap, a lighter tap, a rest. Stalled or finishing, it rests.
 *
 * Geometry and colour are the shared spec's (`TYPING_KEY`, `typingKeyPaint`);
 * the press is one shared clock on the UI thread read by `keyDepth`, moving
 * only the top's transform. Still with Reduce Motion, in the background and
 * on a screen that isn't showing.
 */

import { TYPING_KEY, typingKeyPaint } from '@shipstudio/companion-protocol';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useAppearance } from '../lib/appearance';
import { alpha, keyLight, radius } from '../lib/theme';
import { TYPING_KEY_PERIOD_MS, keyDepth } from '../lib/typingKey';
import { useMoving } from '../lib/moving';
import { AgentAvatar } from './agent';

const K = TYPING_KEY;

export function AgentKey({
  id,
  name,
  color,
  pressing,
}: {
  id: string;
  name: string;
  color: string;
  /** Being typed on (the line is live); otherwise it rests. */
  pressing: boolean;
}) {
  const appearance = useAppearance();
  const paint = typingKeyPaint(color, appearance);
  const moving = useMoving(!pressing);
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!moving) {
      cancelAnimation(clock);
      clock.set(0);
      return;
    }
    clock.set(0);
    clock.set(
      withRepeat(withTiming(1, { duration: TYPING_KEY_PERIOD_MS, easing: Easing.linear }), -1)
    );
    return () => cancelAnimation(clock);
  }, [clock, moving]);
  const pressed = useAnimatedStyle(() => ({
    transform: [{ translateY: keyDepth(clock.get()) * K.travel }],
  }));
  const ring = alpha(keyLight.shade, paint.ring);
  const gradient = `key-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <View style={styles.key} testID="agent-key" accessible={false}>
      {/* The side: the top's shape set down by the travel, showing under it. */}
      <View
        style={[
          styles.side,
          {
            backgroundColor: paint.side,
            borderColor: ring,
            shadowColor: keyLight.shade,
            shadowOpacity: paint.shadow,
          },
        ]}
      />
      <Animated.View style={[styles.top, { borderColor: ring }, pressed]}>
        <Svg width={K.width} height={K.top} style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={paint.topHigh} />
              <Stop offset="1" stopColor={paint.topLow} />
            </LinearGradient>
          </Defs>
          <Rect width={K.width} height={K.top} fill={`url(#${gradient})`} />
          {/* The lit top edge. */}
          <Rect
            x={K.radius / 2}
            width={K.width - K.radius}
            height={1}
            fill={alpha(keyLight.light, paint.highlight)}
          />
        </Svg>
        <AgentAvatar
          id={id}
          name={name}
          color={color}
          size={K.avatar}
          selected
          mood={pressing ? 'working' : 'idle'}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  key: { width: K.width, height: K.top + K.travel },
  side: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: K.travel,
    height: K.top,
    borderRadius: radius.key,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOffset: { width: 0, height: K.travel },
    shadowRadius: K.travel,
  },
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: K.top,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.key,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
