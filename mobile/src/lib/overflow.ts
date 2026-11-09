/**
 * Whether a sideways-scrolling line still runs past the right edge: its
 * content is wider than the box it sits in, and it isn't scrolled to the end.
 * A point of slack, so rounding at the end never leaves a fade on nothing.
 */
export function moreToTheRight(content: number, view: number, x: number): boolean {
  if (!(content > 0) || !(view > 0)) return false;
  return content - view - Math.max(0, x) > 1;
}
