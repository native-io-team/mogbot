/**
 * Store screenshots (docs/app-store.md, "Screenshots"): a build made with
 * COMPANION_SCREENSHOTS=1, launched on a simulator with
 * `-screenshotRoute /chat/inbox`, opens the demo at that screen, since the
 * simulator can't tap the "Open in …?" prompt a link raises. Off in every
 * build that ships: `extra.screenshots` is false unless that variable is set.
 */

import Constants from 'expo-constants';
import { Platform, Settings } from 'react-native';

export function screenshotRoute(): string | null {
  if (Constants.expoConfig?.extra?.screenshots !== true || Platform.OS !== 'ios') return null;
  // Launch arguments (`-key value`) are in the user defaults' argument domain.
  const route: unknown = Settings.get('screenshotRoute');
  return typeof route === 'string' && /^\/[a-z0-9/[\]_-]*(\?[a-z0-9_=&.-]*)?$/i.test(route)
    ? route
    : null;
}

/**
 * `-screenshotPair <link>`: the mock Mac (`pnpm mock --store …`) to take them
 * from instead of the demo, paired without the confirm tap the simulator
 * can't make. Only a screenshots build reads it, as for the route.
 */
export function screenshotPairLink(): string | null {
  if (Constants.expoConfig?.extra?.screenshots !== true || Platform.OS !== 'ios') return null;
  const link: unknown = Settings.get('screenshotPair');
  return typeof link === 'string' && link.includes('pair?d=') ? link : null;
}
