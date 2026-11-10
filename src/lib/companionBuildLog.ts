/**
 * Reading a failed phone build: the end of Reinstall's log, turned into the
 * one fix in plain words.
 *
 * Reinstall runs the build itself (no agent), so when it fails nobody has
 * read the error yet. These are the failures a self-build actually meets,
 * each matched on the words Xcode, devicectl or the toolchain print. Anything
 * else is handed to the agent with the log's path. Nothing here guesses: no
 * match, no diagnosis.
 *
 * Design: docs/mobile.md, "Installing the app".
 *
 * @module lib/companionBuildLog
 */

import { invoke } from '@tauri-apps/api/core';

/** The end of the last Reinstall's output; null when there's no log. */
export const getBuildLog = () => invoke<string | null>('companion_install_build_log');

export type BuildFailure =
  | 'signedOut'
  | 'appLimit'
  | 'appIdLimit'
  | 'developerMode'
  | 'locked'
  | 'notConnected'
  | 'license'
  | 'xcodeTooOld'
  | 'diskFull'
  | 'noProfile';

export interface BuildDiagnosis {
  kind: BuildFailure;
  /** What went wrong and the one fix, in a sentence or two. */
  fix: string;
  /**
   * Who acts: `you` (on the phone, in Xcode, in the App Store) or `agent`
   * (a command the agent can run). Decides the button beside it.
   */
  who: 'you' | 'agent';
}

const RULES: Array<{ kind: BuildFailure; who: 'you' | 'agent'; match: RegExp; fix: string }> = [
  {
    kind: 'xcodeTooOld',
    who: 'you',
    match: /sending '?slot'? risks causing data races/i,
    fix: 'This Xcode is too old for the app. Update Xcode in the App Store, then Reinstall.',
  },
  {
    kind: 'license',
    who: 'agent',
    match: /agreed to the Xcode (and Apple SDKs )?license|xcodebuild -license/i,
    fix: 'Xcode’s license needs accepting again, which happens after every Xcode update. The agent can run it; you type your Mac password.',
  },
  {
    kind: 'signedOut',
    who: 'you',
    match:
      /No Account for Team|session has expired|Unable to log in with account|No accounts with App Store Connect access|account .* (has expired|is not valid)/i,
    fix: 'Xcode’s sign-in to your Apple ID has lapsed. Open Xcode → Settings → Accounts, select your Apple ID and sign in again, then Reinstall.',
  },
  {
    kind: 'appLimit',
    who: 'you',
    match: /maximum number of apps for free development profiles/i,
    fix: 'A free Apple ID can only have 3 apps you built yourself on a phone at once. Delete one of those from the phone, then Reinstall.',
  },
  {
    kind: 'appIdLimit',
    who: 'you',
    match: /maximum App ID limit|Your maximum App ID limit has been reached/i,
    fix: 'A free Apple ID can only register 10 app ids a week, and that’s used up. It frees up within 7 days; Reinstall then.',
  },
  {
    kind: 'developerMode',
    who: 'you',
    match: /Developer ?Mode (is )?(disabled|not enabled|off)|enable Developer Mode/i,
    fix: 'Developer Mode is off on the phone. Settings → Privacy & Security → Developer Mode → On; it restarts, tap Turn On, then Reinstall.',
  },
  {
    kind: 'locked',
    who: 'you',
    match:
      /device (is )?locked|passcode protected|Unlock .* to continue|kAMDMobileImageMounterDeviceLocked/i,
    fix: 'The phone was locked. Unlock it and keep it unlocked while it installs, then Reinstall.',
  },
  {
    kind: 'notConnected',
    who: 'you',
    match:
      /Unable to find a destination matching|device (was )?not found|No device(s)? (were )?found|device is not connected|Failed to find device/i,
    fix: 'The build couldn’t reach the phone. Plug it in with a cable, unlock it, then Reinstall.',
  },
  {
    kind: 'diskFull',
    who: 'you',
    match: /No space left on device/i,
    fix: 'This Mac ran out of disk space during the build. Free up some space, then Reinstall.',
  },
  {
    kind: 'noProfile',
    who: 'agent',
    match:
      /No profiles for '[^']+' were found|requires a provisioning profile|No signing certificate|Signing for "[^"]+" requires a development team/i,
    fix: 'Xcode couldn’t make a signing profile for the app. Check you’re signed in under Xcode → Settings → Accounts; the agent can read the rest of the error and fix it.',
  },
];

/** The failure the log ends on, if it's one we know; else null. */
export function diagnoseBuildLog(log: string | null): BuildDiagnosis | null {
  if (!log) return null;
  for (const rule of RULES) {
    if (rule.match.test(log)) return { kind: rule.kind, who: rule.who, fix: rule.fix };
  }
  return null;
}

/**
 * Reinstall's command, writing its output to the log as well as the
 * terminal: `pipefail` keeps the build's exit code through `tee`.
 */
export function loggedCommand(command: string, logPath: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const dir = logPath.replace(/\/[^/]*$/, '') || '/';
  return `mkdir -p ${q(dir)} && set -o pipefail && { ${command} ; } 2>&1 | tee ${q(logPath)}`;
}

/** What the agent is told when it's handed a build that failed. */
export function failedBuildNote(logPath: string): string {
  return ` The last build failed. Its full output is in ${logPath}: read the end of it first, explain the cause in one plain sentence, fix it, then build again.`;
}
