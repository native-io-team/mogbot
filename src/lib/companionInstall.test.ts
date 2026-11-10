import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  androidSteps,
  buildIosInstallPrompt,
  expiryLine,
  iosBuildCommand,
  iosProjectName,
  iosSteps,
  installAgent,
  installPrompt,
  isFreeTeamExpiry,
  reinstallCommand,
  readInstallRecord,
  reminderDue,
  saveInstallRecord,
  xcodeBlocks,
  type AndroidInstallStatus,
  type IosInstallStatus,
} from './companionInstall';

// Features brand.json can switch off are tested switched on.
vi.mock('./brand', async (importOriginal) => {
  const { withAllLinks } = await import('../test/brandFixture');
  return withAllLinks(await importOriginal<typeof import('./brand')>());
});

const source = {
  path: '/Users/me/ShipStudio/.companion-build/mobile',
  present: false,
  installed: false,
  desktopVersion: '1.7.0',
  buildLog: '/Users/me/Library/Application Support/Mogbot/companion-build/last-build.log',
};

/** This Mac, as the real checks read it: Xcode 26.1, no phone. */
const thisMac: IosInstallStatus = {
  xcode: { state: 'tooOld', version: '26.1' },
  xcodeMinimum: '26.4',
  clt: true,
  cocoapods: '1.16.2',
  node: 'v24.17.0',
  devices: [],
  signing: {
    teamId: 'TEAM000001',
    teamName: null,
    identity: 'Apple Development: me',
    free: null,
    bundleId: 'io.native.mogbot.companion.87be70',
  },
  source,
};

const iphone = {
  udid: '00008140-001',
  hardwareUdid: '00008140-001' as string | null,
  name: 'Sam’s iPhone',
  model: 'iPhone 16 Pro',
  osVersion: '26.1',
  connected: true,
  paired: true,
  developerMode: 'enabled',
};

const state = (steps: { id: string; state: string }[]) =>
  Object.fromEntries(steps.map((s) => [s.id, s.state]));

describe('iosSteps', () => {
  it('an old Xcode is the user’s, with the App Store, and blocks the agent', () => {
    const steps = iosSteps(thisMac, null);
    const xcode = steps.find((s) => s.id === 'xcode');
    expect(xcode?.state).toBe('you');
    expect(xcode?.detail).toContain('26.1');
    expect(xcode?.appStore).toBe('Update Xcode in the App Store');
    expect(xcodeBlocks(thisMac)).toBe(true);
    expect(state(steps)).toMatchObject({
      tools: 'done',
      phone: 'you',
      devmode: 'waiting',
      signing: 'done',
      build: 'waiting',
    });
  });

  it('first launch is the agent’s, not a block', () => {
    const s = { ...thisMac, xcode: { state: 'needsFirstLaunch' as const, version: '26.4' } };
    expect(xcodeBlocks(s)).toBe(false);
    expect(state(iosSteps(s, null)).xcode).toBe('agent');
  });

  it('an unaccepted license (after an Xcode update) is the agent’s too', () => {
    const s = { ...thisMac, xcode: { state: 'needsLicense' as const, version: '27.2' } };
    expect(xcodeBlocks(s)).toBe(false);
    const xcode = iosSteps(s, null).find((x) => x.id === 'xcode');
    expect(xcode?.state).toBe('agent');
    expect(xcode?.detail).toContain('license');
  });

  it('a phone that hasn’t trusted the Mac, then Developer Mode, then the build', () => {
    const ok = { ...thisMac, xcode: { state: 'ok' as const, version: '26.4' } };
    const untrusted = iosSteps({ ...ok, devices: [{ ...iphone, paired: false }] }, null);
    expect(state(untrusted)).toMatchObject({ phone: 'you', devmode: 'waiting' });
    const devOff = iosSteps({ ...ok, devices: [{ ...iphone, developerMode: 'disabled' }] }, null);
    expect(state(devOff)).toMatchObject({ phone: 'done', devmode: 'you', build: 'agent' });
    const installed = iosSteps(
      { ...ok, devices: [iphone] },
      {
        installed: true,
        version: '0.1.0',
        expiresAt: null,
      }
    );
    expect(installed.every((s) => s.state === 'done')).toBe(true);
  });

  it('a disconnected phone doesn’t count', () => {
    const s = { ...thisMac, devices: [{ ...iphone, connected: false }] };
    expect(state(iosSteps(s, null)).phone).toBe('you');
  });

  it('no Xcode: the phone and the Apple ID wait for it, rather than asking now', () => {
    const s = { ...thisMac, xcode: { state: 'missing' as const }, signing: null };
    const steps = iosSteps(s, null);
    expect(state(steps)).toMatchObject({ phone: 'waiting', signing: 'waiting' });
    expect(steps.find((x) => x.id === 'phone')?.detail).toContain('once Xcode is installed');
  });

  it('signed in to Xcode with no certificate yet still ticks: the first build makes it', () => {
    const s = {
      ...thisMac,
      signing: {
        teamId: 'TEAM000001',
        teamName: 'Sam Doe (Personal Team)',
        identity: null,
        free: true,
        bundleId: 'io.native.mogbot.companion.87be70',
      },
    };
    const signing = iosSteps(s, null).find((x) => x.id === 'signing');
    expect(signing?.state).toBe('done');
    expect(signing?.detail).toBe(
      'Sam Doe (Personal Team) · its certificate is made by the first build'
    );
  });

  it('not signed in to Xcode: the user’s, with where to click', () => {
    const ok = { ...thisMac, xcode: { state: 'ok' as const, version: '26.4' }, signing: null };
    const signing = iosSteps(ok, null).find((x) => x.id === 'signing');
    expect(signing?.state).toBe('you');
    expect(signing?.detail).toContain('Xcode → Settings → Accounts');
  });

  it('a phone that won’t answer with Developer Mode on is a locked phone', () => {
    const ok = { ...thisMac, xcode: { state: 'ok' as const, version: '26.4' }, devices: [iphone] };
    const build = iosSteps(ok, { installed: null, version: null, expiresAt: null }).find(
      (x) => x.id === 'build'
    );
    expect(build?.state).toBe('you');
    expect(build?.detail).toContain('Unlock Sam’s iPhone');
    // With Developer Mode off that row already says why; the build just waits on the agent.
    const off = { ...ok, devices: [{ ...iphone, developerMode: 'disabled' }] };
    expect(state(iosSteps(off, { installed: null, version: null, expiresAt: null })).build).toBe(
      'agent'
    );
  });
});

describe('the install agent', () => {
  it('is Codex when that’s the engine chosen, else Claude Code', () => {
    expect(installAgent('codex')).toEqual({ binary: 'codex', name: 'Codex' });
    expect(installAgent('claude-code')).toEqual({ binary: 'claude', name: 'Claude Code' });
    expect(installAgent('opencode').binary).toBe('claude');
  });
});

describe('Reinstall’s log', () => {
  const ok = {
    ...thisMac,
    xcode: { state: 'ok' as const, version: '26.4' },
    devices: [iphone],
    source: { ...source, present: true, installed: true },
  };
  it('writes the build to the log and keeps its exit code through tee', () => {
    const cmd = reinstallCommand({ platform: 'ios', status: ok, app: null });
    expect(cmd).toMatch(/^mkdir -p '.*\/companion-build' && set -o pipefail && \{ cd /);
    expect(cmd).toContain(`| tee '${source.buildLog}'`);
    expect(cmd).toContain('xcodebuild');
  });
  it('a hand-off after a failed build points the agent at that log', () => {
    const s = { platform: 'ios' as const, status: ok, app: null };
    expect(installPrompt(s)).not.toContain('last-build.log');
    expect(installPrompt(s, true)).toContain(
      `The last build failed. Its full output is in ${source.buildLog}`
    );
    expect(installPrompt(s, true)).not.toContain('\n');
  });
});

describe('androidSteps', () => {
  const base: AndroidInstallStatus = {
    adb: null,
    sdk: false,
    jdk: false,
    node: 'v24',
    devices: [],
    package: 'io.native.mogbot.companion.self',
    source,
  };

  it('no adb: the agent installs it, and the phone waits', () => {
    expect(state(androidSteps(base, null))).toMatchObject({
      adb: 'agent',
      toolchain: 'agent',
      phone: 'waiting',
      build: 'waiting',
    });
  });

  it('an unauthorized phone asks the user to tap Allow', () => {
    const s = {
      ...base,
      adb: 'Android Debug Bridge version 1.0.41',
      devices: [{ serial: 'ZY22', state: 'unauthorized', model: null }],
    };
    const phone = androidSteps(s, null).find((x) => x.id === 'phone');
    expect(phone?.state).toBe('you');
    expect(phone?.detail).toContain('Allow');
  });
});

describe('the build', () => {
  it('builds Release with xcodebuild for the phone’s hardware UDID, then installs', () => {
    const cmd = iosBuildCommand(thisMac, iphone)!;
    expect(cmd).toContain("cd '/Users/me/ShipStudio/.companion-build/mobile'");
    expect(cmd).toContain('COMPANION_BUNDLE_ID=io.native.mogbot.companion.87be70');
    expect(cmd).toContain('APPLE_TEAM_ID=TEAM000001');
    const name = iosProjectName();
    expect(cmd).toContain(
      `npx expo prebuild -p ios --clean && cd ios && COMPANION_BUNDLE_ID=io.native.mogbot.companion.87be70 APPLE_TEAM_ID=TEAM000001 xcodebuild -workspace ${name}.xcworkspace -scheme ${name} -configuration Release -destination id=00008140-001 -allowProvisioningUpdates -derivedDataPath build DEVELOPMENT_TEAM=TEAM000001 CODE_SIGN_STYLE=Automatic build`
    );
    expect(cmd).toMatch(
      new RegExp(
        ` && xcrun devicectl device install app --device 00008140-001 build/Build/Products/Release-iphoneos/${name}\\.app$`
      )
    );
    // expo run:ios can't make a free team's provisioning profile.
    expect(cmd).not.toContain('run:ios');
    expect(iosBuildCommand({ ...thisMac, signing: null }, iphone)).toBeNull();
  });

  it('never builds for devicectl’s CoreDevice identifier', () => {
    const coreDeviceOnly = {
      ...iphone,
      udid: 'A1B2C3D4-0000-4000-8000-00000000AB12',
      hardwareUdid: null,
    };
    expect(iosBuildCommand(thisMac, coreDeviceOnly)).toBeNull();
    const prompt = buildIosInstallPrompt({ ...thisMac, devices: [coreDeviceOnly] });
    expect(prompt).toContain('xcrun xctrace list devices');
    expect(prompt).toContain('-destination id=<UDID>');
    expect(prompt).not.toContain('A1B2C3D4');
  });

  it('names the workspace the way expo prebuild does', () => {
    expect(iosProjectName('Mogbot')).toBe('Mogbot');
    expect(iosProjectName('Ship Studio')).toBe('ShipStudio');
    expect(iosProjectName('my_app-2')).toBe('myapp2');
    expect(iosProjectName('!!!')).toBe('app');
  });

  it('the prompt is one line, fetches the matching tag, and leaves done to the checklist', () => {
    const prompt = buildIosInstallPrompt(thisMac);
    expect(prompt).not.toContain('\n');
    expect(prompt.startsWith('-')).toBe(false);
    expect(prompt).toContain('--branch v1.7.0');
    expect(prompt).toContain('App Store');
    expect(prompt).toContain('do not claim success');
  });

  it('the prompt covers what a free Apple ID on a fresh Xcode trips over', () => {
    const prompt = buildIosInstallPrompt({ ...thisMac, devices: [iphone] });
    expect(prompt).toContain('-destination id=00008140-001 -allowProvisioningUpdates');
    expect(prompt).toContain('sudo xcodebuild -license accept');
    expect(prompt).toContain('sudo xcodebuild -runFirstLaunch');
    expect(prompt).toContain('Push Notifications');
    expect(prompt).toContain('expo-modules-jsi');
    expect(prompt).toContain('VPN & Device Management');
    expect(prompt).toContain('Developer Mode');
    expect(prompt).toContain('7 days');
    expect(prompt).not.toContain('xctrace'); // the UDID is already known
  });
});

describe('expiry', () => {
  const DAY = 86_400_000;
  const installedAt = Date.UTC(2026, 10, 4, 12); // noon, so any timezone reads the same day
  const record = {
    platform: 'ios' as const,
    deviceName: 'Sam’s iPhone',
    deviceId: 'u',
    installedAt,
    expiresAt: installedAt + 7 * DAY,
  };

  it('reminds once, in the last day', () => {
    expect(reminderDue(record, installedAt + 5 * DAY)).toBe(false);
    expect(reminderDue(record, installedAt + 6.5 * DAY)).toBe(true);
    expect(reminderDue({ ...record, remindedFor: record.expiresAt }, installedAt + 6.5 * DAY)).toBe(
      false
    );
    expect(reminderDue(record, installedAt + 8 * DAY)).toBe(false);
    expect(reminderDue({ ...record, expiresAt: undefined }, installedAt)).toBe(false);
  });

  it('says when, and tells a free team from a paid one', () => {
    expect(expiryLine(record.expiresAt, installedAt)).toBe('Works until Wed 11 Nov');
    expect(expiryLine(record.expiresAt, installedAt + 8 * DAY)).toBe(
      'Stopped opening on Wed 11 Nov'
    );
    expect(isFreeTeamExpiry(record)).toBe(true);
    expect(isFreeTeamExpiry({ installedAt, expiresAt: installedAt + 365 * DAY })).toBe(false);
  });

  describe('the record', () => {
    beforeEach(() => localStorage.clear());
    it('round-trips through local storage', () => {
      expect(readInstallRecord()).toBeNull();
      saveInstallRecord(record);
      expect(readInstallRecord()).toEqual(record);
    });
  });
});
