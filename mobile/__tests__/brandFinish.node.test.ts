/**
 * The brand direction's last three (docs/internal/brand-direction.md): the
 * keycap's side, the status pill's contrast, and which rows count as arrivals.
 */

import { emptyArrivals, MAX_ARRIVALS, noteArrivals } from '../src/lib/arrivals';
import {
  agentTints,
  APPEARANCES,
  ARRIVE,
  contrast,
  keycapShadow,
  keySide,
  depthOf,
  luminance,
  mix,
  palettes,
  PILL_WASH,
} from '../src/lib/theme';

describe('keycaps', () => {
  it('gives every accent, and the answer, a side darker than its face', () => {
    for (const appearance of APPEARANCES) {
      const fills = { white: palettes[appearance].accentNeutral, ...agentTints[appearance] };
      for (const [key, fill] of Object.entries(fills)) {
        expect([appearance, key, luminance(keySide(fill)) < luminance(fill)]).toEqual([
          appearance,
          key,
          true,
        ]);
      }
    }
  });

  it('presses down by what the side gives up', () => {
    const depth = depthOf(palettes.dark);
    expect(keycapShadow(depth, '#000000', false)).toContain(' 0 2px 0 #000000');
    expect(keycapShadow(depth, '#000000', true)).toContain(' 0 1px 0 #000000');
  });
});

describe('status pills', () => {
  const hues = (p: (typeof palettes)['dark']) => ({
    running: p.statusRunning,
    waiting: p.accentWarning,
    failed: p.accentError,
    done: p.accentSuccess,
    out: p.textMuted,
    idle: p.textFaint,
  });

  it('keeps the words at AA on their wash, on the app and a panel', () => {
    for (const appearance of APPEARANCES) {
      const p = palettes[appearance];
      for (const [tone, hue] of Object.entries(hues(p))) {
        for (const bg of [p.surfaceApp, p.surfacePanel]) {
          const fill = mix(hue, bg, PILL_WASH);
          expect([appearance, tone, contrast(p.textPrimary, fill) >= 4.5]).toEqual([
            appearance,
            tone,
            true,
          ]);
        }
      }
    }
  });

  it('gives each coloured dot 3:1 against its wash', () => {
    for (const appearance of APPEARANCES) {
      const p = palettes[appearance];
      const { running, waiting, failed, done } = hues(p);
      for (const [tone, hue] of Object.entries({ running, waiting, failed, done })) {
        const fill = mix(hue, p.surfaceApp, PILL_WASH);
        expect([appearance, tone, contrast(hue, fill) >= 3]).toEqual([appearance, tone, true]);
      }
    }
  });
});

describe('arrivals', () => {
  it('stays inside the 200 ms budget on the arrive curve', () => {
    expect(ARRIVE.ms).toBeLessThanOrEqual(200);
    expect(ARRIVE.curve).toEqual([0.16, 1, 0.3, 1]);
  });

  it('holds the first load still, and moves only what came in after', () => {
    let s = noteArrivals(emptyArrivals(), ['c', 'b', 'a'], true);
    expect([...s.arrived]).toEqual([]);
    s = noteArrivals(s, ['d', 'c', 'b', 'a'], true);
    expect([...s.arrived]).toEqual(['d']);
  });

  it('lets older history load at the far end without moving it', () => {
    let s = noteArrivals(emptyArrivals(), ['c', 'b'], true);
    s = noteArrivals(s, ['c', 'b', 'a', 'z'], true);
    expect([...s.arrived]).toEqual([]);
  });

  it('treats a big batch as a load, not news', () => {
    let s = noteArrivals(emptyArrivals(), ['a'], true);
    const batch = Array.from({ length: MAX_ARRIVALS + 1 }, (_, i) => `n${i}`);
    s = noteArrivals(s, [...batch, 'a'], true);
    expect([...s.arrived]).toEqual([]);
  });

  it('in an unordered list, any new key arrives', () => {
    let s = noteArrivals(emptyArrivals(), ['a', 'b'], false);
    s = noteArrivals(s, ['a', 'new', 'b'], false);
    expect([...s.arrived]).toEqual(['new']);
  });
});
