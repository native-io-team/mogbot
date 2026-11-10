/**
 * Onboarding as one straight line: one screen, one question, one big
 * button. "Do this. Done. Next."
 *
 * 1. Welcome — what this is, in a line.
 * 2. Engine — Claude Code, Codex or OpenCode, then each install / sign-in
 *    as its own screen, ticked by the app's own checks. Required.
 * 3. Your agents — "Bring your agents from another assistant?" Yes walks
 *    Remote Access a screen per step (Tailscale on this Mac, the private
 *    link, connect the assistant), then starts the import, whose interview
 *    carries on in the Chief's chat. Not now goes on.
 * 4. Your phone — "Use your agents from your phone?" Yes walks it a screen
 *    per step (the app, Tailscale on this Mac, Tailscale on the phone with
 *    the same account, phone access, the code, Allow, Paired), in the same
 *    words the phone uses (`companion-protocol/src/pairWords.ts`).
 * 5. The Chief of Staff's chat, on its greeting and starters.
 *
 * Only the engine is required. Every screen of an optional part has "Skip
 * for now", and a skipped part comes back later as one card:
 *
 * - Bringing agents: the card under the Chief's greeting
 *   (`ImportChoiceCard`), while the Mac's answer is still undecided.
 * - Your phone: the card in the Chief's chat once the first thing asked for
 *   has come back (`ChiefPhoneOffer`), and "Pair your phone" at the
 *   sidebar's foot.
 * - Another account: on the usage-limit line the moment one runs out, and
 *   at the account row at the foot of Agents.
 * - How independent agents are: the default asks before anything risky;
 *   the Chief offers a change when the user sounds fed up
 *   (`agents/level_hint.rs`), and Settings → Agents has the slider.
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

import { SETUP_DEPENDENCIES, type SetupItem } from './setup';
import { describeFailure, type InstallFailure } from './installProgress';

// ============ Steps ============

/**
 * Every screen, in order. Three parts, as the owner put it: this Mac and
 * one engine (required); your agents from another assistant over Remote
 * Access (optional); your phone (optional). Each optional part opens on one
 * yes/no question, and every screen in it has "Skip for now", which goes on
 * to the next part; skipped parts come back later as one card in the
 * Chief's chat (`ImportChoiceCard`, `ChiefPhoneOffer`).
 */
export const FLOW_STEPS = [
  'welcome',
  'engine',
  // Your agents, from another assistant (Remote Access, then the interview).
  'agentsAsk',
  'agentsTailscale',
  'agentsLink',
  'agentsConnect',
  'agentsStart',
  // Your phone.
  'phoneAsk',
  'phoneGetApp',
  'phoneMacTailscale',
  'phonePhoneTailscale',
  'phoneAccess',
  'phoneScan',
  'phoneAllow',
  'phonePaired',
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/**
 * The parts the progress bar shows, then where they lead. The last is never
 * a screen here; it is the Chief's chat, and the bar shows it so the last
 * screen reads as the last thing in the way.
 */
export const FLOW_SECTIONS = ['welcome', 'engine', 'agents', 'phone', 'chief'] as const;
export type FlowSection = (typeof FLOW_SECTIONS)[number];

export const SECTION_LABEL: Record<FlowSection, string> = {
  welcome: 'Welcome',
  engine: 'Your AI',
  agents: 'Your agents',
  phone: 'Your phone',
  chief: 'Your Chief of Staff',
};

export function sectionOf(step: FlowStep): FlowSection {
  if (step === 'welcome' || step === 'engine') return step;
  return step.startsWith('agents') ? 'agents' : 'phone';
}

/** The screens of one part, in order. */
export function stepsOf(section: FlowSection): FlowStep[] {
  return FLOW_STEPS.filter((s) => sectionOf(s) === section);
}

/**
 * "Step 2 of 5", and how far through its part this screen is (0 on a
 * part's first screen, approaching 1 on its last), so the bar moves on
 * every screen, not only between parts.
 */
export function progressOf(step: FlowStep): {
  section: number;
  sections: number;
  within: number;
} {
  const part = stepsOf(sectionOf(step));
  return {
    section: FLOW_SECTIONS.indexOf(sectionOf(step)) + 1,
    sections: FLOW_SECTIONS.length,
    within: part.length > 1 ? part.indexOf(step) / part.length : 0,
  };
}

/** The screen after this one; null after the last, which is the Chief's chat. */
export function nextStep(step: FlowStep): FlowStep | null {
  return FLOW_STEPS[FLOW_STEPS.indexOf(step) + 1] ?? null;
}

/**
 * "Skip for now" and "Not now": past the rest of this part, to the next
 * part's first screen; null at the end (the Chief's chat).
 */
export function skipPart(step: FlowStep): FlowStep | null {
  const section = sectionOf(step);
  return (
    FLOW_STEPS.find((s, i) => i > FLOW_STEPS.indexOf(step) && sectionOf(s) !== section) ?? null
  );
}

/**
 * Back: the screen before. The phone's answer screens (Allow, Paired) go
 * back to the code, and the first screen of an optional part goes back to
 * the previous part's question rather than into its middle.
 */
export function prevStep(step: FlowStep): FlowStep | null {
  if (step === 'phoneAllow' || step === 'phonePaired') return 'phoneScan';
  if (step === 'phoneAsk') return 'agentsAsk';
  if (step === 'agentsAsk') return 'engine';
  return FLOW_STEPS[FLOW_STEPS.indexOf(step) - 1] ?? null;
}

// ============ Persistence ============

export const FLOW_STORAGE_KEY = 'shipstudio.onboarding.flow';

export interface FlowProgress {
  v: 1;
  step: FlowStep;
  /** The whole line was walked to the end (the engine is set up, into the Chief's chat). */
  finished: boolean;
}

/**
 * Screens an older build saved that are no longer in the line. Each came
 * after the engine was set up, which is all onboarding asks now, so a
 * launch saved on one counts as finished: it opens on Agents, not on the
 * welcome. (Signed out since? Agents shows its own "no engine" panel.)
 */
const RETIRED_STEPS = new Set([
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
]);

const isFlowStep = (s: string): s is FlowStep => (FLOW_STEPS as readonly string[]).includes(s);

export function readProgress(): FlowProgress | null {
  try {
    const raw = window.localStorage.getItem(FLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; step?: unknown; finished?: unknown };
    const step = parsed.step;
    if (parsed.v !== 1 || typeof step !== 'string') return null;
    if (RETIRED_STEPS.has(step)) return { v: 1, step: 'engine', finished: true };
    if (!isFlowStep(step)) return null;
    return { v: 1, step, finished: parsed.finished === true };
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
 * Where a launch opens: the saved step (the engine screen re-checks what is
 * installed and signed in on arrival), or the welcome when nothing unfinished
 * is saved.
 */
export function resumeStep(saved: FlowProgress | null): FlowStep {
  if (!saved || saved.finished) return 'welcome';
  // A phone's request and its answer last minutes; a relaunch makes a new code.
  if (saved.step === 'phoneAllow' || saved.step === 'phonePaired') return 'phoneScan';
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
      /**
       * The one thing to do, in a sentence. Left out when the screen's own
       * button is the whole answer: "Press Try again" under a Try again
       * button is a line that says nothing.
       */
      fix?: string;
      /** A page that does it, when there is one. */
      action?: { label: string; url: string };
    };

export const NOT_DONE = 'Not done yet';
export const DONE = 'Done';

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
      lede: 'It downloads and installs on this Mac, usually in a minute or two.',
      action: `Install ${engine.name}`,
    };
  }
  if (itemId === 'opencode_auth') {
    return {
      title: 'Connect OpenCode to a provider',
      lede: 'Pick a provider and sign in to it. This screen notices when you’re done.',
      action: 'Connect',
    };
  }
  if (itemId === `${engine.binaryId}_auth`) {
    return {
      title: `Sign in to ${engine.name}`,
      lede: `Sign-in opens in your browser. Use your ${engine.account} account; this screen notices when you’re done.`,
      action: 'Sign in',
    };
  }
  return {
    title: `Get your Mac ready for ${engine.name}`,
    // Named, because a password box for a tool nobody mentioned is the scary moment.
    lede: `${engine.name} runs on two free tools, Homebrew and Node.js. The app installs them for you in a few minutes, and may ask for your Mac password.`,
    action: 'Get it ready',
  };
}

/** The check under an install / sign-in screen, from the app's own detection. */
export function engineItemCheck(
  item: { id: string; friendlyName: string; status: string; errorMessage?: string } | undefined,
  isAuth: boolean,
  /**
   * Its window was closed before it finished (Cancel, or the browser's
   * sign-in abandoned). Without this the screen fell silent: the same
   * button and no word on what happened.
   */
  stopped = false,
  /**
   * What the app made of the run that failed, from everything it printed.
   * Without it (a status that came back failed), the error is read alone.
   */
  failure?: InstallFailure
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
    case 'error': {
      // The one cause and the one fix: offline says check the Mac is
      // online, a full disk says free some space; "quit and reopen" only
      // when nothing more specific is known.
      const { line, fix } =
        failure ?? describeFailure(item.id, item.errorMessage ?? 'It didn’t finish.');
      return { state: 'fail', line, fix };
    }
    default:
      return stopped
        ? {
            state: 'fail',
            line: isAuth
              ? 'Sign-in was closed before it finished.'
              : 'The install was closed before it finished.',
            fix: isAuth
              ? 'Already signed in in the browser? This screen notices in a moment.'
              : undefined,
          }
        : null;
  }
}
