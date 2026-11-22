import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevServerLogs } from './DevServerLogs';
import { loadNerdFonts } from '../../lib/fonts';

// The log terminal itself is out of scope here: only the wait for the pane's
// box, and what happens when it arrives, is under test.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return new Proxy(
        {},
        { get: () => () => ({ dispose() {}, onData: () => ({ dispose() {} }) }) }
      );
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));
vi.mock('../../lib/terminalLinks', () => ({ createWebLinksAddon: () => ({ dispose() {} }) }));
vi.mock('../../lib/fonts', () => ({ loadNerdFonts: vi.fn(() => Promise.resolve()) }));
vi.mock('../../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.mocked(loadNerdFonts).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DevServerLogs waits for its pane without polling frames', () => {
  it('asks for no animation frame while the pane has no box, and starts once it has one', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(
      <DevServerLogs
        output=""
        outputVersion={0}
        onSendToAgent={() => {}}
        onInput={() => {}}
        onResize={() => {}}
      />
    );
    const hidden = container.querySelector<HTMLElement>('.dev-server-logs-terminal')!;
    // jsdom gives it no box: a hidden pane reports a zero-size layout box.
    hidden.style.display = 'none';
    expect(getComputedStyle(hidden).display).toBe('none');
    expect(hidden.getBoundingClientRect().width).toBe(0);
    expect(hidden.getBoundingClientRect().height).toBe(0);

    await act(() => Promise.resolve());
    // Red if frame polling comes back: an empty pane would request a frame.
    expect(frames).not.toHaveBeenCalled();
    expect(loadNerdFonts).not.toHaveBeenCalled();

    // The pane gets its box: the observer reports it and the terminal starts.
    hidden.style.display = '';
    hidden.getBoundingClientRect = () =>
      ({ width: 640, height: 300, top: 0, left: 0, right: 640, bottom: 300 }) as DOMRect;
    act(() => {
      for (const cb of resizeCallbacks) cb();
    });
    await act(() => Promise.resolve());
    expect(loadNerdFonts).toHaveBeenCalledTimes(1);
  });
});
