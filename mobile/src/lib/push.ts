/**
 * Real push, through the Mac and the content-free push relay
 * (docs/push-relay.md). The phone's only part: hand the Mac its push token
 * once it may show notifications, and say honestly where that leaves it.
 *
 * - Permission is asked at first need (the "Turn on alerts" card after
 *   pairing, or Settings), never at launch. Without it there is no token.
 * - Only the official build can receive push; a self-built app has no APNs
 *   entitlement, and says so instead of asking.
 * - The token goes to the Mac on every connect (`devices.setPush`); an
 *   unchanged one costs the Mac nothing.
 */

import type { PushEnvironment, PushStatus } from '@shipstudio/companion-protocol';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { targetOf } from './notify';
import { getApp, setApp } from './store';

/** How alerts work without push: Settings and the after-pairing card say the same. */
export const ALERTS_WHILE_OPEN =
  'Notifications arrive while this app is open on your phone. While you’re using your Mac, only your Mac notifies.';

/** The App Store build (or an official EAS build): `extra.official` in app.config.ts. */
export const isOfficialBuild = () => Boolean(Constants.expoConfig?.extra?.official);

/**
 * Whether this build can be woken by push at all. On Android that also needs
 * Firebase's config compiled in (`extra.androidPush`, app.config.ts); a Play
 * build without it works like a phone with the app open.
 */
export const canReceivePush = (
  official: boolean = isOfficialBuild(),
  os: string = Platform.OS,
  androidPush: boolean = Boolean(Constants.expoConfig?.extra?.androidPush)
) => official && (os !== 'android' || androidPush);

/** What Settings says about push, from what is known. Null: say nothing yet. */
export function pushLine(
  status: PushStatus | null,
  official: boolean,
  os: string = Platform.OS
): { value: string; footer: string } | null {
  if (!official || status === 'self_build') {
    return {
      value: 'Needs the official build',
      footer:
        os === 'android'
          ? 'With the app closed, notifications need the Google Play app. This copy was built on your Mac.'
          : 'With the app closed, notifications need the App Store app. This copy was built on your Mac, and Apple doesn’t let it receive them.',
    };
  }
  switch (status) {
    case 'on':
      return {
        value: 'On',
        footer:
          'Your Mac can wake this phone through the notification service. Notifications say only that an agent needs you or finished, never what it said. While you’re using your Mac, only your Mac notifies.',
      };
    case 'pending':
      return {
        value: 'Connecting',
        footer:
          'Your Mac couldn’t reach the notification service yet. It tries again with the next one.',
      };
    case 'off':
      return {
        value: 'Off on your Mac',
        footer: 'Turn on phone notifications on your Mac, in Settings → Phone.',
      };
    case 'unavailable':
      return {
        value: 'Not on this Mac',
        footer:
          'The app on your Mac has no notification service. Notifications arrive while this app is open.',
      };
    default:
      return null;
  }
}

/** The agent a tapped notification is about: local (`data`), APNs (`body`) or FCM. */
export const agentFromResponse = (response: Notifications.NotificationResponse | null) =>
  targetOf(response?.notification.request)?.agentId ?? null;

async function environment(): Promise<PushEnvironment | null> {
  if (Platform.OS !== 'ios') return 'production';
  const env = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(() => null);
  return env === 'development' || env === 'production' ? env : null;
}

/**
 * Tell the Mac this phone's token, if it may have one. Never asks for
 * permission. `call` is the session's request function.
 */
export async function registerPush(
  call: (token: string | null, environment: PushEnvironment) => Promise<{ status: PushStatus }>
): Promise<void> {
  if (!isOfficialBuild()) return setApp({ push: 'self_build' });
  // An official Android build without Firebase has no token to give.
  if (!canReceivePush()) return;
  // iOS simulators have no APNs token; Android emulators with Google Play do get FCM ones.
  if (Platform.OS === 'ios' && !Device.isDevice) return;
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  const env = await environment();
  if (!env) return;
  const token: unknown = (await Notifications.getDevicePushTokenAsync()).data;
  if (typeof token !== 'string') return;
  const { status } = await call(token, env);
  if (getApp().push !== status) setApp({ push: status });
}
