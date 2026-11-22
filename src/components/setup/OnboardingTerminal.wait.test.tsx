import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingTerminal } from './OnboardingTerminal';
import { loadNerdFonts } from '../../lib/fonts';

// The terminal itself is out of scope here: only the wait for the pane's box,
// and what happens when it arrives, is under test.
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
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    dispose() {}
  },
}));
vi.mock('../../lib/terminalLinks', () => ({ createWebLinksAddon: () => ({ dispose() {} }) }));
vi.mock('../../lib/fonts', () => ({ loadNerdFonts: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(() => Promise.resolve('/home')) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(() => Promise.resolve([])),
  exists: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../../lib/onboardingPty', () => ({
  spawnOnboardingPty: vi.fn(() =>
    Promise.resolve({ write() {}, resize() {}, kill() {}, onData() {} })
  ),
}));
vi.mock('../../lib/project', () => ({
  getSystemEnv: vi.fn(() => Promise.resolve({})),
  getShellPath: vi.fn(() => Promise.resolve('')),
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

describe('OnboardingTerminal waits for its pane without polling frames', () => {
  it('asks for no animation frame while the pane has no box, and starts once it has one', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(
      <OnboardingTerminal command="sh" args={[]} cwd="/" onExit={() => {}} onOutput={() => {}} />
    );
    const pane = container.querySelector<HTMLElement>('.onboarding-terminal-container')!;
    // jsdom gives it no box: a hidden pane reports a zero-size layout box.
    pane.style.display = 'none';
    expect(getComputedStyle(pane).display).toBe('none');
    expect(pane.getBoundingClientRect().width).toBe(0);
    expect(pane.getBoundingClientRect().height).toBe(0);

    await act(() => Promise.resolve());
    // Red if frame polling comes back: the pane is still empty, so a poll
    // would request a frame and nothing else.
    expect(frames).not.toHaveBeenCalled();
    expect(loadNerdFonts).not.toHaveBeenCalled();

    // The pane gets its box: the observer reports it and the terminal starts.
    pane.style.display = '';
    pane.getBoundingClientRect = () =>
      ({ width: 640, height: 300, top: 0, left: 0, right: 640, bottom: 300 }) as DOMRect;
    act(() => {
      for (const cb of resizeCallbacks) cb();
    });
    await act(() => Promise.resolve());
    expect(loadNerdFonts).toHaveBeenCalledTimes(1);
  });
});
