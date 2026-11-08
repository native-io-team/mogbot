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
  return typeof route === 'string' && /^\/[a-z/[\]-]*$/i.test(route) ? route : null;
}
