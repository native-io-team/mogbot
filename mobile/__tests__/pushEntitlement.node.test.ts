/**
 * A free Apple ID's personal team can't sign the push entitlement, so a
 * self-build must not ask for it (app.config.ts, `pushEntitlement`).
 * Checked end to end with `npx expo config --type introspect`: no
 * `aps-environment` unless EAS_PROJECT_ID or COMPANION_PUSH_ENTITLEMENT=1.
 */
import appConfig, { pushEntitlement } from '../app.config';

const notificationsOptions = () => {
  const entry = appConfig().plugins?.find(
    (p) => Array.isArray(p) && p[0] === 'expo-notifications'
  ) as [string, { enableRemoteNotifications?: boolean }] | undefined;
  return entry?.[1];
};

describe('push entitlement', () => {
  it('is left out of a self-build, which a personal team could not sign', () => {
    expect(pushEntitlement({})).toBe(false);
    expect(pushEntitlement({ APPLE_TEAM_ID: 'H8NN6DM6G6', COMPANION_BUNDLE_ID: 'x.y' })).toBe(
      false
    );
    expect(pushEntitlement({ COMPANION_PUSH_ENTITLEMENT: '0' })).toBe(false);
  });

  it('is in an official build, or one that asks for it', () => {
    expect(pushEntitlement({ EAS_PROJECT_ID: 'abc' })).toBe(true);
    expect(pushEntitlement({ COMPANION_PUSH_ENTITLEMENT: '1' })).toBe(true);
  });

  it('reaches expo-notifications as enableRemoteNotifications', () => {
    const saved = { ...process.env };
    try {
      delete process.env.EAS_PROJECT_ID;
      delete process.env.COMPANION_PUSH_ENTITLEMENT;
      expect(notificationsOptions()?.enableRemoteNotifications).toBe(false);
      process.env.COMPANION_PUSH_ENTITLEMENT = '1';
      expect(notificationsOptions()?.enableRemoteNotifications).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
