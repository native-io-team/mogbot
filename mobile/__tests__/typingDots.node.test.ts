import {
  TYPING_ACTIVE,
  TYPING_DOTS,
  TYPING_PERIOD_MS,
  TYPING_REST_OPACITY,
  TYPING_STAGGER,
  dotLevel,
  dotOpacity,
  dotPhase,
} from '../src/lib/typingDots';

/** Each dot's opacity over one period, sampled every `step` of the clock. */
const curve = (index: number, step = 1 / 240) =>
  Array.from({ length: Math.round(1 / step) }, (_, k) =>
    dotOpacity(dotLevel(dotPhase(k * step, index)))
  );

describe('typing dots', () => {
  it('match the desk: three dots, 1200 ms, a sixth of it apart', () => {
    expect(TYPING_DOTS).toBe(3);
    expect(TYPING_PERIOD_MS).toBe(1200);
    expect(TYPING_STAGGER * TYPING_PERIOD_MS).toBe(200);
  });

  it('give every dot the same wave, peak and rest: none of them sits still', () => {
    for (let i = 0; i < TYPING_DOTS; i++) {
      const c = curve(i);
      expect(Math.max(...c)).toBeCloseTo(1, 3);
      expect(Math.min(...c)).toBeCloseTo(TYPING_REST_OPACITY, 6);
      // The same shape as the first dot, only shifted.
      const sorted = (xs: number[]) => xs.map((x) => x.toFixed(6)).sort();
      expect(sorted(c)).toEqual(sorted(curve(0)));
    }
  });

  it('peak one after another, an equal step apart, every cycle', () => {
    const peaks = [0, 1, 2].map((i) => {
      const c = curve(i, 1 / 1200);
      return c.indexOf(Math.max(...c)) / 1200;
    });
    expect(peaks[1] - peaks[0]).toBeCloseTo(TYPING_STAGGER, 2);
    expect(peaks[2] - peaks[1]).toBeCloseTo(TYPING_STAGGER, 2);
    // And they stay that way: phase is the clock, not time a dot has run.
    for (const cycle of [1, 7, 1000]) {
      for (let i = 0; i < TYPING_DOTS; i++) {
        expect(dotPhase(cycle + 0.3, i)).toBeCloseTo(dotPhase(0.3, i), 9);
      }
    }
  });

  it('rise and fall smoothly, then rest together', () => {
    expect(dotLevel(0)).toBeCloseTo(0, 9);
    expect(dotLevel(TYPING_ACTIVE / 2)).toBeCloseTo(1, 9);
    expect(dotLevel(TYPING_ACTIVE)).toBe(0);
    expect(dotLevel(0.9)).toBe(0);
    // The last dot's wave ends before the cycle does: a beat with all three at rest.
    const restStart = (TYPING_DOTS - 1) * TYPING_STAGGER + TYPING_ACTIVE;
    expect(restStart).toBeLessThan(1);
  });

  it('wrap phase into 0..1, including before the clock starts', () => {
    expect(dotPhase(0, 2)).toBeCloseTo(1 - 2 * TYPING_STAGGER, 9);
    expect(dotPhase(0.5, 0)).toBe(0.5);
    expect(dotPhase(1, 0)).toBe(0);
  });
});
