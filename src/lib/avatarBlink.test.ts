import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLINK,
  blinkSchedule,
  blinks,
  nextBlink,
} from '../../packages/companion-protocol/src/avatar';
import { BLINK_MS, avatarPaused, startBlinking } from './avatarBlink';

/** A small seeded generator (mulberry32), so a run is repeatable. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the blink schedule', () => {
  it('waits 3 to 7 seconds, and rarely doubles', () => {
    const rand = seeded(7);
    const steps = Array.from({ length: 2000 }, () => nextBlink(rand));
    for (const s of steps) {
      expect(s.gapMs).toBeGreaterThanOrEqual(BLINK.gapMs[0]);
      expect(s.gapMs).toBeLessThanOrEqual(BLINK.gapMs[1]);
    }
    const doubles = steps.filter((s) => s.double).length / steps.length;
    expect(doubles).toBeGreaterThan(0.06);
    expect(doubles).toBeLessThan(0.2);
    // Spread across the range, not bunched.
    expect(Math.min(...steps.map((s) => s.gapMs))).toBeLessThan(3500);
    expect(Math.max(...steps.map((s) => s.gapMs))).toBeGreaterThan(6500);
  });

  it('differs per avatar; a blink is 120 to 160ms and its double starts after it ends', () => {
    expect(blinkSchedule(seeded(1))).not.toEqual(blinkSchedule(seeded(2)));
    expect(BLINK_MS).toBeGreaterThanOrEqual(120);
    expect(BLINK_MS).toBeLessThanOrEqual(160);
    expect(BLINK.doubleGapMs).toBeGreaterThan(BLINK_MS);
  });

  it('skips tiny avatars and faces without eyes', () => {
    expect(blinks('dots', 16)).toBe(false);
    expect(blinks('dots', 18)).toBe(false);
    expect(blinks('dots', 24)).toBe(true);
    expect(blinks('smile', 48)).toBe(true);
    expect(blinks('monogram', 48)).toBe(false);
  });
});

describe('the desk blink timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => document.createElement('span');
  const blinking = (el: Element) => el.hasAttribute('data-blinking');

  /** Rising edges of data-blinking over `ms`, sampled every 10ms. */
  function edges(el: Element, ms: number) {
    let was = false;
    let n = 0;
    for (let t = 0; t < ms; t += 10) {
      vi.advanceTimersByTime(10);
      if (blinking(el) && !was) n++;
      was = blinking(el);
    }
    return n;
  }

  it('sets data-blinking for one blink at a time', () => {
    const el = make();
    // 0.5 draws a 5000ms gap and a single blink.
    const stop = startBlinking(el, { rand: () => 0.5, paused: () => false });
    vi.advanceTimersByTime(4999);
    expect(blinking(el)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(blinking(el)).toBe(true);
    vi.advanceTimersByTime(BLINK_MS);
    expect(blinking(el)).toBe(false);
    stop();
  });

  it('blinks twice in a row when the step says so', () => {
    const el = make();
    // Gap draw 0 (3000ms), double draw 0 (under the chance).
    const stop = startBlinking(el, { rand: () => 0, paused: () => false });
    // 3000 gap, then two blinks: 0 and doubleGapMs. The next gap is 3000 again.
    expect(edges(el, 3000 + BLINK.doubleGapMs + BLINK_MS + 50)).toBe(2);
    stop();
  });

  it('never blinks while paused, and picks up when it is not', () => {
    const el = make();
    let paused = true;
    const stop = startBlinking(el, { rand: () => 0.5, paused: () => paused });
    expect(edges(el, 60000)).toBe(0);
    paused = false;
    expect(edges(el, 10000)).toBeGreaterThanOrEqual(1);
    stop();
  });

  it('stops cleanly and leaves nothing set or scheduled', () => {
    const el = make();
    const stop = startBlinking(el, { rand: () => 0.5, paused: () => false });
    vi.advanceTimersByTime(5000);
    expect(blinking(el)).toBe(true);
    stop();
    expect(blinking(el)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is paused by data-offscreen, a hidden window and Reduce Motion', () => {
    const el = make();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(avatarPaused(el)).toBe(false);
    el.setAttribute('data-offscreen', '');
    expect(avatarPaused(el)).toBe(true);
    el.removeAttribute('data-offscreen');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    expect(avatarPaused(el)).toBe(true);
    vi.restoreAllMocks();
    const mm = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', mm);
    expect(avatarPaused(el)).toBe(true);
    expect(mm).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    vi.unstubAllGlobals();
  });
});
