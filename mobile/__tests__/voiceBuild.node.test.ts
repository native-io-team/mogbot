/**
 * The native parts of voice in the app config: the Siri intents in every
 * build (App Intents need no entitlement), the Live Activity's extension only
 * when asked for (it needs an App Group), and expo-widgets kept out of every
 * other build. `npx expo prebuild -p ios` was run both ways by hand.
 */
import appConfig, { EXCLUDE_WIDGETS, liveActivity } from '../app.config';

const withEnv = <T>(env: Record<string, string>, fn: () => T): T => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
};
const pluginNames = (c: ReturnType<typeof appConfig>) =>
  (c.plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));

describe('voice in the app config', () => {
  it('carries the Siri intents in every build, from app-intents/', () => {
    const c = appConfig();
    expect(pluginNames(c)).toContain('expo-app-intents');
    expect(c.experiments?.inlineModules?.watchedDirectories).toEqual(['app-intents']);
  });

  it('has no Live Activity extension unless asked for, and keeps expo-widgets out', () => {
    expect(liveActivity({})).toBe(false);
    // The store build (a paid team) has it, unless turned off.
    expect(liveActivity({ COMPANION_STORE_BUILD: '1' })).toBe(true);
    expect(liveActivity({ COMPANION_STORE_BUILD: '1', SHIPSTUDIO_LIVE_ACTIVITY: '0' })).toBe(false);
    const c = appConfig();
    expect(pluginNames(c)).not.toContain('expo-widgets');
    expect(c.extra?.liveActivity).toBe(false);
    // The Podfile edit is queued as a dangerous mod.
    expect((c as { mods?: { ios?: { dangerous?: unknown } } }).mods?.ios?.dangerous).toBeDefined();
    expect(EXCLUDE_WIDGETS).toContain("exclude: ['expo-widgets']");
  });

  it('adds the extension, with its own id and App Group, when SHIPSTUDIO_LIVE_ACTIVITY=1', () => {
    const c = withEnv({ SHIPSTUDIO_LIVE_ACTIVITY: '1' }, () => appConfig());
    const entry = c.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-widgets') as
      | [string, { bundleIdentifier: string; groupIdentifier: string; widgets: unknown[] }]
      | undefined;
    const id = c.ios?.bundleIdentifier;
    expect(entry?.[1]).toEqual({
      widgets: [],
      bundleIdentifier: `${id}.LiveActivity`,
      groupIdentifier: `group.${id}`,
    });
    expect(c.extra?.liveActivity).toBe(true);
  });
});
