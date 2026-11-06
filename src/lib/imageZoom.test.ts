import { describe, expect, it } from 'vitest';
import {
  FIT_VIEW,
  actualScale,
  clampScale,
  clampView,
  fitSize,
  maxScale,
  panView,
  stepScale,
  toggleView,
  wheelScale,
  zoomAround,
  zoomPercent,
} from './imageZoom';

const stage = { width: 1000, height: 600 };
// A 2000×1200 screenshot fits the stage at half size.
const natural = { width: 2000, height: 1200 };
const fit = fitSize(natural, stage);

describe('fit and 100%', () => {
  it('contains the picture in the stage', () => {
    expect(fit).toEqual({ width: 1000, height: 600 });
    expect(fitSize({ width: 3000, height: 600 }, stage)).toEqual({ width: 1000, height: 200 });
  });

  it('never blows a small picture up past its own pixels', () => {
    expect(fitSize({ width: 200, height: 100 }, stage)).toEqual({ width: 200, height: 100 });
    expect(actualScale({ width: 200, height: 100 }, { width: 200, height: 100 })).toBe(1);
  });

  it('knows the scale at which a pixel is a pixel, and reads it as 100%', () => {
    expect(actualScale(natural, fit)).toBe(2);
    expect(zoomPercent(FIT_VIEW, natural, fit)).toBe(50);
    expect(zoomPercent({ scale: 2, x: 0, y: 0 }, natural, fit)).toBe(100);
  });

  it('survives a picture or stage with no size yet', () => {
    expect(fitSize({ width: 0, height: 0 }, stage)).toEqual(stage);
    expect(fitSize(natural, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
    expect(actualScale({ width: 0, height: 0 }, fit)).toBe(1);
  });
});

describe('clamping', () => {
  it('holds the scale between fit and the ceiling', () => {
    const max = maxScale(natural, fit);
    expect(max).toBe(8); // 4× its own pixels
    expect(clampScale(0.2, max)).toBe(1);
    expect(clampScale(20, max)).toBe(8);
    expect(clampScale(Number.NaN, max)).toBe(1);
    // A small picture can still be zoomed 4× fit.
    const small = { width: 200, height: 100 };
    expect(maxScale(small, fitSize(small, stage))).toBe(4);
  });

  it('keeps the picture covering the stage: no gap at an edge it could fill', () => {
    // At 2× the picture is 2000×1200, so its centre may move 500 / 300.
    expect(clampView({ scale: 2, x: 900, y: -900 }, fit, stage)).toEqual({
      scale: 2,
      x: 500,
      y: -300,
    });
    // At fit it cannot move at all.
    expect(clampView({ scale: 1, x: 40, y: 40 }, fit, stage)).toEqual(FIT_VIEW);
  });

  it('lets a narrow picture pan only along the axis it overflows', () => {
    const tall = fitSize({ width: 300, height: 1200 }, stage); // 150×600
    expect(clampView({ scale: 2, x: 100, y: 100 }, tall, stage)).toEqual({
      scale: 2,
      x: 0,
      y: 100,
    });
  });

  it('pans within the same bounds', () => {
    const at = { scale: 2, x: 0, y: 0 };
    expect(panView(at, 100, -50, fit, stage)).toEqual({ scale: 2, x: 100, y: -50 });
    expect(panView(at, 10_000, 10_000, fit, stage)).toEqual({ scale: 2, x: 500, y: 300 });
  });
});

describe('the focal point', () => {
  it('keeps the point under the pointer under the pointer', () => {
    const focal = { x: 200, y: -100 };
    const max = maxScale(natural, fit);
    const before = { scale: 1.5, x: 30, y: 10 };
    const after = zoomAround(before, 3, focal, fit, stage, max);
    // The picture point under the pointer, before and after.
    const pointBefore = (focal.x - before.x) / before.scale;
    const pointAfter = (focal.x - after.x) / after.scale;
    expect(pointAfter).toBeCloseTo(pointBefore);
    expect((focal.y - after.y) / after.scale).toBeCloseTo((focal.y - before.y) / before.scale);
  });

  it('zooms about the centre when the focal point is the centre', () => {
    expect(zoomAround(FIT_VIEW, 2, { x: 0, y: 0 }, fit, stage, 8)).toEqual({
      scale: 2,
      x: 0,
      y: 0,
    });
  });

  it('is clamped: zooming at a corner never pulls an edge into the stage', () => {
    const corner = zoomAround(FIT_VIEW, 2, { x: 500, y: 300 }, fit, stage, 8);
    expect(corner).toEqual({ scale: 2, x: -500, y: -300 });
  });

  it('comes back to fit, centred, at or below 1', () => {
    expect(zoomAround({ scale: 3, x: 200, y: 50 }, 0.5, { x: 10, y: 10 }, fit, stage, 8)).toEqual(
      FIT_VIEW
    );
  });
});

describe('steps, wheels and clicks', () => {
  it('steps by the same ratio both ways, inside the bounds', () => {
    expect(stepScale(1, 'in', 8)).toBe(1.25);
    expect(stepScale(1.25, 'out', 8)).toBe(1);
    expect(stepScale(1, 'out', 8)).toBe(1);
    expect(stepScale(7.9, 'in', 8)).toBe(8);
  });

  it('takes a pinch continuously and a mouse-wheel notch as one step', () => {
    expect(wheelScale(1, 0, 8)).toBe(1);
    const pinch = wheelScale(1, -10, 8);
    expect(pinch).toBeGreaterThan(1);
    expect(pinch).toBeLessThan(1.25);
    expect(wheelScale(1, -120, 8)).toBe(1.25);
    expect(wheelScale(2, 120, 8)).toBe(1.6);
  });

  it('a click at fit goes to 100% at the point clicked; another comes back', () => {
    const focal = { x: 100, y: 50 };
    const zoomed = toggleView(FIT_VIEW, focal, natural, fit, stage);
    expect(zoomed.scale).toBe(2);
    expect(zoomed.x).toBe(-100);
    expect(zoomed.y).toBe(-50);
    expect(toggleView(zoomed, focal, natural, fit, stage)).toEqual(FIT_VIEW);
  });

  it('a picture already at its own size goes to 2× instead', () => {
    const small = { width: 200, height: 100 };
    const smallFit = fitSize(small, stage);
    expect(toggleView(FIT_VIEW, { x: 0, y: 0 }, small, smallFit, stage).scale).toBe(2);
  });
});
