/**
 * Arrival motion for the phone: the one preset every new row rises in on.
 */

import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import Animated, { Easing, FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { ARRIVE } from '../lib/theme';

/**
 * Not on the web (QA only). Reanimated's web entering animation for a
 * customised preset (this one: `withInitialValues` makes it a keyframe of
 * its own, not one of its built-in CSS animations) ends on a timer as well as
 * on `animationend`, and since the animation itself only starts on the next
 * frame, the timer can win: it then pins the row `position: absolute` at the
 * window coordinates it measured. Inside the chat's inverted list (a
 * `scaleY(-1)` scroller) those coordinates are nonsense, so an arrived row was
 * drawn ~1,300px from where it belongs, or off screen entirely, while the
 * DOM order stayed right (qa:web `torture-events`). The iOS build has no such
 * path: the same events in the simulator land in order (docs/mobile.md,
 * "Phone screens without a simulator").
 */
const RISES = Platform.OS !== 'web';

/**
 * The arrival (theme.ts `ARRIVE`, the desk's --transition-arrive): an 8pt
 * rise and a fade on the site's arrive curve, in 200 ms, still under Reduce
 * Motion. Built on first use, not at import, so nothing animates (or is
 * even asked for) until a row actually arrives.
 */
let arrivePreset: InstanceType<typeof FadeInDown> | null = null;
export function arriving() {
  if (!RISES) return undefined;
  arrivePreset ??= FadeInDown.duration(ARRIVE.ms)
    .easing(Easing.bezier(...ARRIVE.curve))
    .withInitialValues({ opacity: 0, transform: [{ translateY: ARRIVE.rise }] })
    .reduceMotion(ReduceMotion.System);
  return arrivePreset;
}

/**
 * A row that arrived while the chat was open (an agent's reply, a card, a
 * line): it rises in once. History, and the chat as it opens, hold still
 * (`useArrivedKeys`).
 */
export function Arrive({ children }: { children: ReactNode }) {
  return <Animated.View entering={arriving()}>{children}</Animated.View>;
}
