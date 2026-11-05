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
const CAMERA =
  'Used to scan the pairing code on your Mac, and to take photos you send to your agents.';

export default (): ExpoConfig => ({
  name: brand.name,
  slug: `${brand.slug}-companion`,
  // Must match PAIRING_SCHEME in @shipstudio/companion-protocol (generated from
  // the same brand.json field; `pnpm check:brand` fails if they drift).
  scheme: brand.companion.scheme,
  version: '0.1.0',
  // Landscape and iPad: the Agents list and a chat sit side by side when there's room.
  orientation: 'default',
  icon: './assets/icon.png',
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
    adaptiveIcon: { foregroundImage: './assets/icon.png', backgroundColor: SURFACE_APP },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    [
      'expo-splash-screen',
      { image: './assets/splash-icon.png', imageWidth: 96, backgroundColor: SURFACE_APP },
    ],
    [
      'expo-camera',
      {
        cameraPermission: CAMERA,
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    ['expo-notifications', { color: '#46e76f' }],
    [
      'expo-image-picker',
      {
        photosPermission: 'Sends the photos you pick to your agent on your Mac.',
        cameraPermission: CAMERA,
        microphonePermission: false,
      },
    ],
    'expo-document-picker',
    'expo-image',
    'expo-sharing',
  ],
  experiments: { typedRoutes: true },
  extra: {
    brand,
    official: Boolean(projectId),
    ...(projectId ? { eas: { projectId } } : {}),
  },
});
