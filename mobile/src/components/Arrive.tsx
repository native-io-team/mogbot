/**
 * Arrival motion for the phone: the one preset every new row rises in on.
 */

import type { ReactNode } from 'react';
import Animated, { Easing, FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { ARRIVE } from '../lib/theme';

/**
 * The arrival (theme.ts `ARRIVE`, the desk's --transition-arrive): an 8pt
 * rise and a fade on the site's arrive curve, in 200 ms, still under Reduce
 * Motion. Built on first use, not at import, so nothing animates (or is
 * even asked for) until a row actually arrives.
 */
let arrivePreset: InstanceType<typeof FadeInDown> | null = null;
export function arriving() {
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
