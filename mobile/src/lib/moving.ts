/**
 * Whether something on screen should move: shared by every loop on the
 * phone (a key's Needs-your-OK pulse, the spinner, the typing dots, the
 * shimmer) and the "2 min ago" clocks. Nothing runs on the UI thread for a
 * screen nobody is looking at, or while the app is in the background.
 */

import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/**
 * Reduce Motion as it is now. Reanimated's hook reads it once, at launch,
 * so turning it on in Settings with the app open left the loops
 * breathing and blinking until the next launch; this follows the change.
 */
export function useReduceMotion(): boolean {
  const atLaunch = useReducedMotion();
  const [reduced, setReduced] = useState(atLaunch);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((on) => live && setReduced(on))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (on) => setReduced(on));
    return () => {
      live = false;
      sub?.remove();
    };
  }, []);
  return reduced;
}

/**
 * Whether anyone can see this: the app is in front and this screen is the
 * one showing (a screen under a pushed chat, or another tab, stays mounted).
 * Clocks and loops hold while it's false.
 */
export function useShowing(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  let focused = true;
  try {
    // Outside a navigator (a test, a preview), there's no screen to leave and
    // the hook throws. It's called on every render all the same: the try only
    // catches that throw (`@react-navigation/native`'s context isn't ours to import).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    focused = useIsFocused();
  } catch {
    focused = true;
  }
  return active && focused;
}

/** False with Reduce Motion, in the background, on a screen that isn't showing, or `still`. */
export function useMoving(still: boolean): boolean {
  const reduced = useReduceMotion();
  const showing = useShowing();
  return !still && !reduced && showing;
}
