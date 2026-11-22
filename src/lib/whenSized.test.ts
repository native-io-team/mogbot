import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenSized } from './whenSized';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An element whose box the test sets, and a ResizeObserver the test fires. */
function hiddenPane() {
  const el = document.createElement('div');
  let size = { width: 0, height: 0 };
  el.getBoundingClientRect = () => ({ ...size, left: 0, top: 0, right: 0, bottom: 0 }) as DOMRect;
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {
        observers.length = 0;
      }
    }
  );
  return {
    el,
    show: (w: number, h: number) => {
      size = { width: w, height: h };
      for (const cb of observers) cb();
    },
  };
}

describe('whenSized', () => {
  it('asks for no animation frames while the pane has no box', () => {
    const frame = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', frame);
    const pane = hiddenPane();
    const onSized = vi.fn();
    whenSized(pane.el, onSized);
    expect(frame).not.toHaveBeenCalled();
    expect(onSized).not.toHaveBeenCalled();
  });

  it('runs once, when the pane gets a box, and stops observing', () => {
    const pane = hiddenPane();
    const onSized = vi.fn();
    whenSized(pane.el, onSized);
    pane.show(0, 0);
    expect(onSized).not.toHaveBeenCalled();
    pane.show(640, 300);
    pane.show(700, 300);
    expect(onSized).toHaveBeenCalledTimes(1);
  });

  it('runs at once for a pane that is already sized', () => {
    const pane = hiddenPane();
    pane.show(640, 300);
    const onSized = vi.fn();
    whenSized(pane.el, onSized);
    expect(onSized).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when cleaned up', () => {
    const pane = hiddenPane();
    const onSized = vi.fn();
    const stop = whenSized(pane.el, onSized);
    stop();
    pane.show(640, 300);
    expect(onSized).not.toHaveBeenCalled();
  });
});
