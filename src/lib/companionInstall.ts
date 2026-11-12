/**
 * "Install on my phone": getting the companion app onto the
 * user's iPhone or Android phone.
 *
 * Two routes. The official build (TestFlight, or an APK) is a link, once the
 * maintainers publish one. Building it on this Mac follows the agent-led
 * onboarding pattern: Claude Code does the work in a terminal from a
 * prescriptive prompt, and the checklist is decided only by the app's own
 * checks (`commands/companion_install.rs`), never by the agent's say-so.
 *
 * Design: docs/mobile.md, "Installing the app".
 *
 * @module lib/companionInstall
 */

import { invoke } from '@tauri-apps/api/core';
import { agentPromptArgs, getActiveAgent } from './agent';
import { failedBuildNote, loggedCommand } from './companionBuildLog';
import type { TerminalCommand } from './setup';
import { BRAND, BRAND_LINKS } from './brand';
import { THIS_COMPUTER } from './computer';

export type InstallPlatform = 'ios' | 'android';

/**
 * The maintainers' public TestFlight link (`links.testFlight` in brand.json)
 * and the official APK. `null` until they exist; the panel says "not
 * available yet" rather than hiding the route.
 */
export const TESTFLIGHT_URL: string | null = BRAND_LINKS.testFlight ?? null;
export const ANDROID_APK_URL: string | null = null;

/** Xcode in the Mac App Store; App Store updates are something only the user can do. */
export const XCODE_APP_STORE_URL = 'https://apps.apple.com/app/xcode/id497799835';

// ---- Backend shapes (commands/companion_install.rs) --------------------------

export type XcodeCheck =
  | { state: 'missing' }
  | { state: 'cltOnly' }
  | { state: 'tooOld'; version: string }
  | { state: 'needsLicense'; version: string }
  | { state: 'needsFirstLaunch'; version: string }
  | { state: 'ok'; version: string };

export interface IosDevice {
  /** The id devicectl takes: the hardware UDID, or devicectl's CoreDevice id. */
  udid: string;
  /**
   * The hardware UDID (`00008140-…`), the one `xcodebuild -destination id=`
   * accepts; null when devicectl didn't report it.
   */
  hardwareUdid: string | null;
  name: string;
  model: string | null;
  osVersion: string | null;
  connected: boolean;
  paired: boolean;
  /** `enabled | disabled | unknown`, as devicectl says it. */
  developerMode: string;
}

export interface Signing {
  teamId: string;
  /** As Xcode lists it ("Sam Doe (Personal Team)"); null when it didn't say. */
  teamName: string | null;
  /**
   * The "Apple Development" certificate; null when an Apple ID is signed in
   * to Xcode but no certificate exists yet (the first build makes it).
   */
  identity: string | null;
  /** Xcode's word: a free Apple ID's personal team (7-day builds). Null: unknown. */
  free: boolean | null;
  bundleId: string;
}

export interface SourceCheck {
  path: string;
  present: boolean;
  installed: boolean;
  desktopVersion: string;
  /** Where Reinstall writes its build's output. */
  buildLog: string;
}

export interface IosInstallStatus {
  xcode: XcodeCheck;
  xcodeMinimum: string;
  clt: boolean;
  cocoapods: string | null;
  node: string | null;
  devices: IosDevice[];
  signing: Signing | null;
  source: SourceCheck;
}

export interface AndroidPhone {
  serial: string;
  state: string;
  model: string | null;
}

export interface AndroidInstallStatus {
  adb: string | null;
  sdk: boolean;
  jdk: boolean;
  node: string | null;
  devices: AndroidPhone[];
  package: string;
  source: SourceCheck;
}

export interface InstalledApp {
  /** null: the phone couldn't be asked (locked, Developer Mode off). */
  installed: boolean | null;
  version: string | null;
  expiresAt: number | null;
}

export const getIosInstallStatus = () => invoke<IosInstallStatus>('companion_install_ios_status');
export const getAndroidInstallStatus = () =>
  invoke<AndroidInstallStatus>('companion_install_android_status');
export const getIosApp = (udid: string, teamId: string) =>
  invoke<InstalledApp>('companion_install_ios_app', { udid, teamId });
export const getAndroidApp = (serial: string) =>
  invoke<InstalledApp>('companion_install_android_app', { serial });
export const launchIosApp = (udid: string, teamId: string) =>
  invoke<void>('companion_install_ios_launch', { udid, teamId });
const remind = (title: string, body: string) =>
  invoke<void>('companion_install_remind', { title, body });

// ---- The checklist -----------------------------------------------------------

/**
 * `done`: verified by our own check. `agent`: Claude Code does it.
 * `you`: only the user can (the App Store, a tap on the phone).
 * `waiting`: depends on an earlier row.
 */
export type StepState = 'done' | 'agent' | 'you' | 'waiting';

export interface InstallStep {
  id: string;
  title: string;
  detail: string;
  state: StepState;
  /** The one thing the user can click for this row: the App Store, for Xcode. */
  appStore?: string;
}

/** The phone the build targets: a connected one, a trusted one first. */
export function pickIosDevice(s: IosInstallStatus): IosDevice | null {
  const connected = s.devices.filter((d) => d.connected);
  return connected.find((d) => d.paired) ?? connected[0] ?? null;
}

export function pickAndroidPhone(s: AndroidInstallStatus): AndroidPhone | null {
  return s.devices.find((d) => d.state === 'device') ?? s.devices[0] ?? null;
}

/** Xcode is the one thing the agent can't fix: the App Store is the user's. */
export function xcodeBlocks(s: IosInstallStatus): boolean {
  return (
    s.xcode.state !== 'ok' &&
    s.xcode.state !== 'needsFirstLaunch' &&
    s.xcode.state !== 'needsLicense'
  );
}

function xcodeStep(s: IosInstallStatus): InstallStep {
  const title = `Xcode ${s.xcodeMinimum} or later`;
  switch (s.xcode.state) {
    case 'ok':
      return { id: 'xcode', title, detail: `Xcode ${s.xcode.version}`, state: 'done' };
    case 'needsLicense':
      return {
        id: 'xcode',
        title,
        detail: `Xcode ${s.xcode.version} needs its license accepted. The agent runs it; you type your Mac password.`,
        state: 'agent',
      };
    case 'needsFirstLaunch':
      return {
        id: 'xcode',
        title,
        detail: `Xcode ${s.xcode.version} needs its first-launch parts installed. The agent runs it; you type your Mac password.`,
        state: 'agent',
      };
    case 'tooOld':
      return {
        id: 'xcode',
        title,
        detail: `This Mac has Xcode ${s.xcode.version}. Update it in the App Store, then come back. The agent can’t do App Store updates.`,
        state: 'you',
        appStore: 'Update Xcode in the App Store',
      };
    case 'cltOnly':
    case 'missing':
      return {
        id: 'xcode',
        title,
        detail:
          s.xcode.state === 'cltOnly'
            ? 'Only the Command Line Tools are here, and they can’t build for a phone. Install Xcode from the App Store.'
            : 'Install Xcode from the App Store. It’s large, so it takes a while.',
        state: 'you',
        appStore: 'Get Xcode in the App Store',
      };
  }
}

export function iosSteps(s: IosInstallStatus, app: InstalledApp | null): InstallStep[] {
  const device = pickIosDevice(s);
  const toolsReady = s.clt && s.cocoapods !== null && s.node !== null;
  const missingTools = [
    !s.clt && 'Command Line Tools',
    s.cocoapods === null && 'CocoaPods',
    s.node === null && 'Node',
  ].filter(Boolean);

  // devicectl and Xcode's accounts come with Xcode: without it, neither can be asked.
  const noXcode = s.xcode.state === 'missing' || s.xcode.state === 'cltOnly';

  const phoneTitle = 'Your iPhone, plugged in';
  const phone: InstallStep = noXcode
    ? {
        id: 'phone',
        title: phoneTitle,
        detail: 'Checked once Xcode is installed.',
        state: 'waiting',
      }
    : device
      ? device.paired
        ? { id: 'phone', title: phoneTitle, detail: device.name, state: 'done' }
        : {
            id: 'phone',
            title: phoneTitle,
            detail: `Unlock ${device.name} and tap Trust when it asks about this Mac. No prompt? Unplug it and plug it back in.`,
            state: 'you',
          }
      : {
          id: 'phone',
          title: phoneTitle,
          detail: 'Connect it with a cable and unlock it. Tap Trust if it asks about this Mac.',
          state: 'you',
        };

  const devMode: InstallStep =
    device?.paired && device.developerMode === 'enabled'
      ? { id: 'devmode', title: 'Developer Mode on', detail: 'On', state: 'done' }
      : {
          id: 'devmode',
          title: 'Developer Mode on',
          detail: device?.paired
            ? 'On the phone: Settings → Privacy & Security → Developer Mode → On. It restarts; tap Turn On after. Not in the list? Keep it plugged in and open Xcode once; it appears.'
            : 'Turned on in the phone’s settings once it’s plugged in.',
          state: device?.paired ? 'you' : 'waiting',
        };

  const signingTitle = 'Signed in to Xcode with your Apple ID';
  const signing: InstallStep = s.signing
    ? {
        id: 'signing',
        title: signingTitle,
        detail: [
          s.signing.teamName ?? `Team ${s.signing.teamId}`,
          // Signed in, but nothing has signed yet: the first build makes the certificate.
          s.signing.identity === null && 'its certificate is made by the first build',
        ]
          .filter(Boolean)
          .join(' · '),
        state: 'done',
      }
    : {
        id: 'signing',
        title: signingTitle,
        detail: noXcode
          ? 'Once Xcode is installed: Xcode → Settings → Accounts → + → Apple ID. A free Apple ID works.'
          : 'Open Xcode → Settings → Accounts, click +, choose Apple ID and sign in. A free Apple ID works.',
        state: noXcode ? 'waiting' : 'you',
      };

  const installed = app?.installed === true;
  // Asked, but the phone wouldn't answer: with Developer Mode on, that's a locked phone.
  const unanswered = app !== null && app.installed === null && device?.developerMode === 'enabled';
  const build: InstallStep = installed
    ? {
        id: 'build',
        title: 'Built and installed',
        detail: device ? `On ${device.name}` : 'On your phone',
        state: 'done',
      }
    : unanswered && device
      ? {
          id: 'build',
          title: 'Built and installed',
          detail: `Unlock ${device.name} so this app can check whether it’s on there.`,
          state: 'you',
        }
      : {
          id: 'build',
          title: 'Built and installed',
          detail: 'A Release build, so it runs without this Mac’s bundler. Takes a few minutes.',
          state: xcodeBlocks(s) || !device ? 'waiting' : 'agent',
        };

  return [
    xcodeStep(s),
    {
      id: 'tools',
      title: 'CocoaPods and the Command Line Tools',
      detail: toolsReady
        ? `CocoaPods ${s.cocoapods ?? ''}`.trim()
        : `The agent installs ${missingTools.join(', ')}.`,
      state: toolsReady ? 'done' : 'agent',
    },
    phone,
    devMode,
    signing,
    build,
  ];
}

export function androidSteps(s: AndroidInstallStatus, app: InstalledApp | null): InstallStep[] {
  const phone = pickAndroidPhone(s);
  const phoneStep: InstallStep =
    phone?.state === 'device'
      ? {
          id: 'phone',
          title: 'Your phone, with USB debugging allowed',
          detail: phone.model ?? phone.serial,
          state: 'done',
        }
      : phone?.state === 'unauthorized'
        ? {
            id: 'phone',
            title: 'Your phone, with USB debugging allowed',
            detail: 'Tap Allow on the phone’s “Allow USB debugging?” prompt.',
            state: 'you',
          }
        : phone?.state === 'offline'
          ? {
              id: 'phone',
              title: 'Your phone, with USB debugging allowed',
              detail: 'The phone isn’t answering. Unplug it, plug it back in and unlock it.',
              state: 'you',
            }
          : {
              id: 'phone',
              title: 'Your phone, with USB debugging allowed',
              detail:
                s.adb === null
                  ? 'Once adb is installed, plug in your phone.'
                  : 'Settings → About phone → tap Build number 7 times. Then Developer options → USB debugging on, and plug it in.',
              state: s.adb === null ? 'waiting' : 'you',
            };
  const installed = app?.installed === true;
  return [
    {
      id: 'adb',
      title: 'Android platform tools (adb)',
      detail: s.adb ?? 'The agent installs them.',
      state: s.adb ? 'done' : 'agent',
    },
    {
      id: 'toolchain',
      title: 'Java 17 and the Android SDK',
      detail:
        s.jdk && s.sdk
          ? 'Found'
          : `The agent installs ${[!s.jdk && 'Java 17', !s.sdk && 'the Android SDK'].filter(Boolean).join(' and ')}.`,
      state: s.jdk && s.sdk ? 'done' : 'agent',
    },
    phoneStep,
    installed
      ? {
          id: 'build',
          title: 'Built and installed',
          detail: `On ${phone?.model ?? 'your phone'}`,
          state: 'done',
        }
      : {
          id: 'build',
          title: 'Built and installed',
          detail: 'A release APK, installed over the cable. Takes a few minutes.',
          state: phone?.state === 'device' ? 'agent' : 'waiting',
        },
  ];
}

// ---- The agent's instructions ------------------------------------------------

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The git repo the phone app is built from (`links.companionSource` in
 * brand.json) — this app's own, never the old app's, or the phone would get
 * the wrong companion. Null: release builds can't fetch the source, so
 * the install flow is hidden. Dev builds build from this checkout's mobile/.
 */
const REPO = BRAND_LINKS.companionSource;

/**
 * Whether "Build it on this Mac…" ("Install on my phone") is offered in
 * this build: in a dev build only. Someone who downloaded the app and was
 * sent a TestFlight link is never offered an Xcode build of the phone app,
 * even when brand.json names the source (`REPO`, which a dev build doesn't
 * need: it builds from this checkout's mobile/).
 */
export const COMPANION_INSTALL_ENABLED: boolean = import.meta.env.DEV;

/** Get the source to `path` (its parent is the checkout) if it isn't there. */
function sourceInstruction(src: SourceCheck): string {
  if (src.present) {
    return src.installed
      ? `The app's source is already at ${src.path}.`
      : `The app's source is at ${src.path}; install its dependencies there with \`pnpm install\` (if pnpm is missing, \`npm install -g pnpm\` first).`;
  }
  const root = src.path.replace(/\/mobile\/?$/, '');
  if (!REPO) {
    return `The app's source isn't at ${src.path}, and this build names no repository to fetch it from. Stop and tell the user the phone app can't be built from this build.`;
  }
  return (
    `First fetch the app's source, matching this desktop app's version: ` +
    `\`git clone --depth 1 --filter=blob:none --sparse --branch v${src.desktopVersion} ${REPO} ${sh(root)} && cd ${sh(root)} && git sparse-checkout set mobile packages/companion-protocol\`, ` +
    `then in ${src.path} run \`pnpm install\` (if pnpm is missing, \`npm install -g pnpm\` first).`
  );
}

/**
 * The Xcode workspace, scheme and .app name `expo prebuild` derives from the
 * app's name: Expo keeps only letters and digits (its `sanitizedName`).
 */
export function iosProjectName(name: string = BRAND.name): string {
  return (
    name
      .replace(/[\W_]+/g, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') || 'app'
  );
}

/**
 * The three commands of an iPhone build, run in the app's `mobile/` folder:
 * prebuild, build and sign, install. Not `expo run:ios`: it doesn't pass
 * `-allowProvisioningUpdates`, so a free Apple ID's build can't make its own
 * provisioning profile. The env goes on the build too, because the Release
 * build's bundling step reads app.config.ts again. A self-build's prebuild
 * leaves out the push entitlement, which a personal team can't sign
 * (`pushEntitlement` in mobile/app.config.ts).
 */
export function iosBuildSteps(
  env: string,
  teamId: string,
  udid: string
): { prebuild: string; build: string; install: string } {
  const name = iosProjectName();
  return {
    prebuild: `${env} npx expo prebuild -p ios --clean`,
    build:
      `cd ios && ${env} xcodebuild -workspace ${name}.xcworkspace -scheme ${name} -configuration Release ` +
      `-destination id=${udid} -allowProvisioningUpdates -derivedDataPath build ` +
      `DEVELOPMENT_TEAM=${teamId} CODE_SIGN_STYLE=Automatic build`,
    install: `xcrun devicectl device install app --device ${udid} build/Build/Products/Release-iphoneos/${name}.app`,
  };
}

const iosEnv = (signing: Signing) =>
  `COMPANION_BUNDLE_ID=${signing.bundleId} APPLE_TEAM_ID=${signing.teamId}`;

/**
 * The one command that builds and installs: also what Reinstall runs. Null
 * without a team, or without the phone's hardware UDID (xcodebuild refuses
 * devicectl's CoreDevice identifier).
 */
export function iosBuildCommand(s: IosInstallStatus, device: IosDevice): string | null {
  if (!s.signing || !device.hardwareUdid) return null;
  const steps = iosBuildSteps(iosEnv(s.signing), s.signing.teamId, device.hardwareUdid);
  return `cd ${sh(s.source.path)} && ${steps.prebuild} && ${steps.build} && ${steps.install}`;
}

export function androidBuildCommand(s: AndroidInstallStatus, phone: AndroidPhone): string {
  const env = `COMPANION_BUNDLE_ID=${s.package}`;
  return (
    `cd ${sh(s.source.path)} && ${env} npx expo prebuild -p android --clean && ` +
    `${env} npx expo run:android --variant release --device ${phone.serial}`
  );
}

/**
 * The agent's opening message for an iPhone build. One line: a multi-line
 * argv doesn't survive every PTY spawn shape. Prescriptive: the exact
 * commands, what to ask the user to do by hand, and that the checklist, not
 * the agent, decides when it's done.
 */
export function buildIosInstallPrompt(s: IosInstallStatus): string {
  const device = pickIosDevice(s);
  const env = s.signing
    ? iosEnv(s.signing)
    : `COMPANION_BUNDLE_ID=${BRAND.companion.bundleId}.<first 6 hex characters of the sha256 of the team id> APPLE_TEAM_ID=<team id>`;
  const team = s.signing?.teamId ?? '<team id>';
  const target = device?.hardwareUdid ?? '<UDID>';
  const findUdid = device?.hardwareUdid
    ? ''
    : 'For <UDID>, use the iPhone’s hardware UDID: the id in brackets after its name and iOS version under "== Devices ==" in `xcrun xctrace list devices` (it looks like 00008140-001600843E60801C). Not the identifier `xcrun devicectl list devices` prints (a plain UUID): xcodebuild refuses that one. ';
  const steps = iosBuildSteps(env, team, target);
  return (
    `You are installing the ${BRAND.name} companion app on the user’s iPhone, built from source on this Mac. ` +
    'Be brief and plain: before each step, say in one sentence what you are about to do. ' +
    `${BRAND.name} shows a checklist beside this terminal and verifies every item with its own checks, so do not claim success; tell the user to look at the checklist. ` +
    `Check first: \`xcodebuild -version\` (needs ${s.xcodeMinimum} or later; if it is older, stop and tell the user to update Xcode in the App Store, which you cannot do), ` +
    '`xcodebuild -license check` (if it fails, run `sudo xcodebuild -license accept`), `xcodebuild -checkFirstLaunchStatus` (if it fails, run `sudo xcodebuild -runFirstLaunch`); both are needed again after every Xcode update, and until then git and every build fail. For either sudo, warn that macOS asks for their password and shows nothing while they type. ' +
    'Also `pod --version` (if missing, `brew install cocoapods`) and `node --version`. ' +
    'Things only the user can do, so ask them and wait: plug the iPhone in with a cable, unlock it and tap Trust; turn on Developer Mode (Settings → Privacy & Security → Developer Mode, the phone restarts, then tap Turn On); add their Apple ID in Xcode → Settings → Accounts if `security find-identity -v -p codesigning` lists no "Apple Development" identity (a free Apple ID works). ' +
    sourceInstruction(s.source) +
    ' ' +
    findUdid +
    `Then build and install a Release build (it bundles the JavaScript, so it runs without a bundler), in ${s.source.path}: \`${steps.prebuild}\`, then \`${steps.build}\`, then \`${steps.install}\` (from the same ios folder). Use exactly that bundle id: ${BRAND.name} checks the phone for it. ` +
    'Do not use `npx expo run:ios`: it does not pass -allowProvisioningUpdates, so a free Apple ID’s build cannot make its provisioning profile. ' +
    'The prebuild leaves out the Push Notifications entitlement on its own, because a free Apple ID’s personal team cannot sign it and the app works without it; do not add it back, and do not set COMPANION_PUSH_ENTITLEMENT. If signing still says "Personal development teams … do not support the Push Notifications capability", the ios folder is stale: run the prebuild again (it has --clean). ' +
    'If the build fails in expo-modules-jsi with a Swift error like "sending \'slot\' risks causing data races", this Xcode is too old for the app’s Expo SDK: stop and tell the user to update Xcode in the App Store. ' +
    'If signing fails any other way, read the error and explain it plainly. ' +
    `When it is installed, tell the user: the first launch says "Untrusted Developer" until they trust the certificate on the phone in Settings → General → VPN & Device Management → their Apple ID under Developer App → Trust; with a free Apple ID the app stops opening after 7 days and ${BRAND.name} has a one-click Reinstall. ` +
    'Do not change any of the app’s source code and do not set up anything unrelated.'
  );
}

export function buildAndroidInstallPrompt(s: AndroidInstallStatus): string {
  const phone = pickAndroidPhone(s);
  const target = phone ? phone.serial : '<the serial from `adb devices`>';
  return (
    `You are installing the ${BRAND.name} companion app on the user’s Android phone, built from source on ${THIS_COMPUTER}. ` +
    'Be brief and plain: before each step, say in one sentence what you are about to do. ' +
    `${BRAND.name} shows a checklist beside this terminal and verifies every item with its own checks, so do not claim success; tell the user to look at the checklist. ` +
    'Check first: `adb version` (if missing, `brew install --cask android-platform-tools`), Java 17 (`/usr/libexec/java_home -v 17`; if missing, `brew install --cask zulu@17`), and the Android SDK at $ANDROID_HOME or ~/Library/Android/sdk (if missing, `brew install --cask android-commandlinetools`, then `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`). Export JAVA_HOME and ANDROID_HOME for the build. ' +
    'Things only the user can do, so ask them and wait: on the phone, Settings → About phone → tap Build number 7 times, then Settings → Developer options → USB debugging on; plug it in and tap Allow on "Allow USB debugging?". `adb devices` must show it as `device`, not `unauthorized`. ' +
    sourceInstruction(s.source) +
    ' ' +
    `Then build and install a release APK: in ${s.source.path} run \`COMPANION_BUNDLE_ID=${s.package} npx expo prebuild -p android --clean\`, then \`COMPANION_BUNDLE_ID=${s.package} npx expo run:android --variant release --device ${target}\`. If that build can’t install, \`adb -s ${target} install -r\` the APK it produced under android/app/build/outputs/apk/release/. Use exactly that package name: ${BRAND.name} checks the phone for it. ` +
    'When it is installed, tell the user it does not expire. ' +
    'Do not change any of the app’s source code and do not set up anything unrelated.'
  );
}

/** The agent that does the install: the user's own engine, Claude Code or Codex. */
export interface InstallAgent {
  /** The CLI binary, also its id for `agentPromptArgs`. */
  binary: 'claude' | 'codex';
  name: string;
}

/**
 * Codex when that's the engine the user chose (onboarding makes it the
 * default agent), else Claude Code. A Codex-only Mac has no `claude`, and a
 * "Start Claude Code" there opened a terminal that failed at once.
 */
export function installAgent(defaultAgentId: string = getActiveAgent().id): InstallAgent {
  return defaultAgentId === 'codex'
    ? { binary: 'codex', name: 'Codex' }
    : { binary: 'claude', name: 'Claude Code' };
}

export function agentInstallSpawn(agent: InstallAgent, prompt: string): TerminalCommand {
  return { command: agent.binary, args: agentPromptArgs(agent.binary, prompt) };
}

/** Reinstall: the build step alone, in a login shell, with no agent. */
export function shellSpawn(command: string): TerminalCommand {
  return { command: '/bin/zsh', args: ['-ilc', command] };
}

// ---- What was installed, and when it stops working --------------------------

export interface InstallRecord {
  platform: InstallPlatform;
  deviceName: string;
  /** iOS UDID or adb serial. */
  deviceId: string;
  teamId?: string;
  installedAt: number;
  /** iOS only: when the profile stops the app opening. */
  expiresAt?: number;
  /** The expiry the reminder already fired for. */
  remindedFor?: number;
}

const RECORD_KEY = 'shipstudio.companionInstall';
const DAY = 24 * 60 * 60 * 1000;
/** A free Apple ID's profile lasts 7 days; a paid one's, a year. */
export const FREE_TEAM_DAYS = 7;

export function readInstallRecord(): InstallRecord | null {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    return raw ? (JSON.parse(raw) as InstallRecord) : null;
  } catch {
    return null;
  }
}

export function saveInstallRecord(record: InstallRecord) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(record));
  } catch {
    // Storage off: the panel still works; only the reminder is lost.
  }
}

/** Within the last day before expiry, and not reminded for this expiry yet. */
export function reminderDue(r: InstallRecord | null, now: number): boolean {
  if (!r?.expiresAt || r.remindedFor === r.expiresAt) return false;
  return now >= r.expiresAt - DAY && now < r.expiresAt;
}

/** Fire the reminder once if it's due. */
export async function remindIfDue(now = Date.now()) {
  const r = readInstallRecord();
  if (!r || !reminderDue(r, now)) return;
  await remind(
    `${BRAND.name} stops opening on your phone tomorrow`,
    `The build on ${r.deviceName} was signed with a free Apple ID. Plug it in and click Reinstall in ${BRAND.name} → Phone.`
  );
  saveInstallRecord({ ...r, remindedFor: r.expiresAt });
}

/** "Tue 11 Nov". */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** "Works until Tue 11 Nov", or that it has stopped. */
export function expiryLine(expiresAt: number, now: number): string {
  return expiresAt > now
    ? `Works until ${formatDay(expiresAt)}`
    : `Stopped opening on ${formatDay(expiresAt)}`;
}

/** A profile under 8 days long came from a free Apple ID. */
export function isFreeTeamExpiry(r: Pick<InstallRecord, 'installedAt' | 'expiresAt'>): boolean {
  return r.expiresAt !== undefined && r.expiresAt - r.installedAt < (FREE_TEAM_DAYS + 1) * DAY;
}

/**
 * Cmd+K "Install on my phone" opens the Phone panel straight
 * onto the install flow. The panel takes the request once, when it opens.
 */
let installOnOpen = false;

export function requestInstallOnOpen() {
  installOnOpen = true;
}

export function takeInstallOnOpen(): boolean {
  const wanted = installOnOpen;
  installOnOpen = false;
  return wanted;
}

// ---- One read of everything the checklist needs -------------------------------

export type InstallState =
  | { platform: 'ios'; status: IosInstallStatus; app: InstalledApp | null }
  | { platform: 'android'; status: AndroidInstallStatus; app: InstalledApp | null };

/** The checks, then — when there's a phone to ask — whether the app is on it. */
export async function loadInstallState(platform: InstallPlatform): Promise<InstallState> {
  if (platform === 'ios') {
    const status = await getIosInstallStatus();
    const device = pickIosDevice(status);
    const app =
      device?.paired && status.signing ? await getIosApp(device.udid, status.signing.teamId) : null;
    return { platform, status, app };
  }
  const status = await getAndroidInstallStatus();
  const phone = pickAndroidPhone(status);
  const app = phone?.state === 'device' ? await getAndroidApp(phone.serial) : null;
  return { platform, status, app };
}

export function installSteps(s: InstallState): InstallStep[] {
  return s.platform === 'ios' ? iosSteps(s.status, s.app) : androidSteps(s.status, s.app);
}

/** The phone the build targets, by name and id, for the record and the copy. */
export function installTarget(s: InstallState): { name: string; id: string } | null {
  if (s.platform === 'ios') {
    const d = pickIosDevice(s.status);
    return d ? { name: d.name, id: d.udid } : null;
  }
  const p = pickAndroidPhone(s.status);
  return p?.state === 'device' ? { name: p.model ?? p.serial, id: p.serial } : null;
}

/** Reinstall's command, when there's a phone and (on iOS) a team to build for. */
export function reinstallCommand(s: InstallState): string | null {
  const command = (() => {
    if (s.platform === 'ios') {
      const d = pickIosDevice(s.status);
      return d?.paired ? iosBuildCommand(s.status, d) : null;
    }
    const p = pickAndroidPhone(s.status);
    return p?.state === 'device' ? androidBuildCommand(s.status, p) : null;
  })();
  // Also into the log, so a failure can be read back and named.
  return command && loggedCommand(command, s.status.source.buildLog);
}

/** The agent's prompt; after a failed Reinstall, it starts from that build's log. */
export function installPrompt(s: InstallState, afterFailedBuild = false): string {
  const prompt =
    s.platform === 'ios' ? buildIosInstallPrompt(s.status) : buildAndroidInstallPrompt(s.status);
  return afterFailedBuild ? prompt + failedBuildNote(s.status.source.buildLog) : prompt;
}

/** Only an outdated or missing Xcode stops the agent starting. */
export function agentBlocked(s: InstallState): boolean {
  return s.platform === 'ios' && xcodeBlocks(s.status);
}
