/**
 * The avatar's blink on the phone (`components/agent.tsx`, `AgentKey.tsx`),
 * the spec's numbers (`BLINK`, `blinkSchedule` in the shared spec; the desk's
 * is a timer and CSS, src/lib/avatarBlink.ts). One Reanimated sequence per
 * avatar, built once from a random schedule and played on the UI thread:
 * nothing is scheduled from JS, nothing re-renders. `blinkAnimation` is
 * built on the JS thread; `eyeScaleY` is the worklet the UI thread reads.
 */

import { BLINK, blinkSchedule } from '@shipstudio/companion-protocol';
import { useEffect } from 'react';
import {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { eyeScaleY } from './eyeBlink';

const close = () => withTiming(1, { duration: BLINK.closeMs, easing: Easing.inOut(Easing.quad) });
const open = () => withTiming(0, { duration: BLINK.openMs, easing: Easing.inOut(Easing.quad) });

/**
 * A repeating run of random blinks for a shared value that reads 0 open, 1
 * shut. The pattern is drawn here, with `rand`, so each avatar has its own
 * (the first wait too, over the whole range); it comes round again after
 * `count` blinks, a minute or so on.
 */
export function blinkAnimation(rand: () => number = Math.random, count = 12) {
  const steps = blinkSchedule(rand, count).map((s) => {
    const blink = withSequence(close(), open());
    if (!s.double) return withDelay(s.gapMs, blink);
    const rest = Math.max(0, BLINK.doubleGapMs - BLINK.closeMs - BLINK.openMs);
    return withDelay(s.gapMs, withSequence(close(), open(), withDelay(rest, blink)));
  });
  return withRepeat(withSequence(...steps), -1);
}

/**
 * The style for the layer the eyes are drawn on: squashed about the eyes'
 * own line (`eyeY` points down the layer, which is `height` tall), while
 * `active`. Inactive (Reduce Motion, the background, a screen that isn't
 * showing): the animation is cancelled and the eyes are open.
 */
export function useEyeBlink(active: boolean, height: number, eyeY: number) {
  const closed = useSharedValue(0);
  useEffect(() => {
    if (!active) {
      // Setting a value stops whatever animation it had.
      closed.set(0);
      return;
    }
    closed.set(blinkAnimation());
    return () => cancelAnimation(closed);
  }, [active, closed]);
  const offset = eyeY - height / 2;
  return useAnimatedStyle(() => ({
    transform: [
      { translateY: offset },
      { scaleY: eyeScaleY(closed.get()) },
      { translateY: -offset },
    ],
  }));
}
