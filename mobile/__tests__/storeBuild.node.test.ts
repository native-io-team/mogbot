/**
 * The App Store build (app.config.ts, `COMPANION_STORE_BUILD=1`;
 * docs/app-store.md): brand.json's own bundle id, official, push, a
 * privacy manifest, no Face ID string and no plain-HTTP exceptions.
 */
import appConfig, { PRIVACY_MANIFEST, pushEntitlement, storeBuild } from '../app.config';

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
