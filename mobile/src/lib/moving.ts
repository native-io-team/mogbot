/**
 * Whether something on screen should move: shared by the avatar and the
 * typing key (components/agent.tsx, components/AgentKey.tsx).
 */

import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

/** False with Reduce Motion, in the background, on a screen that isn't showing, or `still`. */
export function useMoving(still: boolean): boolean {
  const reduced = useReducedMotion();
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
