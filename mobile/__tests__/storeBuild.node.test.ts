/**
 * The App Store build (app.config.ts, `COMPANION_STORE_BUILD=1`;
 * docs/app-store.md): brand.json's own bundle id, official, push, a
 * privacy manifest, no Face ID string and no plain-HTTP exceptions.
 */
import appConfig, {
  ANDROID_BLOCKED_PERMISSIONS,
  ANDROID_PERMISSIONS,
  PRIVACY_MANIFEST,
  STORE_PUBLISHER,
  UPLOAD_SIGNING_MARK,
  pushEntitlement,
  storeBuild,
  versionCode,
  withUploadSigning,
} from '../app.config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const brand = require('../../brand.json') as { companion: { bundleId: string } };

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const k of [
      'EAS_PROJECT_ID',
      'COMPANION_BUNDLE_ID',
      'COMPANION_STORE_BUILD',
      'COMPANION_PUSH_ENTITLEMENT',
      'COMPANION_BUILD_NUMBER',
      'APPLE_TEAM_ID',
      'GOOGLE_SERVICES_JSON',
    ])
      delete process.env[k];
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = saved;
  }
}

describe('the store build', () => {
  it('is official, with push, on brand.json’s bundle id', () =>
    withEnv({ COMPANION_STORE_BUILD: '1', COMPANION_BUILD_NUMBER: '7' }, () => {
      expect(storeBuild()).toBe(true);
      expect(pushEntitlement()).toBe(true);
      const c = appConfig();
      expect(c.ios?.bundleIdentifier).toBe(brand.companion.bundleId);
      expect(c.ios?.buildNumber).toBe('7');
      expect(c.extra?.official).toBe(true);
      // The screenshots hook (lib/screenshots.ts) is never in a build that ships.
      expect(c.extra?.screenshots).toBe(false);
      expect(c.ios?.infoPlist?.NSAppTransportSecurity).toEqual({ NSAllowsArbitraryLoads: false });
      expect(c.ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
    }));

  it('refuses a self-build’s bundle id', () =>
    withEnv(
      { COMPANION_STORE_BUILD: '1', COMPANION_BUNDLE_ID: `${brand.companion.bundleId}.abc123` },
      () => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fresh = require('../app.config') as typeof import('../app.config');
          expect(() => fresh.default()).toThrow(/store build uses brand.json/);
        });
      }
    ));

  it('leaves a self-build as it was', () =>
    withEnv({ COMPANION_BUNDLE_ID: `${brand.companion.bundleId}.abc123` }, () => {
      expect(storeBuild()).toBe(false);
      expect(pushEntitlement()).toBe(false);
      expect(appConfig().extra?.official).toBe(false);
      expect(appConfig().ios?.infoPlist?.NSAppTransportSecurity).toBeUndefined();
    }));

  it('never asks for Face ID, which it doesn’t use', () => {
    const entry = appConfig().plugins?.find(
      (p) => Array.isArray(p) && p[0] === 'expo-secure-store'
    ) as [string, { faceIDPermission?: unknown }] | undefined;
    expect(entry?.[1].faceIDPermission).toBe(false);
  });

  it('declares no tracking and no collected data, and every required-reason API', () => {
    expect(PRIVACY_MANIFEST.NSPrivacyTracking).toBe(false);
    expect(PRIVACY_MANIFEST.NSPrivacyCollectedDataTypes).toEqual([]);
    const kinds = PRIVACY_MANIFEST.NSPrivacyAccessedAPITypes.map((a) =>
      a.NSPrivacyAccessedAPIType.replace('NSPrivacyAccessedAPICategory', '')
    );
    expect(kinds.sort()).toEqual(['DiskSpace', 'FileTimestamp', 'SystemBootTime', 'UserDefaults']);
    expect(appConfig().ios?.privacyManifests).toBe(PRIVACY_MANIFEST);
  });
});

describe('who publishes the store build', () => {
  it('signs with the company team and carries its copyright', () =>
    withEnv({ COMPANION_STORE_BUILD: '1' }, () => {
      const c = appConfig();
      expect(STORE_PUBLISHER.appleTeamId).toBe('N2VB8A88LB');
      expect(c.ios?.appleTeamId).toBe('N2VB8A88LB');
      expect(c.ios?.infoPlist?.NSHumanReadableCopyright).toBe('© 2026 Galluzzo Conseil Inc.');
    }));

  it('leaves a self-build on the user’s own team, with no copyright', () =>
    withEnv({ APPLE_TEAM_ID: 'ABCDE12345' }, () => {
      const c = appConfig();
      expect(c.ios?.appleTeamId).toBe('ABCDE12345');
      expect(c.ios?.infoPlist?.NSHumanReadableCopyright).toBeUndefined();
    }));
});

describe('the Google Play build', () => {
  it('is brand.json’s package, with the build number as its versionCode', () =>
    withEnv({ COMPANION_STORE_BUILD: '1', COMPANION_BUILD_NUMBER: '12' }, () => {
      const c = appConfig();
      expect(c.android?.package).toBe(brand.companion.bundleId);
      expect(c.android?.versionCode).toBe(12);
      expect(c.version).toBe('1.0.0');
    }));

  it('refuses a versionCode Play can’t take', () => {
    expect(() => versionCode('1.2')).toThrow(/whole number/);
    expect(() => versionCode('0')).toThrow(/whole number/);
    expect(() => versionCode('x')).toThrow(/whole number/);
    expect(versionCode('3')).toBe(3);
  });

  it('asks only for what it uses, and blocks storage, media, overlay and location', () => {
    const c = appConfig();
    expect([...(c.android?.permissions ?? [])].sort()).toEqual([...ANDROID_PERMISSIONS].sort());
    expect(c.android?.permissions).toContain('android.permission.POST_NOTIFICATIONS');
    for (const p of [
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.ACCESS_FINE_LOCATION',
    ])
      expect(c.android?.blockedPermissions).toContain(p);
    for (const p of ANDROID_PERMISSIONS) expect(ANDROID_BLOCKED_PERMISSIONS).not.toContain(p);
  });

  it('has a themed-icon (monochrome) layer', () => {
    expect(appConfig().android?.adaptiveIcon?.monochromeImage).toBe(
      './assets/adaptive-monochrome.png'
    );
  });

  it('compiles Firebase in only when given its config', () => {
    withEnv({ COMPANION_STORE_BUILD: '1' }, () => {
      expect(appConfig().android?.googleServicesFile).toBeUndefined();
      expect(appConfig().extra?.androidPush).toBe(false);
    });
    withEnv({ COMPANION_STORE_BUILD: '1', GOOGLE_SERVICES_JSON: './google-services.json' }, () => {
      expect(appConfig().android?.googleServicesFile).toBe('./google-services.json');
      expect(appConfig().extra?.androidPush).toBe(true);
    });
  });

  it('signs a release with the upload key from Gradle properties, never a committed one', () => {
    const template = `def jscFlavor = 'x'

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled true
        }
    }
}
`;
    const out = withUploadSigning(template);
    expect(out).toContain(UPLOAD_SIGNING_MARK);
    expect(out).toContain("findProperty(k) ?: System.getenv(k)");
    expect(out).toContain('signingConfig companionUploadKey ? signingConfigs.upload : signingConfigs.debug');
    // The debug build type keeps the debug key.
    expect(out).toMatch(/debug \{\n\s*signingConfig signingConfigs\.debug/);
    // No password or path is ever written into the file.
    expect(out).not.toMatch(/storePassword '/);
    // Running it twice changes nothing.
    expect(withUploadSigning(out)).toBe(out);
    expect(() => withUploadSigning('android {\n}\n')).toThrow(/release signingConfig/);
  });
});
