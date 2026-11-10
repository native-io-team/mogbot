import type { ExpoConfig } from 'expo/config';
import {
  withAppBuildGradle,
  withDangerousMod,
  withFinalizedMod,
  type ConfigPlugin,
} from 'expo/config-plugins';
import * as fs from 'fs';
import * as path from 'path';
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
/**
 * Who publishes the store build: the Apple team it signs with, and the
 * copyright line. A self-build signs with the user's own team (APPLE_TEAM_ID)
 * and carries neither (docs/app-store.md, docs/play-store.md).
 */
export const STORE_PUBLISHER = {
  appleTeamId: 'N2VB8A88LB',
  copyright: '© 2026 Galluzzo Conseil Inc.',
} as const;
/**
 * Android's versionCode: an integer that must go up with every upload to
 * Google Play, like the iOS build number, and from the same
 * COMPANION_BUILD_NUMBER (EAS keeps it remotely for its own builds).
 */
export function versionCode(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 2100000000)
    throw new Error(`COMPANION_BUILD_NUMBER must be a whole number from 1, not "${raw}".`);
  return n;
}
/**
 * The Android permissions the app asks for, each for one thing it does:
 * the network (to reach the paired Mac), the camera (the pairing code, photos
 * to send), the microphone (dictation and Talk), notifications (Android 13+'s
 * runtime prompt, asked only when alerts are turned on) and vibration
 * (haptics). Everything else a library would add is blocked below.
 */
export const ANDROID_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
];
/**
 * Removed from the merged manifest (`tools:node="remove"`). Photos come from
 * the system photo picker and files from the system document picker, neither
 * of which needs storage or media access, which Google Play's photo and video
 * policy refuses for an app that only picks now and then. The overlay is the
 * development menu's; boot-completed only re-arms scheduled notifications,
 * and the app schedules none. Kept from libraries, none asked for at run
 * time: ACCESS_WIFI_STATE (NetInfo), WAKE_LOCK and c2dm RECEIVE (Firebase
 * messaging, in expo-notifications), and the launchers' badge permissions
 * (ShortcutBadger, for the icon badge on Samsung, Huawei, Sony… launchers).
 * scripts/store-android.sh fails on anything else.
 */
export const ANDROID_BLOCKED_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  // expo-secure-store's, for keys behind biometrics; the app's keys aren't.
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  // expo-application's install referrer, which the app never reads.
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
];
/**
 * The Play upload key, read at build time from Gradle properties
 * (`~/.gradle/gradle.properties`) or the environment, never from the repo
 * (docs/play-store.md, "Signing"). Without them a release build is signed
 * with the debug key, which Play refuses: scripts/store-android.sh checks.
 */
export const UPLOAD_KEY_PROPS = [
  'COMPANION_UPLOAD_STORE_FILE',
  'COMPANION_UPLOAD_STORE_PASSWORD',
  'COMPANION_UPLOAD_KEY_ALIAS',
  'COMPANION_UPLOAD_KEY_PASSWORD',
] as const;
const RELEASE_DEBUG_SIGNING =
  /(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/;
export const UPLOAD_SIGNING_MARK = '// Upload key (docs/play-store.md, "Signing")';
export function withUploadSigning(gradle: string): string {
  if (gradle.includes(UPLOAD_SIGNING_MARK)) return gradle;
  const prop = (k: string) => `companionProp('${k}')`;
  const helper = `${UPLOAD_SIGNING_MARK}: Gradle property or environment, never committed.
def companionProp = { String k -> findProperty(k) ?: System.getenv(k) }
def companionUploadKey = companionProp('COMPANION_UPLOAD_STORE_FILE') != null

android {`;
  const upload = `signingConfigs {
        if (companionUploadKey) {
            upload {
                storeFile file(${prop('COMPANION_UPLOAD_STORE_FILE')})
                storePassword ${prop('COMPANION_UPLOAD_STORE_PASSWORD')}
                keyAlias ${prop('COMPANION_UPLOAD_KEY_ALIAS')}
                keyPassword ${prop('COMPANION_UPLOAD_KEY_PASSWORD')}
            }
        }`;
  let next = gradle.replace(/^android \{/m, helper);
  next = next.replace(/signingConfigs \{/, upload);
  next = next.replace(
    RELEASE_DEBUG_SIGNING,
    '$1signingConfig companionUploadKey ? signingConfigs.upload : signingConfigs.debug'
  );
  if (!next.includes('signingConfigs.upload : signingConfigs.debug') || !next.includes('upload {'))
    throw new Error('app/build.gradle: no release signingConfig to give the upload key to.');
  return next;
}
const withUploadKey: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy')
      throw new Error('app/build.gradle: expected Groovy for the upload-key signing config.');
    c.modResults.contents = withUploadSigning(c.modResults.contents);
    return c;
  });
/**
 * The Android package (applicationId, what Play and the phone see) is
 * brand.json's id, but the Gradle namespace (the Java package the R and
 * BuildConfig classes are generated in, and where MainActivity lives) can't
 * have a Java keyword in it, and `io.native.…` does. So the namespace gets an
 * underscore after any keyword segment (`io.native_.mogbot.companion`), which
 * nobody sees; the applicationId is unchanged. AGP refuses to build otherwise
 * ("'native' is a Java keyword").
 */
const JAVA_KEYWORDS = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double ' +
    'else enum extends final finally float for goto if implements import instanceof int interface ' +
    'long native new package private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while true false null var record yield'
  ).split(' ')
);
export const androidNamespace = (id: string): string =>
  id
    .split('.')
    .map((seg) => (JAVA_KEYWORDS.has(seg) ? `${seg}_` : seg))
    .join('.');
export const withJavaSafeNamespace: ConfigPlugin = (config) =>
  withFinalizedMod(config, [
    'android',
    async (c) => {
      const id = c.android?.package;
      if (!id) return c;
      const ns = androidNamespace(id);
      if (ns === id) return c;
      const root = c.modRequest.platformProjectRoot;
      const gradlePath = path.join(root, 'app', 'build.gradle');
      const gradle = fs.readFileSync(gradlePath, 'utf8');
      const nextGradle = gradle.replace(`namespace '${id}'`, `namespace '${ns}'`);
      if (nextGradle === gradle && !gradle.includes(`namespace '${ns}'`))
        throw new Error(`app/build.gradle: no namespace '${id}' to make Java-safe.`);
      fs.writeFileSync(gradlePath, nextGradle);
      const src = path.join(root, 'app', 'src', 'main', 'java');
      const from = path.join(src, ...id.split('.'));
      const to = path.join(src, ...ns.split('.'));
      if (fs.existsSync(from)) {
        fs.mkdirSync(to, { recursive: true });
        for (const f of fs.readdirSync(from)) {
          const text = fs.readFileSync(path.join(from, f), 'utf8');
          fs.writeFileSync(path.join(to, f), text.replace(`package ${id}`, `package ${ns}`));
          fs.rmSync(path.join(from, f));
        }
        // Drop the now-empty folders of the old path, deepest first.
        for (let d = from; d !== src && fs.readdirSync(d).length === 0; d = path.dirname(d))
          fs.rmdirSync(d);
      }
      return c;
    },
  ]);
// A build on the user's own Mac signs with their team (the desktop app's
// Phone → Install on my phone sets it); unset, Xcode's own signing settings apply.
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
 * The Live Activity while an agent works (src/lib/liveActivity.ts) is a
 * widget extension, which expo-widgets adds, with an App Group a free Apple
 * team can't always sign. Off unless asked for, as the share extension is,
 * so `expo prebuild` for a free-team self-build is unchanged. The store
 * build (the owner's paid team signs the App Group) has it unless
 * `SHIPSTUDIO_LIVE_ACTIVITY=0`. The flag also reaches the app as
 * `extra.liveActivity`, which is what it checks.
 */
export const liveActivity = (env: Record<string, string | undefined> = process.env): boolean =>
  env.SHIPSTUDIO_LIVE_ACTIVITY === '1' || (storeBuild(env) && env.SHIPSTUDIO_LIVE_ACTIVITY !== '0');
/**
 * Without the Live Activity, expo-widgets isn't linked into the app at all:
 * autolinking would otherwise add its pod to every build, with a build phase
 * that bundles widget JavaScript at Xcode time. Its Android half is excluded
 * (with @expo/ui, which nothing on Android uses) in package.json
 * (`expo.autolinking.android.exclude`); iOS can't be, since
 * the flag must be able to bring it back, so the Podfile is told here.
 */
export const EXCLUDE_WIDGETS = "use_expo_modules!(exclude: ['expo-widgets'])";
export const withoutWidgets: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'ios',
    async (c) => {
      const podfile = path.join(c.modRequest.platformProjectRoot, 'Podfile');
      const text = fs.readFileSync(podfile, 'utf8');
      if (!text.includes(EXCLUDE_WIDGETS)) {
        const next = text.replace(/^(\s*)use_expo_modules!\s*$/m, `$1${EXCLUDE_WIDGETS}`);
        if (next === text)
          throw new Error('Podfile: no `use_expo_modules!` to exclude expo-widgets from.');
        fs.writeFileSync(podfile, next);
      }
      return c;
    },
  ]);
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
  const appleTeamId =
    process.env.APPLE_TEAM_ID ?? (storeBuild() ? STORE_PUBLISHER.appleTeamId : undefined);
  // Firebase's config for Android push (FCM). Only the owner's Firebase
  // project has one; without it the app never asks Android for a push token.
  const googleServices = process.env.GOOGLE_SERVICES_JSON;
  const config: ExpoConfig = {
    name: brand.name,
    slug: `${brand.slug}-companion`,
    // Must match PAIRING_SCHEME in @shipstudio/companion-protocol (generated from
    // the same brand.json field; `pnpm check:brand` fails if they drift).
    scheme: brand.companion.scheme,
    version: APP_VERSION,
    // Landscape and iPad: the Agents list and a chat sit side by side when there's room.
    orientation: 'default',
    // The mark on a Graphite key, full bleed (scripts/build-icons.mjs draws every icon here).
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
      // iOS 18+ Home Screen appearances: the mark alone on the system's own
      // dark or tinted plate.
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
        ...(storeBuild()
          ? {
              NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
              NSHumanReadableCopyright: STORE_PUBLISHER.copyright,
            }
          : {}),
      },
    },
    android: {
      package: bundleId,
      versionCode: versionCode(buildNumber),
      // Android 13+ themed icons use the monochrome layer (scripts/build-icons.mjs).
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        monochromeImage: './assets/adaptive-monochrome.png',
        backgroundColor: SURFACE_APP,
      },
      permissions: ANDROID_PERMISSIONS,
      blockedPermissions: ANDROID_BLOCKED_PERMISSIONS,
      ...(googleServices ? { googleServicesFile: googleServices } : {}),
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
      // The mark in white (assets/*.png are drawn by scripts/build-icons.mjs).
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
      // The Live Activity's extension: no home-screen widgets, only the activity.
      ...(liveActivity()
        ? [
            [
              'expo-widgets',
              {
                widgets: [],
                bundleIdentifier: `${bundleId}.LiveActivity`,
                groupIdentifier: `group.${bundleId}`,
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
      // Read by src/lib/liveActivity.ts: only a build with the extension starts one.
      liveActivity: liveActivity(),
      // Read by src/lib/push.ts: Android push needs Firebase's config in the build.
      androidPush: Boolean(googleServices),
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
  const signed = withJavaSafeNamespace(withUploadKey(config));
  return liveActivity() ? signed : withoutWidgets(signed);
};
