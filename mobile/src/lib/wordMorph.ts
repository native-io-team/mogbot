/**
 * Live words to better words, smoothly (`components/LiveWords.tsx`).
 *
 * - **Listening**: words come out one after another, the way you said them,
 *   even when the recognizer hands over a few at once; each settles in with
 *   a quick fade instead of popping.
 * - **Tidying**: the live words stay; a soft light passes over them, left to
 *   right, until the computer answers. Never a blank.
 * - **The better words arrive**: only the words that changed swap. The old
 *   ones fade down, the new ones fade up in their place and keep a faint
 *   highlight for a moment, so you can see what changed. Nothing else moves.
 *
 * Pure: the diff and every opacity as a function of time, so a frame can be
 * tested. Text runs on iOS can't blur, so the swap is a fade with a glow.
 */

/** A run of the text: unchanged, or words that were swapped. */
export type MorphPart = { kind: 'same'; text: string } | { kind: 'swap'; from: string; to: string };

/** Old words fade down over this long, then the new ones up. */
export const MORPH_OUT_MS = 140;
export const MORPH_IN_MS = 260;
/** The highlight on changed words lasts this long after they're in. */
export const MORPH_GLOW_MS = 1_300;
/** The whole morph, after which the field is the editable text again. */
export const MORPH_MS = MORPH_OUT_MS + MORPH_IN_MS + MORPH_GLOW_MS;
/** A new live word fades in over this long. */
export const SETTLE_MS = 220;
/** Words handed over together come out this far apart… */
export const WORD_GAP_MS = 70;
/** …or closer, so a big batch is all out within this long. */
export const CATCH_UP_MS = 600;

/**
 * When each of `count` words shows: the ones already timed keep their time,
 * new ones come out one after another from `at` (or after the last one still
 * to come). Fewer words than before (the recognizer changed its mind) keeps
 * the first `count`.
 */
export function stagger(born: number[], count: number, at: number): number[] {
  if (born.length >= count) return born.length === count ? born : born.slice(0, count);
  const added = count - born.length;
  const gap = Math.min(WORD_GAP_MS, CATCH_UP_MS / added);
  const lastAt = born.length ? born[born.length - 1] : null;
  const start = lastAt === null ? at : Math.max(at, lastAt + gap);
  return [...born, ...Array.from({ length: added }, (_, k) => start + gap * k)];
}

/** One pass of the light over the words while tidying. */
export const SHIMMER_MS = 1_300;

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));

/** Words with the space after each, so joining them gives the text back. */
export function tokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

const bare = (t: string) => t.trim();

/**
 * The runs that stayed and the ones that changed, word by word (a longest
 * common subsequence, so an inserted word doesn't shift everything after).
 * Joining `same` + `to` gives `to`'s text; `same` + `from` gives `from`'s.
 */
export function morphParts(from: string, to: string): MorphPart[] {
  const a = tokens(from).slice(0, 400);
  const b = tokens(to).slice(0, 400);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        bare(a[i]) === bare(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: MorphPart[] = [];
  const push = (part: MorphPart) => {
    const last = out[out.length - 1];
    if (part.kind === 'same' && last?.kind === 'same') last.text += part.text;
    else if (part.kind === 'swap' && last?.kind === 'swap') {
      last.from += part.from;
      last.to += part.to;
    } else out.push(part);
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && bare(a[i]) === bare(b[j])) {
      // Same word: the new text's spacing wins.
      push({ kind: 'same', text: b[j] });
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
      push({ kind: 'swap', from: a[i++], to: '' });
    } else {
      push({ kind: 'swap', from: '', to: b[j++] });
    }
  }
  return out;
}

/** How a changed run looks `t` ms into the morph. */
export function swapLook(t: number): { show: 'from' | 'to'; opacity: number; glow: number } {
  if (t < MORPH_OUT_MS) return { show: 'from', opacity: 1 - 0.8 * ease(t / MORPH_OUT_MS), glow: 0 };
  const k = t - MORPH_OUT_MS;
  const fadeIn = ease(k / MORPH_IN_MS);
  const glow = k < MORPH_IN_MS ? fadeIn : 1 - ease((k - MORPH_IN_MS) / MORPH_GLOW_MS);
  return { show: 'to', opacity: 0.2 + 0.8 * fadeIn, glow };
}

/** A live word's opacity `age` ms after it arrived. */
export function settleOpacity(age: number): number {
  return 0.3 + 0.7 * ease(age / SETTLE_MS);
}

/**
 * Word `i` of `n`'s opacity `t` ms into tidying: a soft light sweeps across,
 * the rest a little dimmed (they're about to be checked).
 */
export function shimmerOpacity(i: number, n: number, t: number): number {
  const p = (t % SHIMMER_MS) / SHIMMER_MS;
  const at = n <= 1 ? 0.5 : i / (n - 1);
  const d = Math.abs(at - (p * 1.4 - 0.2));
  const light = Math.max(0, 1 - d / 0.18);
  return 0.62 + 0.38 * light;
}
