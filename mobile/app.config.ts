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
/**
 * The App Store (and TestFlight) build: COMPANION_STORE_BUILD=1, which the
 * EAS `production` profile sets, or set by hand for a local
 * `xcodebuild archive` (docs/app-store.md). It is the official build (push
 * entitlement, "official" to the Mac) and must carry brand.json's own bundle
 * id: a self-build's `<id>.<hex>` or `.self` can never reach the store.
 */
export const storeBuild = (env: Record<string, string | undefined> = process.env): boolean =>
  env.COMPANION_STORE_BUILD === '1';
/**
 * The marketing version people see in the App Store, and the build number,
 * which must go up with every upload of that version. EAS keeps the build
 * number itself (`appVersionSource: remote`, `autoIncrement`); a local
 * archive passes COMPANION_BUILD_NUMBER.
 */
export const APP_VERSION = '1.0.0';
// A build on the user's own Mac signs with their team (the desktop app's
// Phone → Install on my phone sets it); unset, Xcode's own signing settings apply.
const appleTeamId = process.env.APPLE_TEAM_ID;
const updatesUrl = process.env.UPDATES_URL ?? (projectId ? `https://u.expo.dev/${projectId}` : '');

const SURFACE_APP = '#151413'; // the dark palette's surfaceApp (src/lib/theme.ts)
const SURFACE_APP_LIGHT = '#fdfcfa'; // the light palette's surfaceApp (src/lib/theme.ts)
const CAMERA =
  'Used to scan the pairing code on your Mac, and to take photos you send to your agents.';
/**
 * iOS has one microphone string for the whole app, and expo-camera,
 * expo-image-picker and expo-speech-recognition each write it, so it says
 * only what the mic is for. Where the words are recognised is the speech
 * string's job: on the phone when it can be, else Apple's service, which the
 * field also says while it listens (src/lib/dictation.ts, `listeningNote`).
 */
const MICROPHONE = 'Used when you dictate a message to your agents.';
const SPEECH =
  'Turns what you dictate into text, on this phone when it can, for you to read before you send it.';
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
  Boolean(env.EAS_PROJECT_ID) || storeBuild(env) || env.COMPANION_PUSH_ENTITLEMENT === '1';

/**
 * Apple's required-reason APIs, declared for the app and the libraries
 * statically linked into it (whose own PrivacyInfo files don't reach the
 * app's privacy report that way). The union of every manifest the native
 * dependencies ship: React Native and Folly/glog/boost (file timestamps,
 * boot time, user defaults), expo-file-system (timestamps, disk space),
 * expo-application, expo-constants, expo-system-ui, expo-notifications,
 * expo-device. Nothing is collected and nothing tracks: everything the app
 * handles goes to the user's own Mac, never to us (docs/app-store.md,
 * "Privacy"). Re-check when a native dependency is added.
 */
export const PRIVACY_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyTrackingDomains: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
      NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
      NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
    },
    {
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
      NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
    },
  ],
};

export default (): ExpoConfig => {
  // The official id is brand.json's; a self-build gets its own (docs/mobile.md,
  // "Installing the app"). Register it in the owner's Apple team before the
  // first store upload (docs/app-store.md, "Owner checklist").
  const bundleId = process.env.COMPANION_BUNDLE_ID ?? brand.companion.bundleId;
  if (storeBuild() && bundleId !== brand.companion.bundleId) {
    throw new Error(
      `A store build uses brand.json's bundle id (${brand.companion.bundleId}), not ${bundleId}. Unset COMPANION_BUNDLE_ID.`
    );
  }
  const buildNumber = process.env.COMPANION_BUILD_NUMBER ?? '1';
  return {
    name: brand.name,
    slug: `${brand.slug}-companion`,
    // Must match PAIRING_SCHEME in @shipstudio/companion-protocol (generated from
    // the same brand.json field; `pnpm check:brand` fails if they drift).
    scheme: brand.companion.scheme,
    version: APP_VERSION,
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
      // iOS 18+ Home Screen appearances: the ring alone on the system's own
      // dark or tinted plate (made from icon.png; placeholder art, unbranded).
      icon: {
        light: './assets/icon.png',
        dark: './assets/icon-dark.png',
        tinted: './assets/icon-tinted.png',
      },
      buildNumber,
      ...(appleTeamId ? { appleTeamId } : {}),
      supportsTablet: true,
      privacyManifests: PRIVACY_MANIFEST,
      infoPlist: {
        // Only HTTPS (the system's TLS) and signatures that prove the paired Mac
        // is who it says (Ed25519 via @noble/curves) and hashes: encryption for
        // authentication, exempt. docs/app-store.md, "Export compliance".
        ITSAppUsesNonExemptEncryption: false,
        // So the app can tell whether the Tailscale app is installed before opening it.
        LSApplicationQueriesSchemes: ['tailscale'],
        // The store build talks only HTTPS to *.ts.net (and Apple's own
        // services): no plain-HTTP exceptions, which a development build keeps
        // for the mock Mac on localhost.
        ...(storeBuild() ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } } : {}),
      },
    },
    android: {
      package: bundleId,
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: SURFACE_APP },
      predictiveBackGestureEnabled: true,
    },
    plugins: [
      'expo-router',
      // No Face ID: the keychain items aren't behind biometrics, so the app
      // has no reason to ask (and must not ship a placeholder for it).
      ['expo-secure-store', { faceIDPermission: false }],
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
      // Siri and Shortcuts: "Tell <app>…" (src/lib/siri.ts). The intents are
      // Swift in app-intents/, compiled into the app target by inline modules
      // (below), which Apple's metadata extraction needs. No entitlement: App
      // Intents need none, so a free team's build carries them too.
      'expo-app-intents',
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
    experiments: { typedRoutes: true, inlineModules: { watchedDirectories: ['app-intents'] } },
    extra: {
      brand,
      official: Boolean(projectId) || storeBuild(),
      // Only for taking store screenshots on a simulator (lib/screenshots.ts); never uploaded.
      screenshots: process.env.COMPANION_SCREENSHOTS === '1',
      // Read by src/lib/shareIntent.tsx: only a build with the extension runs its hook.
      shareExtension,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
