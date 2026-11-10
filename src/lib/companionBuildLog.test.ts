import { describe, expect, it } from 'vitest';
import { diagnoseBuildLog, failedBuildNote, loggedCommand } from './companionBuildLog';

/** The tail of real-shaped failures, as xcodebuild, devicectl and the toolchain print them. */
const LOGS: Array<[string, string]> = [
  [
    'signedOut',
    "error: No Account for Team \"TEAM000001\". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'Mogbot' from project 'Mogbot')",
  ],
  [
    'signedOut',
    "error: Your session has expired. Please log in. (in target 'Mogbot' from project 'Mogbot')",
  ],
  [
    'appLimit',
    'ERROR: The maximum number of apps for free development profiles has been reached. (com.apple.dt.CoreDeviceError error 3002)',
  ],
  [
    'appIdLimit',
    'error: Communication with Apple failed. Your maximum App ID limit has been reached. You may create up to 10 App IDs every 7 days.',
  ],
  [
    'developerMode',
    'error: Developer Mode disabled. To use Sam’s iPhone for development, enable Developer Mode in Settings → Privacy & Security.',
  ],
  [
    'locked',
    'ERROR: The device is locked. (com.apple.dt.CoreDeviceError error 1.0) Unlock the device and try again.',
  ],
  [
    'notConnected',
    'xcodebuild: error: Unable to find a destination matching the provided destination specifier:\n\t\t{ id:00008140-001A2B3C0E91801C }',
  ],
  [
    'license',
    "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.",
  ],
  [
    'xcodeTooOld',
    "ExpoModulesJSI/JavaScriptValue.swift:88:9: error: sending 'slot' risks causing data races",
  ],
  ['diskFull', 'clang: error: unable to write file: No space left on device'],
  [
    'noProfile',
    "error: No profiles for 'io.native.mogbot.companion.87be70' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'io.native.mogbot.companion.87be70'.",
  ],
];

describe('diagnoseBuildLog', () => {
  it.each(LOGS)('reads %s', (kind, line) => {
    const log = `› Compiling Mogbot » AppDelegate.swift\n${line}\n** BUILD FAILED **\n`;
    const d = diagnoseBuildLog(log);
    expect(d?.kind).toBe(kind);
    // One fix, in plain words: a sentence or two, no jargon from the log.
    expect(d?.fix.length).toBeLessThan(200);
    expect(d?.fix).not.toMatch(/CoreDevice|xcodebuild|provisioning profile/);
  });

  it('a failure we don’t know is left to the agent, not guessed at', () => {
    expect(diagnoseBuildLog('error: Something new went wrong\n** BUILD FAILED **')).toBeNull();
    expect(diagnoseBuildLog(null)).toBeNull();
    expect(diagnoseBuildLog('')).toBeNull();
  });

  it('only things on the phone, in Xcode or the App Store are the user’s', () => {
    expect(diagnoseBuildLog(LOGS[0][1])?.who).toBe('you');
    expect(diagnoseBuildLog(LOGS[7][1])?.who).toBe('agent');
  });
});

describe('loggedCommand', () => {
  it('tees the build into the log, quoted, keeping the exit code', () => {
    const cmd = loggedCommand(
      'cd x && build',
      '/Users/me/Library/Application Support/M/b/last.log'
    );
    expect(cmd).toBe(
      "mkdir -p '/Users/me/Library/Application Support/M/b' && set -o pipefail && { cd x && build ; } 2>&1 | tee '/Users/me/Library/Application Support/M/b/last.log'"
    );
  });

  it('the agent’s note is one line', () => {
    expect(failedBuildNote('/tmp/x.log')).not.toContain('\n');
  });
});
