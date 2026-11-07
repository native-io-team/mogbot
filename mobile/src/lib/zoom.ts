/**
 * The photo viewer's maths, as worklets so the gestures run on the UI thread:
 * how big a picture sits at fit, how far it may be zoomed and dragged, where
 * it goes so the point between the fingers stays between them, the give at
 * an edge, and when a swipe turns the page or closes the viewer.
 *
 * Scale is relative to fit (1 = fit); an offset is the picture's centre from
 * the screen's centre, in points. The desk has the same model in
 * src/lib/imageZoom.ts (DOM side, no worklets).
 */

export interface Size {
  width: number;
  height: number;
}

/** Zoom as far as this (5× fit), and pinching may overshoot to this before it springs back. */
export const MAX_ZOOM = 5;
export const MAX_OVERSHOOT = 6;
/** A double-tap zooms to this. */
export const TAP_ZOOM = 2.5;
/** Within this of fit counts as fit (float drift from a pinch). */
const EPSILON = 0.01;
/** How much of a drag past an edge the picture follows. */
const RUBBER = 0.35;
/** A page turns past this share of the screen, or on a flick this fast. */
const PAGE_DISTANCE = 0.25;
const PAGE_VELOCITY = 500;
/** Pulled down this far, or flicked down this fast, closes. */
export const CLOSE_PULL = 120;
const CLOSE_VELOCITY = 800;

export function isZoomed(scale: number): boolean {
  'worklet';
  return scale > 1 + EPSILON;
}

/** The picture contained in the screen (expo-image's `contain`). */
export function fitSize(natural: Size, screen: Size): Size {
  'worklet';
  if (natural.width <= 0 || natural.height <= 0) return screen;
  const ratio = Math.min(screen.width / natural.width, screen.height / natural.height);
  return { width: natural.width * ratio, height: natural.height * ratio };
}

/**
 * Never a default parameter naming a module constant in a worklet
 * (`max = MAX_ZOOM`): on the UI runtime it is evaluated before the closure is
 * unpacked and throws, which took the app down on every pinch.
 */
export function clampScale(scale: number, max?: number): number {
  'worklet';
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, 1), max ?? MAX_ZOOM);
}

/** How far the centre may move along one axis, so no edge it could fill shows a gap. */
export function offsetLimit(content: number, scale: number, screen: number): number {
  'worklet';
  return Math.max(0, (content * scale - screen) / 2);
}

export function clampOffset(value: number, limit: number): number {
  'worklet';
  const held = Math.min(Math.max(value, -limit), limit);
  return held === 0 ? 0 : held; // never -0
}

/**
 * A drag of `delta` from `value`: inside ±limit the picture follows the
 * finger; pulled further out past an edge it follows only part of the way,
 * so the edge gives rather than stopping dead.
 */
export function dragBy(value: number, delta: number, limit: number): number {
  'worklet';
  const outward = (value >= limit && delta > 0) || (value <= -limit && delta < 0);
  return value + (outward ? delta * RUBBER : delta);
}

/**
 * The offset that keeps the picture point under `focal` (from the centre)
 * under `focalNow` while the scale goes `from` → `to`: that point sits at
 * (focal − offset) / from in the picture. With focalNow ≠ focal, two fingers
 * moving together pan as they pinch.
 */
export function zoomOffset(
  offset: number,
  from: number,
  to: number,
  focal: number,
  focalNow: number = focal
): number {
  'worklet';
  if (from <= 0) return 0;
  return focalNow - (to / from) * (focal - offset);
}

/** A double-tap: zoomed, back to fit; at fit, in to `TAP_ZOOM` at the point tapped. */
export function doubleTapTarget(
  scale: number,
  tap: { x: number; y: number },
  content: Size,
  screen: Size
): { scale: number; x: number; y: number } {
  'worklet';
  if (isZoomed(scale)) return { scale: 1, x: 0, y: 0 };
  const to = TAP_ZOOM;
  return {
    scale: to,
    x: clampOffset(zoomOffset(0, 1, to, tap.x), offsetLimit(content.width, to, screen.width)),
    y: clampOffset(zoomOffset(0, 1, to, tap.y), offsetLimit(content.height, to, screen.height)),
  };
}

/** Where a sideways swipe lands: the next or previous page, or back where it was. */
export function pageAfterSwipe(
  index: number,
  dx: number,
  vx: number,
  width: number,
  count: number
): number {
  'worklet';
  let next = index;
  if (dx < -width * PAGE_DISTANCE || vx < -PAGE_VELOCITY) next = index + 1;
  else if (dx > width * PAGE_DISTANCE || vx > PAGE_VELOCITY) next = index - 1;
  return Math.min(Math.max(next, 0), Math.max(count - 1, 0));
}

/** A sideways drag at either end of the gallery gives, rather than moving freely. */
export function pageDrag(index: number, dx: number, count: number): number {
  'worklet';
  const atStart = index <= 0 && dx > 0;
  const atEnd = index >= count - 1 && dx < 0;
  return atStart || atEnd ? dx * RUBBER : dx;
}

/** A pull down at fit: far or fast enough closes; anything else springs back. */
export function shouldClose(dy: number, vy: number): boolean {
  'worklet';
  return dy > CLOSE_PULL || (dy > 0 && vy > CLOSE_VELOCITY);
}
