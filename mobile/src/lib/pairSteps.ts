/**
 * Pairing on the phone, one screen at a time: one question, one big button,
 * Back, and a bar that says how far along it is. The order is the one the
 * desk walks from its side (`companion-protocol/src/pairWords.ts` holds the
 * words both sides say):
 *
 * 1. Start at your computer: the Mac is set up first (not yet: where to get it).
 * 2. Turn on Tailscale on this phone, signed in as your Mac is.
 * 3. On your Mac, click "Pair your phone": Scan the code.
 * 4. The camera.
 * 5. Pair with <Mac>? (Pair.)
 * 6. Click Allow on your Mac (waits, ticks by itself).
 *
 * "Same Tailscale account on both" was its own screen, with a "Same
 * account" button nobody could answer honestly before pairing (the Mac only
 * says which account at the confirm). It is one clause of step 2 now, and a
 * phone saved on it resumes at step 3.
 *
 * A build with a relay (brand.json `links.relay`, docs/relay.md) reaches the
 * Mac without Tailscale, so step 2 is passed over: mac → code, the bar one
 * shorter, and a phone saved on the Tailscale screen resumes at the code.
 * Without one (a fork) the Tailscale screen stays, as before.
 *
 * The first three are saved as they change, so leaving the app halfway (to
 * install Tailscale, say) opens on the same screen. Pure, for the tests;
 * the screen is `app/pair.tsx`.
 *
 * @module lib/pairSteps
 */

import { RELAY_URL } from '@shipstudio/companion-protocol';
import { readJson, writeJson } from './persist';

/** This build reaches the Mac through a relay, so pairing needs no Tailscale on the phone. */
export const HAS_RELAY = RELAY_URL != null;

/** The screens before the camera, in order. `getMac` is the "Not yet" answer to `mac`. */
export const INTRO_STEPS = ['mac', 'tailscale', 'code'] as const;
export type IntroStep = (typeof INTRO_STEPS)[number] | 'getMac';

/** The intro this build walks: without the Tailscale screen when it has a relay. */
export const introSteps = (relay = HAS_RELAY): readonly IntroStep[] =>
  relay ? INTRO_STEPS.filter((s) => s !== 'tailscale') : INTRO_STEPS;

/** Every place the bar counts, the intro's three then the camera and the two answers. */
export const PAIR_STAGES = ['mac', 'tailscale', 'code', 'scan', 'pair', 'allow'] as const;
export type PairStage = (typeof PAIR_STAGES)[number];

/** The places this build's bar counts. */
export const pairStages = (relay = HAS_RELAY): readonly PairStage[] =>
  relay ? PAIR_STAGES.filter((s) => s !== 'tailscale') : PAIR_STAGES;

/** Where on the bar a screen sits: `getMac` is still the first question. */
export function stageOf(step: IntroStep): PairStage {
  return step === 'getMac' ? 'mac' : step;
}

/** "Step n of 6" (of 5 with a relay), for the bar and for a screen reader. */
export function progressOf(stage: PairStage, relay = HAS_RELAY): { n: number; of: number } {
  const stages = pairStages(relay);
  return { n: Math.max(0, stages.indexOf(stage)) + 1, of: stages.length };
}

/** The screen after this one; null after the last intro screen, which opens the camera. */
export function nextIntro(step: IntroStep, relay = HAS_RELAY): IntroStep | null {
  const steps = introSteps(relay);
  const at = step === 'getMac' ? 0 : steps.indexOf(step);
  return steps[at + 1] ?? null;
}

/** Back: the screen before; null on the first. */
export function prevIntro(step: IntroStep, relay = HAS_RELAY): IntroStep | null {
  if (step === 'getMac') return 'mac';
  const steps = introSteps(relay);
  return steps[steps.indexOf(step) - 1] ?? null;
}

/**
 * Where the screen opens. A phone that has paired before (to pair another
 * Mac, or again after a reset) has done the first two already: straight
 * to the Mac's button. Otherwise the saved screen, else the first question;
 * a saved Tailscale screen in a build with a relay goes on to the code.
 */
export function startStep(
  saved: IntroStep | null,
  pairedBefore: boolean,
  relay = HAS_RELAY
): IntroStep {
  if (pairedBefore) return 'code';
  if (relay && saved === 'tailscale') return 'code';
  return saved ?? 'mac';
}

const FILE = 'pair-step.json';
const isStep = (s: unknown): s is IntroStep =>
  s === 'getMac' || (INTRO_STEPS as readonly unknown[]).includes(s);

export async function readSavedStep(): Promise<IntroStep | null> {
  const saved = await readJson<{ v?: number; step?: unknown }>(FILE).catch(() => null);
  // The retired "Same account" screen: on to the one after it.
  if (saved?.v === 1 && saved.step === 'account') return 'code';
  return saved?.v === 1 && isStep(saved.step) ? saved.step : null;
}

export function saveStep(step: IntroStep): void {
  void writeJson(FILE, { v: 1, step }).catch(() => {});
}
