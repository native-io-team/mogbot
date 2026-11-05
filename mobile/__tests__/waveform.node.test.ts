/**
 * The waveform's numbers: the recognizer's volume as a bar level, the
 * easing, the bar heights, the fade and the history the strip scrolls.
 */

import { waveform } from '../src/lib/theme';
import {
  ATTACK_MS,
  RELEASE_MS,
  barHeight,
  barOpacity,
  easeLevel,
  formatElapsed,
  levelFromVolume,
  pushLevel,
} from '../src/lib/waveform';

/** The module's scale: -60..0 dB onto -2..10. */
const volumeAt = (db: number) => ((db + 60) / 60) * 12 - 2;

describe('level from the recognizer’s volume', () => {
  it('is silence for the room and below, full for a raised voice', () => {
    expect(levelFromVolume(-2)).toBe(0);
    expect(levelFromVolume(volumeAt(-55))).toBe(0);
    expect(levelFromVolume(volumeAt(-50))).toBe(0);
    expect(levelFromVolume(volumeAt(-12))).toBe(1);
    expect(levelFromVolume(10)).toBe(1);
  });

  it('rises with the voice, and lifts quiet speech', () => {
    const quiet = levelFromVolume(volumeAt(-40));
    const talk = levelFromVolume(volumeAt(-28));
    const loud = levelFromVolume(volumeAt(-18));
    expect(0 < quiet && quiet < talk && talk < loud && loud < 1).toBe(true);
    // Above the straight line: a soft voice still moves the bars.
    expect(quiet).toBeGreaterThan((-40 - -50) / (-12 - -50));
  });

  it('is silence for anything that isn’t a number', () => {
    expect(levelFromVolume(Number.NaN)).toBe(0);
    expect(levelFromVolume(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('easing', () => {
  it('rises faster than it falls', () => {
    const up = easeLevel(0, 1, 16, ATTACK_MS, RELEASE_MS);
    const down = 1 - easeLevel(1, 0, 16, ATTACK_MS, RELEASE_MS);
    expect(up).toBeGreaterThan(down);
    expect(ATTACK_MS).toBeLessThan(RELEASE_MS);
  });

  it('is the same over one long frame as over two short ones', () => {
    const once = easeLevel(0, 1, 32, ATTACK_MS, RELEASE_MS);
    const twice = easeLevel(
      easeLevel(0, 1, 16, ATTACK_MS, RELEASE_MS),
      1,
      16,
      ATTACK_MS,
      RELEASE_MS
    );
    expect(once).toBeCloseTo(twice, 6);
  });

  it('settles exactly, and a stall can’t overshoot', () => {
    let l = 1;
    for (let i = 0; i < 120; i++) l = easeLevel(l, 0, 16, ATTACK_MS, RELEASE_MS);
    expect(l).toBe(0);
    expect(easeLevel(0, 1, 10_000, ATTACK_MS, RELEASE_MS)).toBeLessThanOrEqual(1);
    expect(easeLevel(0.5, 0.5, 16, ATTACK_MS, RELEASE_MS)).toBe(0.5);
  });
});

describe('bars', () => {
  it('are a dot at silence and full height at full voice, clamped', () => {
    expect(barHeight(0, waveform.min, waveform.max)).toBe(waveform.min);
    expect(barHeight(1, waveform.min, waveform.max)).toBe(waveform.max);
    expect(barHeight(-1, waveform.min, waveform.max)).toBe(waveform.min);
    expect(barHeight(2, waveform.min, waveform.max)).toBe(waveform.max);
    expect(barHeight(0.5, 2, 18)).toBe(10);
  });

  it('fit inside the send-tall slot the field gives them', () => {
    expect(waveform.max).toBeLessThan(28);
    expect(waveform.min).toBeGreaterThan(0);
  });

  it('fade in at the left edge only', () => {
    expect(barOpacity(-4, waveform.fade)).toBe(0);
    expect(barOpacity(waveform.fade / 2, waveform.fade)).toBe(0.5);
    expect(barOpacity(waveform.fade, waveform.fade)).toBe(1);
    expect(barOpacity(100, waveform.fade)).toBe(1);
  });

  it('scroll: the oldest leaves at the left, the newest enters at the right', () => {
    const h = [0.1, 0.2, 0.3];
    expect(pushLevel(h, 0.9)).toEqual([0.2, 0.3, 0.9]);
    expect(h).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('elapsed', () => {
  it('reads as minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_900)).toBe('0:07');
    expect(formatElapsed(62_000)).toBe('1:02');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});
