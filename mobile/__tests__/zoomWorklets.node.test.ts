/**
 * The zoom maths as the UI runtime runs it (see ./uiRuntime): each exported
 * worklet, rebuilt from its code string, must give the JS-thread answer.
 * `clampScale(s)` leaning on `max = MAX_ZOOM` threw there, and the pinch's
 * settle took the app down with it (6 Nov).
 */

import * as zoom from '../src/lib/zoom';
import { isWorklet, onUiRuntime, type Worklet } from './uiRuntime';

const screen = { width: 400, height: 800 };
const content = { width: 400, height: 200 };

/** Every way the viewer calls the maths, including leaning on default arguments. */
const calls: Record<string, unknown[][]> = {
  isZoomed: [[1], [2.5]],
  fitSize: [[{ width: 2000, height: 1000 }, screen], [{ width: 0, height: 0 }, screen]],
  clampScale: [[0.4], [3], [9], [Number.NaN], [9, 6]],
  offsetLimit: [[400, 3, 400], [200, 1, 800]],
  clampOffset: [[500, 100], [-0, 0]],
  dragBy: [[100, 10, 100], [0, 10, 100]],
  zoomOffset: [[0, 1, 2, 50], [10, 1, 2, 50, 80], [0, 0, 2, 50]],
  doubleTapTarget: [[1, { x: 100, y: 50 }, content, screen], [3, { x: 0, y: 0 }, content, screen]],
  pageAfterSwipe: [[1, -200, 0, 400, 3], [0, 300, 0, 400, 3]],
  pageDrag: [[0, 50, 3], [1, 50, 3]],
  shouldClose: [[130, 0], [10, 900], [10, 0]],
};

describe('zoom worklets on the UI runtime', () => {
  const worklets = (Object.entries(zoom) as [string, unknown][]).filter(
    (entry): entry is [string, Worklet] => typeof entry[1] === 'function'
  );
  const call = (fn: Worklet, args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

  it('are all worklets, and all exercised here', () => {
    expect(worklets.length).toBeGreaterThan(0);
    for (const [name, fn] of worklets) {
      expect({ name, worklet: isWorklet(fn) }).toEqual({ name, worklet: true });
      expect({ name, covered: name in calls }).toEqual({ name, covered: true });
    }
  });

  it.each(worklets)('%s gives the JS-thread answer', (name, fn) => {
    const ui = onUiRuntime(fn);
    for (const args of calls[name] ?? []) {
      expect({ name, args, out: call(ui, args) }).toEqual({ name, args, out: call(fn, args) });
    }
  });
});
