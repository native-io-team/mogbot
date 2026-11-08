/**
 * The typing key's press on the phone (`lib/typingKey.ts`) is the spec's
 * keyframes, the ones the desk's CSS holds (agentKeyMotion.test.ts): at
 * each keyframe's time the depth is that keyframe's, it eases between them,
 * and the loop meets itself.
 */

import { TYPING_KEY } from '@shipstudio/companion-protocol';
import { TYPING_KEY_PERIOD_MS, keyDepth, keyDrop } from '../src/lib/typingKey';

describe('the typing key', () => {
  it('passes through every keyframe', () => {
    for (const [t, d] of TYPING_KEY.press)
      expect(keyDepth(t === 1 ? 0.9999999 : t)).toBeCloseTo(d, 4);
  });

  it('eases between keyframes and never leaves the travel', () => {
    for (let p = 0; p <= 1; p += 0.005) {
      const d = keyDepth(p);
      expect(d).toBeGreaterThanOrEqual(-1);
      expect(d).toBeLessThanOrEqual(1);
    }
    // Halfway into the first tap, half pressed (ease in-out is symmetric).
    expect(keyDepth(TYPING_KEY.press[1][0] / 2)).toBeCloseTo(0.5, 4);
  });

  it('loops on one clock: the end meets the start', () => {
    expect(keyDepth(1)).toBeCloseTo(keyDepth(0), 6);
    expect(keyDepth(1.06)).toBeCloseTo(keyDepth(0.06), 6);
    expect(TYPING_KEY_PERIOD_MS).toBe(TYPING_KEY.ms);
  });

  it('tightens the drop as the top goes down, never on the rebound', () => {
    expect(keyDrop(0)).toBe(1);
    expect(keyDrop(-0.15)).toBe(1);
    expect(keyDrop(1)).toBeCloseTo(TYPING_KEY.pressedDrop, 6);
    expect(keyDrop(0.5)).toBeCloseTo(1 - (1 - TYPING_KEY.pressedDrop) / 2, 6);
  });
});
