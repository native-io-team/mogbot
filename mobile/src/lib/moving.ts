/**
 * Whether something on screen should move: shared by the avatar and the
 * typing key (components/agent.tsx, components/AgentKey.tsx).
 */

import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/**
 * Reduce Motion as it is now. Reanimated's hook reads it once, at launch,
 * so turning it on in Settings with the app open left the avatars
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

/** False with Reduce Motion, in the background, on a screen that isn't showing, or `still`. */
export function useMoving(still: boolean): boolean {
  const reduced = useReduceMotion();
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
  return !still && !reduced && active && focused;
}
