/**
 * Onboarding as one straight line: one screen, one question, one big
 * button. "Do this. Done. Next."
 *
 * 1. Welcome — what this is, in a line.
 * 2. Engine — Claude Code or Codex, then each install / sign-in as its own
 *    screen, ticked by the app's own checks; then, optionally, another
 *    account (Claude or Codex), so agents carry on when one runs out.
 * 3. Independence — how much agents do on their own.
 * 4. Your phone (skippable) — Tailscale on this Mac, Tailscale on the phone
 *    (same account), the phone app, then scan and Allow.
 * 5. Ready — bring your agents from another assistant, or start fresh. The
 *    import path is its own short line: Remote access on, the link in the
 *    assistant, then the one message.
 *
 * Everything here is pure: the order, Back, what a resumed launch opens on,
 * and what each check says when it passes or fails. A failed check always
 * says "Not done yet" with the one fix; a passed one says "Done". Never a
 * silent reload.
 *
 * The step is saved as it changes (per-viewer `localStorage`: losing it
 * costs a few clicks, and every step re-checks what's true anyway), so a
 * quit halfway through opens where it stopped.
 *
 * @module lib/onboardingFlow
 */

import type { TailscaleState, PhoneStatus, TailnetPhone } from './companion';
import { phoneTailscaleSignIn } from './companion';
import { connectionStep, TAILSCALE_DOWNLOAD_URL, type RemoteAccessStatus } from './remoteAccess';
import type { ImportTalk } from './agents';
import { SETUP_DEPENDENCIES, type SetupItem } from './setup';

// ============ Steps ============

export const FLOW_STEPS = [
  'welcome',
  'engine',
  'accounts',
  'independence',
  'phone',
  'tailscaleMac',
  'tailscalePhone',
  'phoneApp',
  'phonePair',
  'ready',
  'importRemote',
  'importConnect',
  'importStart',
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** The five parts the progress bar shows. */
export const FLOW_SECTIONS = ['welcome', 'engine', 'independence', 'phone', 'ready'] as const;
export type FlowSection = (typeof FLOW_SECTIONS)[number];

export const SECTION_LABEL: Record<FlowSection, string> = {
  welcome: 'Welcome',
  engine: 'Your AI',
  independence: 'How independent',
  phone: 'Your phone',
  ready: 'Ready',
};

const PHONE_STEPS: readonly FlowStep[] = [
  'tailscaleMac',
  'tailscalePhone',
  'phoneApp',
  'phonePair',
];
const IMPORT_STEPS: readonly FlowStep[] = ['importRemote', 'importConnect', 'importStart'];

export function sectionOf(step: FlowStep): FlowSection {
  // Another account is part of "Your AI".
  if (step === 'accounts') return 'engine';
  if (step === 'phone' || PHONE_STEPS.includes(step)) return 'phone';
  if (step === 'ready' || IMPORT_STEPS.includes(step)) return 'ready';
  return step as FlowSection;
}

/** "Step 4 of 5", and within a part with several screens, "2 of 4". */
export function progressOf(step: FlowStep): {
  section: number;
  sections: number;
  sub: { index: number; total: number } | null;
} {
  const section = FLOW_SECTIONS.indexOf(sectionOf(step)) + 1;
  const within = PHONE_STEPS.includes(step)
    ? PHONE_STEPS
    : IMPORT_STEPS.includes(step)
      ? IMPORT_STEPS
      : null;
  return {
    section,
    sections: FLOW_SECTIONS.length,
    sub: within ? { index: within.indexOf(step) + 1, total: within.length } : null,
  };
}

/** The screen after this one, in the straight line (the phone part included). */
export function nextStep(step: FlowStep): FlowStep | null {
  const i = FLOW_STEPS.indexOf(step);
  // "Ready" is the end of the line; importing is a branch off it.
  if (step === 'ready' || step === 'importStart') return null;
  if (step === 'phonePair') return 'ready';
  return FLOW_STEPS[i + 1] ?? null;
}

/** Back: the screen before, except that "Ready" goes back to the phone question. */
export function prevStep(step: FlowStep): FlowStep | null {
  if (step === 'welcome') return null;
  if (step === 'ready') return 'phone';
  if (step === 'importRemote') return 'ready';
  return FLOW_STEPS[FLOW_STEPS.indexOf(step) - 1] ?? null;
}

/** Skipping the phone part, from any of its screens. */
export const skipPhone = (): FlowStep => 'ready';

// ============ Persistence ============

export const FLOW_STORAGE_KEY = 'shipstudio.onboarding.flow';

export interface FlowProgress {
  v: 1;
  step: FlowStep;
  /** The whole line was walked to the end (Start fresh, or into the import). */
  finished: boolean;
}

export function readProgress(): FlowProgress | null {
  try {
    const raw = window.localStorage.getItem(FLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FlowProgress>;
    if (parsed.v !== 1 || !FLOW_STEPS.includes(parsed.step as FlowStep)) return null;
    return { v: 1, step: parsed.step as FlowStep, finished: parsed.finished === true };
  } catch {
    return null;
  }
}

export function saveProgress(step: FlowStep, finished = false): void {
  try {
    const value: FlowProgress = { v: 1, step, finished };
    window.localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: a relaunch starts at the top, and re-checks what's done.
  }
}

/**
 * Stopped partway through: opened onboarding, didn't reach the end. A launch
 * opens onboarding again rather than Agents. Never true for someone who
 * finished, or who set up before this flow existed (nothing saved).
 */
export function isOnboardingInProgress(p: FlowProgress | null = readProgress()): boolean {
  return p !== null && !p.finished && p.step !== 'welcome';
}

/**
 * Where a launch opens: the saved step, unless it is past the engine and the
 * engine is no longer ready (signed out since), which goes back to it.
 */
export function resumeStep(saved: FlowProgress | null, engineReady: boolean): FlowStep {
  if (!saved || saved.finished) return 'welcome';
  const pastEngine = FLOW_STEPS.indexOf(saved.step) > FLOW_STEPS.indexOf('engine');
  if (pastEngine && !engineReady) return 'engine';
  return saved.step;
}

// ============ Checks ============

/** What a check says: a passed one "Done", a failed one "Not done yet" and the fix. */
export type CheckResult =
  | { state: 'checking'; line: string }
  | { state: 'pass'; line: string }
  | {
      state: 'fail';
      line: string;
      /** The one thing to do, in a sentence. */
      fix: string;
      /** A page that does it, when there is one. */
      action?: { label: string; url: string };
    };

export const NOT_DONE = 'Not done yet';
export const DONE = 'Done';

/** "Get Tailscale on this Mac": installed, signed in, switched on. */
export function tailscaleMacCheck(t: TailscaleState | null): CheckResult {
  if (!t) return { state: 'checking', line: 'Checking this Mac…' };
  switch (t.state) {
    case 'connected':
      return {
        state: 'pass',
        line: t.login ? `Tailscale is on, signed in as ${t.login}.` : 'Tailscale is on.',
      };
    case 'notInstalled':
      return {
        state: 'fail',
        line: 'Tailscale isn’t installed on this Mac.',
        fix: 'Download it, open it, and sign in. This screen ticks by itself.',
        action: { label: 'Download Tailscale', url: TAILSCALE_DOWNLOAD_URL },
      };
    case 'needsLogin':
      return {
        state: 'fail',
        line: 'Tailscale is installed but not signed in, or switched off.',
        fix: 'Click the Tailscale icon in the menu bar, sign in, and switch it on.',
      };
    case 'unknown':
      return {
        state: 'fail',
        line: `Tailscale answered with something unexpected: ${t.detail}`,
        fix: 'Quit Tailscale from the menu bar, open it again, then check again.',
      };
  }
}

/**
 * "Get Tailscale on your phone, same account": a phone signed in as this
 * Mac's account shows up on the tailnet. Switched off isn't done.
 */
export function tailscalePhoneCheck(
  t: TailscaleState | null,
  phones: TailnetPhone[] | null
): CheckResult {
  if (t && t.state !== 'connected') {
    return {
      state: 'fail',
      line: 'Tailscale on this Mac is off, so it can’t see your phone.',
      fix: 'Go back one step and get Tailscale on this Mac first.',
    };
  }
  if (!t || phones === null) return { state: 'checking', line: 'Looking for your phone…' };
  const on = phones.find((p) => p.online);
  if (on) return { state: 'pass', line: `${on.name} is on your Tailscale.` };
  const off = phones[0];
  if (off) {
    return {
      state: 'fail',
      line: `${off.name} is signed in, but Tailscale is switched off on it.`,
      fix: 'Open Tailscale on your phone and turn the switch on.',
    };
  }
  return {
    state: 'fail',
    line: 'No phone is on your Tailscale yet.',
    fix: `On your phone, install Tailscale, ${phoneTailscaleSignIn(t)}, and turn the switch on.`,
  };
}

/** Where pairing the phone has got to, as one screen state. */
export type PairStage =
  | { kind: 'starting' }
  | { kind: 'fix'; check: Extract<CheckResult, { state: 'fail' }>; retry: boolean }
  | { kind: 'code' }
  | { kind: 'confirm' }
  | { kind: 'paired'; name: string };

/**
 * From the phone panel's status. `knownDevices`: the phones paired before
 * this screen opened, so only a new one counts as done.
 */
export function pairStage(s: PhoneStatus | null, knownDevices: readonly string[]): PairStage {
  if (!s) return { kind: 'starting' };
  const fresh = s.devices.find((d) => !knownDevices.includes(d.id));
  if (fresh) return { kind: 'paired', name: fresh.name };
  if (s.tailscale.state !== 'connected') {
    const mac = tailscaleMacCheck(s.tailscale);
    if (mac.state === 'fail') return { kind: 'fix', check: mac, retry: false };
  }
  if (!s.enabled) return { kind: 'starting' };
  switch (s.serve.state) {
    case 'needsApproval':
      return {
        kind: 'fix',
        retry: true,
        check: {
          state: 'fail',
          line: 'HTTPS certificates are off in your Tailscale account.',
          fix: 'Open the Tailscale admin page, click Enable HTTPS, then come back and check again.',
          action: { label: 'Open Tailscale admin', url: s.serve.url },
        },
      };
    case 'failed':
      return {
        kind: 'fix',
        retry: true,
        check: {
          state: 'fail',
          line: `Tailscale didn’t start phone access: ${s.serve.detail}`,
          fix: 'Check that Tailscale is on in the menu bar, then check again.',
        },
      };
    case 'off':
      if (s.tailscale.state === 'unknown') {
        return {
          kind: 'fix',
          retry: true,
          check: {
            state: 'fail',
            line: `Tailscale answered with something unexpected: ${s.tailscale.detail}`,
            fix: 'Quit Tailscale from the menu bar, open it again, then check again.',
          },
        };
      }
      return { kind: 'starting' };
    case 'on':
      return s.pairing.request ? { kind: 'confirm' } : { kind: 'code' };
  }
}

/** "Turn on Remote access": done when a request from the internet actually got here. */
export function remoteOnCheck(s: RemoteAccessStatus | null, now: number): CheckResult {
  if (!s) return { state: 'checking', line: 'Checking Remote access…' };
  const step = connectionStep(s, now);
  switch (step.kind) {
    case 'ready':
      return { state: 'pass', line: 'Remote access is on, and the internet can reach this Mac.' };
    case 'unsupported':
      return {
        state: 'fail',
        line: 'Remote access works only on a Mac.',
        fix: 'Start fresh instead: you can import later from ⌘K → Import agents.',
      };
    case 'installTailscale':
    case 'signInTailscale':
    case 'tailscaleProblem': {
      const mac = tailscaleMacCheck(s.tailscale);
      return mac.state === 'fail' ? mac : { state: 'checking', line: 'Checking Tailscale…' };
    }
    case 'off':
      return { state: 'checking', line: 'Turning on Remote access…' };
    case 'approveFunnel':
      return {
        state: 'fail',
        line: 'Funnel is off for this Mac in your Tailscale account.',
        fix: 'Open the Tailscale page, allow Funnel for this Mac, then come back and check again.',
        action: { label: 'Open Tailscale', url: step.url },
      };
    case 'funnelFailed':
      return {
        state: 'fail',
        line: `Tailscale couldn’t turn on the link: ${step.detail}`,
        fix: 'Check that Tailscale is on in the menu bar, then check again.',
      };
    case 'starting':
      return { state: 'checking', line: 'Asking Tailscale for a link…' };
    case 'publishing':
      return step.stage === 'stuck'
        ? {
            state: 'fail',
            line: `The link still isn’t reachable after ${step.minutes} minutes.`,
            fix: 'Check again to ask Tailscale to publish it once more.',
          }
        : {
            state: 'checking',
            line: 'Publishing the link. The first time this can take a few minutes.',
          };
    case 'unreachable':
      return {
        state: 'fail',
        line: `The link is set up, but requests don’t get through: ${step.detail}`,
        fix: 'Check again to ask Tailscale to publish it once more.',
      };
  }
}

/** "Add the link to your assistant": done once it has connected. */
export function assistantCheck(s: RemoteAccessStatus | null, copied: boolean): CheckResult {
  if (s?.everConnected) {
    const who = s.activity.lastClient;
    return { state: 'pass', line: who ? `${who} is connected.` : 'Your assistant is connected.' };
  }
  if (!copied) return { state: 'checking', line: 'Waiting for you to copy the link…' };
  return {
    state: 'fail',
    line: 'Your assistant hasn’t connected yet.',
    fix: 'In your assistant, add a custom connector, paste the link, and save it. Then ask it anything.',
  };
}

/** "Send it this message": done when the assistant has started talking to the Chief. */
export function importTalkCheck(
  talk: ImportTalk | null,
  armed: boolean,
  copied: boolean
): CheckResult {
  if (
    talk &&
    ['awaiting_consent', 'interviewing', 'playback', 'review', 'imported'].includes(talk.state)
  ) {
    return { state: 'pass', line: `${talk.source} is talking to your Chief of Staff.` };
  }
  if (!armed) return { state: 'checking', line: 'Getting the import ready…' };
  if (!copied) return { state: 'checking', line: 'Waiting for you to copy the message…' };
  return {
    state: 'fail',
    line: 'Your assistant hasn’t sent anything yet.',
    fix: 'Paste the message into a new chat with your assistant and send it.',
  };
}

// ============ The engine's own screens ============

/**
 * What has to be installed before `itemId`, deepest first, limited to items
 * the status reports and that aren't ready (Codex: the package manager,
 * then Node.js).
 */
export function missingPrerequisites(itemId: string, items: SetupItem[]): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    for (const dep of SETUP_DEPENDENCIES[id] ?? []) {
      visit(dep);
      const item = items.find((i) => i.id === dep);
      if (item && item.status !== 'ready' && !out.includes(dep)) out.push(dep);
    }
  };
  visit(itemId);
  return out;
}

/** The screens one engine takes on this Mac, in order: what it needs, install, sign in. */
export function engineScreens(binaryId: string, items: SetupItem[]): string[] {
  return [...missingPrerequisites(binaryId, items), binaryId, `${binaryId}_auth`];
}

/** What one install / sign-in screen says, by setup item. */
export function engineItemCopy(
  itemId: string,
  engine: { binaryId: string; name: string; account: string }
): { title: string; lede: string; action: string } {
  if (itemId === engine.binaryId) {
    return {
      title: `Install ${engine.name}`,
      lede: 'It installs in a window here. If it asks for your Mac password, type it and press Enter: nothing shows as you type.',
      action: `Install ${engine.name}`,
    };
  }
  if (itemId === `${engine.binaryId}_auth`) {
    return {
      title: `Sign in to ${engine.name}`,
      lede: `Your browser opens. Sign in with your ${engine.account} account, then come back here.`,
      action: 'Sign in',
    };
  }
  return {
    title: `Get your Mac ready for ${engine.name}`,
    lede: `${engine.name} needs a couple of things first. It takes a few minutes, and may ask for your Mac password.`,
    action: 'Get it ready',
  };
}

/** The check under an install / sign-in screen, from the app's own detection. */
export function engineItemCheck(
  item: { id: string; friendlyName: string; status: string; errorMessage?: string } | undefined,
  isAuth: boolean
): CheckResult | null {
  if (!item) return { state: 'checking', line: 'Checking this Mac…' };
  switch (item.status) {
    case 'ready':
      return {
        state: 'pass',
        line: isAuth ? 'You’re signed in.' : `${item.friendlyName} is installed.`,
      };
    case 'in_progress':
      return {
        state: 'checking',
        line: isAuth ? 'Waiting for you to finish signing in…' : 'Installing…',
      };
    case 'error':
      return {
        state: 'fail',
        line: item.errorMessage ?? 'It didn’t finish.',
        fix: 'Press Try again. If it fails twice, quit and reopen the app, then try once more.',
      };
    default:
      return null;
  }
}
