/**
 * The photo viewer's zoom maths: the bounds a picture is held to, the point
 * that stays between the fingers, a double-tap's target, and when a swipe
 * turns the page or closes.
 */

import {
  CLOSE_PULL,
  MAX_ZOOM,
  TAP_ZOOM,
  clampOffset,
  clampScale,
  doubleTapTarget,
  dragBy,
  fitSize,
  isZoomed,
  offsetLimit,
  pageAfterSwipe,
  pageDrag,
  shouldClose,
  zoomOffset,
} from '../src/lib/zoom';

const screen = { width: 400, height: 800 };
// A desktop screenshot on a phone: full width, a band across the middle.
const shot = fitSize({ width: 2000, height: 1000 }, screen);

describe('fit and the bounds', () => {
  it('contains the picture on the screen', () => {
    expect(shot).toEqual({ width: 400, height: 200 });
    expect(fitSize({ width: 100, height: 400 }, screen)).toEqual({ width: 200, height: 800 });
    expect(fitSize({ width: 0, height: 0 }, screen)).toEqual(screen);
  });

  it('holds the scale between fit and 5×', () => {
    expect(MAX_ZOOM).toBe(5);
    expect(clampScale(0.4)).toBe(1);
    expect(clampScale(9)).toBe(5);
    expect(clampScale(2.2)).toBe(2.2);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(isZoomed(1.005)).toBe(false);
    expect(isZoomed(1.2)).toBe(true);
  });

  it('lets the picture move only as far as it overflows the screen', () => {
    // At 2× the shot is 800×400: 200 spare each side, and none vertically.
    expect(offsetLimit(shot.width, 2, screen.width)).toBe(200);
    expect(offsetLimit(shot.height, 2, screen.height)).toBe(0);
    expect(offsetLimit(shot.height, 5, screen.height)).toBe(100);
    expect(clampOffset(350, 200)).toBe(200);
    expect(clampOffset(-350, 200)).toBe(-200);
    expect(clampOffset(50, 200)).toBe(50);
  });

  it('gives at an edge instead of stopping dead, and follows freely back in', () => {
    expect(dragBy(0, 30, 200)).toBe(30);
    expect(dragBy(200, 100, 200)).toBe(235);
    expect(dragBy(-200, -100, 200)).toBe(-235);
    expect(dragBy(235, -40, 200)).toBe(195);
  });
});

describe('the point between the fingers', () => {
  it('stays put as the scale changes', () => {
    const focal = 120;
    const from = { scale: 1.5, offset: -40 };
    const to = 3;
    const offset = zoomOffset(from.offset, from.scale, to, focal);
    // The picture point under the fingers, before and after.
    expect((focal - offset) / to).toBeCloseTo((focal - from.offset) / from.scale);
  });

  it('pans with fingers that move together while they pinch', () => {
    expect(zoomOffset(0, 1, 1, 50, 80)).toBe(30);
    expect(zoomOffset(0, 1, 2, 0, 0)).toBe(0);
    expect(zoomOffset(10, 0, 2, 0)).toBe(0);
  });
});

describe('a double-tap', () => {
  it('zooms in at the point tapped, held inside the bounds', () => {
    const t = doubleTapTarget(1, { x: 100, y: 50 }, shot, screen);
    expect(t.scale).toBe(TAP_ZOOM);
    // 100 · (1 − 2.5) = −150, inside the 300 the shot may move at 2.5×.
    expect(t.x).toBe(-150);
    // The shot is 500 tall at 2.5×: shorter than the screen, so it stays centred.
    expect(t.y).toBe(0);
    const corner = doubleTapTarget(1, { x: 200, y: 0 }, shot, screen);
    expect(corner.x).toBe(-offsetLimit(shot.width, TAP_ZOOM, screen.width));
  });

  it('zoomed in, comes back to fit', () => {
    expect(doubleTapTarget(3, { x: 100, y: 50 }, shot, screen)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('swipes at fit', () => {
  it('turn the page past a quarter of the screen or on a flick, and never off the ends', () => {
    expect(pageAfterSwipe(1, -120, 0, 400, 3)).toBe(2);
    expect(pageAfterSwipe(1, 120, 0, 400, 3)).toBe(0);
    expect(pageAfterSwipe(1, -60, 0, 400, 3)).toBe(1);
    expect(pageAfterSwipe(1, -20, -900, 400, 3)).toBe(2);
    expect(pageAfterSwipe(2, -300, -900, 400, 3)).toBe(2);
    expect(pageAfterSwipe(0, 300, 900, 400, 3)).toBe(0);
    expect(pageAfterSwipe(0, -300, 0, 400, 0)).toBe(0);
  });

  it('give at the first and last picture', () => {
    expect(pageDrag(0, 100, 3)).toBe(35);
    expect(pageDrag(0, -100, 3)).toBe(-100);
    expect(pageDrag(2, -100, 3)).toBe(-35);
    expect(pageDrag(1, 100, 3)).toBe(100);
  });

  it('close on a long pull down or a quick one, never on a pull up', () => {
    expect(shouldClose(CLOSE_PULL + 1, 0)).toBe(true);
    expect(shouldClose(40, 1200)).toBe(true);
    expect(shouldClose(40, 200)).toBe(false);
    expect(shouldClose(-200, 1200)).toBe(false);
  });
});
