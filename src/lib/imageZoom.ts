/**
 * The maths of zooming one picture in the lightbox: how big it sits at "fit",
 * what 100% (its own pixels) is, how far it may be zoomed and dragged, and
 * where it goes so the point under the pointer stays under the pointer.
 *
 * A view is a scale relative to fit (1 = fit) and the offset, in screen px,
 * of the picture's centre from the stage's centre. Pure, so it is tested
 * without a DOM; the phone has its own copy as worklets (mobile/src/lib/zoom.ts).
 *
 * @module lib/imageZoom
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ZoomView {
  /** 1 is fit. */
  scale: number;
  /** The picture's centre from the stage's centre, in px. */
  x: number;
  y: number;
}

export const FIT_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

/** One ⌘+ / ⌘−, as a ratio: the same size of step at any zoom. */
const STEP_RATIO = 1.25;
/** Zoom goes to 4× the picture's own pixels, and never less than 4× fit. */
const MAX_OF_ACTUAL = 4;
const MAX_OF_FIT = 4;
/** A mouse-wheel notch reports a big delta at once; a pinch, a stream of small ones. */
const COARSE_WHEEL_DELTA = 50;
const PINCH_RESPONSE = 0.01;
/** Within this of fit counts as fit (float drift from a gesture). */
const EPSILON = 0.001;

/** The picture contained in the stage, never blown up past its own pixels. */
export function fitSize(natural: Size, stage: Size): Size {
  if (natural.width <= 0 || natural.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return { width: Math.max(stage.width, 0), height: Math.max(stage.height, 0) };
  }
  const ratio = Math.min(1, stage.width / natural.width, stage.height / natural.height);
  return { width: natural.width * ratio, height: natural.height * ratio };
}

/** The scale (relative to fit) at which one image pixel is one screen pixel. */
export function actualScale(natural: Size, fit: Size): number {
  if (fit.width <= 0 || natural.width <= 0) return 1;
  return Math.max(1, natural.width / fit.width);
}

export function maxScale(natural: Size, fit: Size): number {
  return Math.max(MAX_OF_FIT, actualScale(natural, fit) * MAX_OF_ACTUAL);
}

export function clampScale(scale: number, max: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, 1), Math.max(max, 1));
}

/** How far the picture's centre may move from the stage's on each axis. */
export function offsetLimit(scale: number, fit: Size, stage: Size): Point {
  return {
    x: Math.max(0, (fit.width * scale - stage.width) / 2),
    y: Math.max(0, (fit.height * scale - stage.height) / 2),
  };
}

/** Held so the picture never leaves a gap at an edge it could fill. */
export function clampView(view: ZoomView, fit: Size, stage: Size): ZoomView {
  const limit = offsetLimit(view.scale, fit, stage);
  return {
    scale: view.scale,
    x: Math.min(Math.max(view.x, -limit.x), limit.x),
    y: Math.min(Math.max(view.y, -limit.y), limit.y),
  };
}

/**
 * Zoom to `scale` keeping the picture point under `focal` (relative to the
 * stage's centre) where it is. The point sits at (focal − offset) / scale in
 * the picture, so the new offset is focal − (next / scale) · (focal − offset).
 */
export function zoomAround(
  view: ZoomView,
  scale: number,
  focal: Point,
  fit: Size,
  stage: Size,
  max: number
): ZoomView {
  const next = clampScale(scale, max);
  if (next <= 1 + EPSILON) return FIT_VIEW;
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: focal.x - ratio * (focal.x - view.x),
      y: focal.y - ratio * (focal.y - view.y),
    },
    fit,
    stage
  );
}

/** One ⌘+ or ⌘− step from `scale`. */
export function stepScale(scale: number, direction: 'in' | 'out', max: number): number {
  return clampScale(direction === 'in' ? scale * STEP_RATIO : scale / STEP_RATIO, max);
}

/** The scale a ctrl+wheel (a trackpad pinch, or ctrl and a mouse wheel) asks for. */
export function wheelScale(scale: number, deltaY: number, max: number): number {
  if (deltaY === 0) return scale;
  if (Math.abs(deltaY) >= COARSE_WHEEL_DELTA) {
    return stepScale(scale, deltaY < 0 ? 'in' : 'out', max);
  }
  return clampScale(scale * Math.exp(-deltaY * PINCH_RESPONSE), max);
}

export function panView(view: ZoomView, dx: number, dy: number, fit: Size, stage: Size): ZoomView {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, fit, stage);
}

export const isZoomed = (view: ZoomView) => view.scale > 1 + EPSILON;

/**
 * A click: zoomed in, back to fit; at fit, to the picture's own pixels at the
 * point clicked (or 2× when it already shows at its own size).
 */
export function toggleView(
  view: ZoomView,
  focal: Point,
  natural: Size,
  fit: Size,
  stage: Size
): ZoomView {
  if (isZoomed(view)) return FIT_VIEW;
  const actual = actualScale(natural, fit);
  const target = actual > 1 + EPSILON ? actual : 2;
  return zoomAround(view, target, focal, fit, stage, maxScale(natural, fit));
}

/** The zoom as a share of the picture's own pixels: "100%" is one to one. */
export function zoomPercent(view: ZoomView, natural: Size, fit: Size): number {
  if (natural.width <= 0) return 100;
  return Math.round(((view.scale * fit.width) / natural.width) * 100);
}
