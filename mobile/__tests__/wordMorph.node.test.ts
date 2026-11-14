import {
  MORPH_IN_MS,
  MORPH_MS,
  MORPH_OUT_MS,
  morphParts,
  settleOpacity,
  shimmerOpacity,
  stagger,
  swapLook,
  WORD_GAP_MS,
  tokens,
} from '../src/lib/wordMorph';

const join = (parts: ReturnType<typeof morphParts>, side: 'from' | 'to') =>
  parts.map((p) => (p.kind === 'same' ? p.text : p[side])).join('');

describe('morphParts', () => {
  it('swaps only the words that changed', () => {
    const from = 'ask mog about to check why the lobeva site is slow';
    const to = 'Ask Mogbot to check why the Lobeva site is slow.';
    const parts = morphParts(from, to);
    expect(join(parts, 'to')).toBe(to);
    expect(
      parts.filter((p) => p.kind === 'swap').map((p) => p.kind === 'swap' && p.to.trim())
    ).toEqual(['Ask Mogbot', 'Lobeva', 'slow.']);
    expect(
      parts.find((p) => p.kind === 'same' && p.text.includes('to check why the'))
    ).toBeTruthy();
  });

  it('keeps typed text before the dictation as it was', () => {
    const parts = morphParts('Quick one: ask mog about', 'Quick one: ask Mogbot');
    expect(parts[0]).toEqual({ kind: 'same', text: 'Quick one: ask ' });
    expect(join(parts, 'to')).toBe('Quick one: ask Mogbot');
  });

  it('nothing changed is one run', () => {
    expect(morphParts('ship it', 'ship it')).toEqual([{ kind: 'same', text: 'ship it' }]);
    expect(tokens('')).toEqual([]);
  });
});

describe('timing', () => {
  it('fades the old words down, the new ones up, then lets the glow go', () => {
    expect(swapLook(0)).toMatchObject({ show: 'from', opacity: 1 });
    expect(swapLook(MORPH_OUT_MS + 1).show).toBe('to');
    expect(swapLook(MORPH_OUT_MS + MORPH_IN_MS).opacity).toBeCloseTo(1);
    expect(swapLook(MORPH_OUT_MS + MORPH_IN_MS).glow).toBeCloseTo(1);
    expect(swapLook(MORPH_MS).glow).toBeCloseTo(0);
  });

  it('settles new words in and sweeps a light while tidying', () => {
    expect(settleOpacity(0)).toBeCloseTo(0.3);
    expect(settleOpacity(1_000)).toBe(1);
    const frame = [0, 1, 2, 3, 4].map((i) => shimmerOpacity(i, 5, 400));
    expect(Math.max(...frame)).toBeGreaterThan(0.9);
    expect(Math.min(...frame)).toBeCloseTo(0.62);
  });
});

describe('stagger', () => {
  it('lets words handed over together out one after another', () => {
    const born = stagger([], 3, 1_000);
    expect(born).toEqual([1_000, 1_000 + WORD_GAP_MS, 1_000 + 2 * WORD_GAP_MS]);
    // Two more while the last is still to come: they queue behind it.
    const more = stagger(born, 5, 1_010);
    expect(more.slice(0, 3)).toEqual(born);
    expect(more[3]).toBe(born[2] + WORD_GAP_MS);
  });

  it('gets a big batch out quickly and keeps times when words are taken back', () => {
    const born = stagger([], 30, 0);
    expect(born[29]).toBeLessThan(600);
    expect(stagger(born, 10, 5_000)).toEqual(born.slice(0, 10));
    expect(stagger([5, 6], 3, 2_000)).toEqual([5, 6, 2_000]);
  });
});
