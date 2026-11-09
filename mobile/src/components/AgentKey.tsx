/**
 * The agent as a key being typed on: what leads the working line while it
 * works (the desk's `AgentKey`; docs/internal/avatars.md, "On a key"). Its
 * avatar, bigger (`TYPING_KEY.size`) and raised in the site's key language:
 * the shape's own silhouette is the top, lit along its upper edge with a
 * hairline round it; the same silhouette set down by the travel, darker, is
 * the side; a soft drop sits under that. Always a raised key, whatever
 * finish the agent chose: here the avatar is the key.
 *
 * While it's live the top (and the face on it) presses down into the side
 * and springs back, tap, tap, rest, and the drop tightens with each press:
 * one shared clock on the UI thread read by `keyDepth` and `keyDrop`, moving
 * only a transform and an opacity. Still with Reduce Motion, in the
 * background and on a screen that isn't showing.
 */

import {
  AVATAR_GRID,
  FACE_SPECS,
  blinks,
  KEY,
  SHAPE_PATHS,
  TYPING_KEY,
  TYPING_KEY_UNITS,
  TYPING_KEY_VIEWBOX,
  typingKeyPaint,
} from '@shipstudio/companion-protocol';
import { useEffect, useId, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, FeGaussianBlur, Filter, LinearGradient, Path, Stop } from 'react-native-svg';
import { useAppearance } from '../lib/appearance';
import { alpha, keyLight } from '../lib/theme';
import { TYPING_KEY_PERIOD_MS, keyDepth, keyDrop } from '../lib/typingKey';
import { useEyeBlink } from '../lib/avatarBlink';
import { useMoving } from '../lib/moving';
import { Face, RimFilter, useLook } from './agent';

const K = TYPING_KEY;
const U = TYPING_KEY_UNITS;
const HEIGHT = K.size + K.travel;
/** The drop reaches past the key's box: its layer is drawn this many grid units taller. */
// Three blur radii hold all of a Gaussian that shows.
const DROP_ROOM = U.drop.dy + U.drop.blur * 3;

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
  const look = useLook(id, name, undefined);
  const moving = useMoving(!pressing);
  // The eyes blink while the line is live, a rest or not: the key itself only presses when typed on.
  const blinking = blinks(look.face, K.size);
  const eyeY = (FACE_SPECS[look.face].eyes[0].cy * K.size) / AVATAR_GRID;
  const live = useMoving(false);
  const blink = useEyeBlink(blinking && live, HEIGHT, eyeY);
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
  const top = useAnimatedStyle(() => ({
    transform: [{ translateY: keyDepth(clock.get()) * K.travel }],
  }));
  const drop = useAnimatedStyle(() => ({ opacity: keyDrop(keyDepth(clock.get())) }));
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const shape = SHAPE_PATHS[look.shape];
  const ring = alpha(keyLight.shade, paint.ring);
  const dropUnits = AVATAR_GRID + U.travel + DROP_ROOM;
  const dropHeight = (dropUnits * K.size) / AVATAR_GRID;
  return (
    <View
      style={styles.key}
      testID="agent-key"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {/* The drop, its own layer: it tightens as the key goes down. */}
      <Animated.View style={[styles.drop, { height: dropHeight }, drop]}>
        <Svg width={K.size} height={dropHeight} viewBox={`0 0 ${AVATAR_GRID} ${dropUnits}`}>
          <Defs>
            <Filter id={`${uid}d`} x="-30%" y="-30%" width="160%" height="170%">
              <FeGaussianBlur stdDeviation={U.drop.blur} />
            </Filter>
          </Defs>
          <Path
            d={shape}
            transform={`translate(0 ${U.travel + U.drop.dy})`}
            fill={keyLight.shade}
            opacity={paint.shadow}
            filter={`url(#${uid}d)`}
          />
        </Svg>
      </Animated.View>
      {/* The side: the top's outline set down by the travel, so at the bottom
          of a press the top covers it and nothing peeks above. */}
      <Layer>
        <Path
          d={shape}
          transform={`translate(0 ${U.travel})`}
          fill="none"
          stroke={ring}
          strokeWidth={U.ring}
        />
        <Path d={shape} transform={`translate(0 ${U.travel})`} fill={paint.side} />
      </Layer>
      <Animated.View style={[StyleSheet.absoluteFill, top]} testID="agent-key-top">
        <Layer>
          <Defs>
            <LinearGradient id={`${uid}g`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={paint.topHigh} />
              <Stop offset="1" stopColor={paint.topLow} />
            </LinearGradient>
            <RimFilter id={`${uid}r`} depth={KEY.capRim} paint={paint} />
          </Defs>
          <Path d={shape} fill="none" stroke={ring} strokeWidth={U.ring} />
          <Path d={shape} fill={`url(#${uid}g)`} filter={`url(#${uid}r)`} />
          <Face
            look={look}
            name={name}
            px={K.size}
            paint={paint}
            ink={paint.ink}
            selected={false}
            part={blinking ? 'rest' : 'all'}
          />
        </Layer>
        {blinking && (
          <Animated.View style={[StyleSheet.absoluteFill, blink]} testID="agent-key-eyes">
            <Layer>
              <Face
                look={look}
                name={name}
                px={K.size}
                paint={paint}
                ink={paint.ink}
                selected={false}
                part="eyes"
              />
            </Layer>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

/** One layer of the key, on the avatar's grid with the side under it. */
function Layer({ children }: { children: ReactNode }) {
  return (
    <Svg
      width={K.size}
      height={HEIGHT}
      viewBox={TYPING_KEY_VIEWBOX}
      style={StyleSheet.absoluteFill}
    >
      {children}
    </Svg>
  );
}

const styles = StyleSheet.create({
  key: { width: K.size, height: HEIGHT },
  drop: { position: 'absolute', left: 0, right: 0, top: 0 },
});
