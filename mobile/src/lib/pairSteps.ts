/**
 * Pairing on the phone, one screen at a time: one question, one big button,
 * Back, and a bar that says how far along it is. The order is the one the
 * desk walks from its side (`companion-protocol/src/pairWords.ts` holds the
 * words both sides say):
 *
 * 1. Do you have the app on your Mac? (Not yet: where to get it.)
 * 2. Turn on Tailscale on this phone.
 * 3. The same Tailscale account on both.
 * 4. On your Mac, click "Pair your phone": I see the code.
 * 5. The camera.
 * 6. Pair with <Mac>? (Pair.)
 * 7. Click Allow on your Mac (waits, ticks by itself).
 *
 * The first four are saved as they change, so leaving the app halfway (to
 * install Tailscale, say) opens on the same screen. Pure, for the tests;
 * the screen is `app/pair.tsx`.
 *
 * @module lib/pairSteps
 */

import { readJson, writeJson } from './persist';

/** The screens before the camera, in order. `getMac` is the "Not yet" answer to `mac`. */
export const INTRO_STEPS = ['mac', 'tailscale', 'account', 'code'] as const;
export type IntroStep = (typeof INTRO_STEPS)[number] | 'getMac';

/** Every place the bar counts, the intro's four then the camera and the two answers. */
export const PAIR_STAGES = [
  'mac',
  'tailscale',
  'account',
  'code',
  'scan',
  'pair',
  'allow',
] as const;
export type PairStage = (typeof PAIR_STAGES)[number];

/** Where on the bar a screen sits: `getMac` is still the first question. */
export function stageOf(step: IntroStep): PairStage {
  return step === 'getMac' ? 'mac' : step;
}

/** "Step n of 7", for the bar and for a screen reader. */
export function progressOf(stage: PairStage): { n: number; of: number } {
  return { n: PAIR_STAGES.indexOf(stage) + 1, of: PAIR_STAGES.length };
}

/** The screen after this one; null after the last intro screen, which opens the camera. */
export function nextIntro(step: IntroStep): IntroStep | null {
  if (step === 'getMac') return 'tailscale';
  return INTRO_STEPS[INTRO_STEPS.indexOf(step) + 1] ?? null;
}

/** Back: the screen before; null on the first. */
export function prevIntro(step: IntroStep): IntroStep | null {
  if (step === 'getMac') return 'mac';
  return INTRO_STEPS[INTRO_STEPS.indexOf(step) - 1] ?? null;
}

/**
 * Where the screen opens. A phone that has paired before (to pair another
 * Mac, or again after a reset) has done the first three already: straight
 * to the Mac's button. Otherwise the saved screen, else the first question.
 */
export function startStep(saved: IntroStep | null, pairedBefore: boolean): IntroStep {
  if (pairedBefore) return 'code';
  return saved ?? 'mac';
}

const FILE = 'pair-step.json';
const isStep = (s: unknown): s is IntroStep =>
  s === 'getMac' || (INTRO_STEPS as readonly unknown[]).includes(s);

export async function readSavedStep(): Promise<IntroStep | null> {
  const saved = await readJson<{ v?: number; step?: unknown }>(FILE).catch(() => null);
  return saved?.v === 1 && isStep(saved.step) ? saved.step : null;
}

export function saveStep(step: IntroStep): void {
  void writeJson(FILE, { v: 1, step }).catch(() => {});
}
