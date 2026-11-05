import type { ExpoConfig } from 'expo/config';
// The app's name, scheme and bundle id live only in the repo-root brand.json.
// This file runs in Node at build time, so it can read it directly.
// It is also handed to the app as `extra.brand` (src/lib/brand.ts), so Metro
// never has to see outside mobile/.
interface Brand {
  name: string;
  slug: string;
  companion: { scheme: string; bundleId: string };
  [key: string]: unknown;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brand = require('../brand.json') as Brand;

/**
 * Official builds set all three in EAS; forks and self-builds set their own
 * (docs/mobile.md, "Installing the app"). With no EAS_PROJECT_ID, OTA
 * updates are off, so an official update can never land on a fork's binary.
 */
const projectId = process.env.EAS_PROJECT_ID;
// PLACEHOLDER: the official bundle id is not registered yet. Replace it in
// brand.json once the owner's App Store Connect team has the app record.
const bundleId = process.env.COMPANION_BUNDLE_ID ?? brand.companion.bundleId;
// A build on the user's own Mac signs with their team (the desktop app's
// Phone → Install on my phone sets it); unset, Xcode's own signing settings apply.
const appleTeamId = process.env.APPLE_TEAM_ID;
const updatesUrl = process.env.UPDATES_URL ?? (projectId ? `https://u.expo.dev/${projectId}` : '');

const SURFACE_APP = '#141414'; // --surface-app
const SURFACE_APP_LIGHT = '#ffffff'; // the light palette's surfaceApp (src/lib/theme.ts)
const CAMERA =
  'Used to scan the pairing code on your Mac, and to take photos you send to your agents.';
/**
 * iOS has one microphone string for the whole app, and expo-camera,
 * expo-image-picker and expo-speech-recognition each write it, so it says
 * only what the mic is for. Where the words are recognised is the speech
 * string's claim (iOS-only, and iOS enforces it: `requiresOnDeviceRecognition`).
 * Android shows neither; its mic stays off where recognition isn't on the
 * phone (src/lib/dictation.ts, `dictationSupport`).
 */
const MICROPHONE = 'Used when you dictate a message to your agents.';
const SPEECH =
  'Turns what you dictate into text on this phone, for you to read before you send it.';
/**
 * "Send to agent…" in the share sheet is a native extension with an App
 * Group, which needs an Apple team that can sign one. Off unless asked for,
 * so `expo prebuild` for a free-team self-build is unchanged
 * (docs/mobile.md, "Send to agent…"). The flag also reaches the app as
 * `extra.shareExtension`: autolinking still links the package's native
 * module into every build, so the app gates on this, not on the module.
 */
const shareExtension = process.env.SHIPSTUDIO_SHARE_EXTENSION === '1';
/**
 * The push entitlement (`aps-environment`), which expo-notifications adds by
 * default. A free Apple ID's personal team can't sign it ("Personal
 * development teams … do not support the Push Notifications capability"), so
 * it's only in an official (EAS) build, or one that asks with
 * COMPANION_PUSH_ENTITLEMENT=1 (a paid team that wants it). A self-build
 * can't receive push anyway (src/lib/push.ts says so instead of asking), and
 * local notifications don't need the entitlement.
 */
export const pushEntitlement = (env: Record<string, string | undefined> = process.env): boolean =>
  Boolean(env.EAS_PROJECT_ID) || env.COMPANION_PUSH_ENTITLEMENT === '1';

export default (): ExpoConfig => ({
  name: brand.name,
  slug: `${brand.slug}-companion`,
  // Must match PAIRING_SCHEME in @shipstudio/companion-protocol (generated from
  // the same brand.json field; `pnpm check:brand` fails if they drift).
  scheme: brand.companion.scheme,
  version: '0.1.0',
  // Landscape and iPad: the Agents list and a chat sit side by side when there's room.
  orientation: 'default',
  // Placeholder: a black tile with a white ring, until real branding lands.
  icon: './assets/icon.png',
  web: { favicon: './assets/favicon.png' },
  userInterfaceStyle: 'automatic',
  backgroundColor: SURFACE_APP,
  runtimeVersion: { policy: 'fingerprint' },
  updates: projectId
    ? { enabled: true, url: updatesUrl, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }
    : { enabled: false },
  ios: {
    bundleIdentifier: bundleId,
    ...(appleTeamId ? { appleTeamId } : {}),
    supportsTablet: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // So the app can tell whether the Tailscale app is installed before opening it.
      LSApplicationQueriesSchemes: ['tailscale'],
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: SURFACE_APP },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 96,
        // The app opens in the appearance the phone is in, so the splash does too.
        backgroundColor: SURFACE_APP_LIGHT,
        dark: { image: './assets/splash-icon.png', backgroundColor: SURFACE_APP },
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: CAMERA,
        // Not false: that removes the key and blocks RECORD_AUDIO, which dictation needs.
        // The app never records video; this is dictation's string (see MICROPHONE).
        microphonePermission: MICROPHONE,
        recordAudioAndroid: true,
      },
    ],
    // Placeholder art (assets/*.png are generated, neutral, unbranded) until real branding lands.
    [
      'expo-notifications',
      {
        icon: './assets/notification-icon.png',
        color: '#0a0a0a',
        enableRemoteNotifications: pushEntitlement(),
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Sends the photos you pick to your agent on your Mac.',
        cameraPermission: CAMERA,
        microphonePermission: MICROPHONE,
      },
    ],
    'expo-document-picker',
    'expo-image',
    'expo-sharing',
    [
      'expo-speech-recognition',
      { microphonePermission: MICROPHONE, speechRecognitionPermission: SPEECH },
    ],
    '@react-native-community/datetimepicker',
    ...(shareExtension
      ? [
          [
            'expo-share-intent',
            {
              iosActivationRules: {
                NSExtensionActivationSupportsText: true,
                NSExtensionActivationSupportsWebURLWithMaxCount: 1,
                NSExtensionActivationSupportsWebPageWithMaxCount: 1,
                NSExtensionActivationSupportsImageWithMaxCount: 10,
                NSExtensionActivationSupportsFileWithMaxCount: 10,
              },
              iosShareExtensionName: `Send to ${brand.name}`,
              androidIntentFilters: ['text/*', 'image/*', '*/*'],
              androidMultiIntentFilters: ['image/*', '*/*'],
            },
          ] as [string, Record<string, unknown>],
        ]
      : []),
  ],
  experiments: { typedRoutes: true },
  extra: {
    brand,
    official: Boolean(projectId),
    // Read by src/lib/shareIntent.tsx: only a build with the extension runs its hook.
    shareExtension,
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
