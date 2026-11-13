import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollsTheChat, useFollowBottom } from './useAgentMotion';
import { useRowAnchoring } from './useRowAnchoring';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A scroller whose geometry the test sets: content `height` tall, a 400px view. */
function scroller(height = 2000) {
  const el = document.createElement('div');
  const content = document.createElement('div');
  el.append(content);
  document.body.append(el);
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - 400));
    },
  });
  // A smooth scroll that never arrives: WebKit dropping it mid-way.
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;
  return { el, content, away: () => height - 400 - top, setTop: (v: number) => (top = v) };
}

describe('useFollowBottom', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  // performance.now() starts at 0 on page load: a chat opened in the first
  // second (the Chief, at launch) must not read that as the reader scrolling.
  it('counts no scroll as the reader’s before any input', () => {
    vi.spyOn(performance, 'now').mockReturnValue(300);
    const { result } = renderHook(() =>
      useFollowBottom({ current: null }, { current: null }, { current: true })
    );
    expect(result.current.readerScrolled()).toBe(false);
  });

  // Observed: a chat at the bottom stopped short of a new approval card.
  it('lands on the bottom when a glide to a new card is cut short', () => {
    vi.useFakeTimers();
    const s = scroller();
    s.setTop(1200);
    const { result } = renderHook(() =>
      useFollowBottom({ current: s.el }, { current: s.content }, { current: true })
    );
    result.current.follow(true);
    expect(s.away()).toBe(400);
    vi.advanceTimersByTime(600);
    expect(s.away()).toBe(0);
  });

  it('leaves the chat where the reader took it during the glide', () => {
    vi.useFakeTimers();
    const s = scroller();
    s.setTop(1200);
    const atBottom = { current: true };
    const { result } = renderHook(() =>
      useFollowBottom({ current: s.el }, { current: s.content }, atBottom)
    );
    result.current.follow(true);
    s.el.dispatchEvent(new WheelEvent('wheel'));
    atBottom.current = false;
    vi.advanceTimersByTime(600);
    expect(s.away()).toBe(400);
  });

  it('counts a press on a card’s button as no scroll, the scrollbar as one', () => {
    const s = scroller();
    const button = document.createElement('button');
    s.content.append(button);
    const { result } = renderHook(() =>
      useFollowBottom({ current: s.el }, { current: s.content }, { current: true })
    );
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(result.current.readerScrolled()).toBe(false);
    s.el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(result.current.readerScrolled()).toBe(true);
  });
});

describe('scrollsTheChat', () => {
  const on = (tag: string) => document.createElement(tag);
  it('is a scrolling key outside a field or button', () => {
    expect(scrollsTheChat({ key: 'PageUp', target: on('div') })).toBe(true);
    expect(scrollsTheChat({ key: 'ArrowUp', target: on('div') })).toBe(true);
    expect(scrollsTheChat({ key: 'a', target: on('div') })).toBe(false);
    expect(scrollsTheChat({ key: 'Enter', target: on('div') })).toBe(false);
    expect(scrollsTheChat({ key: ' ', target: on('button') })).toBe(false);
    expect(scrollsTheChat({ key: 'ArrowUp', target: on('textarea') })).toBe(false);
  });
});

describe('useRowAnchoring', () => {
  it('moves the view for a row above it, but never while following the bottom', () => {
    let report: (entries: unknown[]) => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (entries: unknown[]) => void) {
          report = cb;
        }
        observe() {}
        disconnect() {}
      }
    );
    const s = scroller();
    const row = document.createElement('div');
    s.content.append(row);
    // Wholly above the view.
    row.getBoundingClientRect = () => ({ bottom: -50 }) as DOMRect;
    const following = { current: true };
    renderHook(() => useRowAnchoring({ current: s.el }, { current: s.content }, following, true));
    const resize = (h: number) => report([{ target: row, contentRect: { height: h } }]);
    s.setTop(1600);
    resize(300);
    // A card above folding into a receipt: the bottom stays the bottom.
    resize(100);
    expect(s.away()).toBe(0);
    // Reading up: the row's change is taken out, so the view stays still.
    following.current = false;
    s.setTop(800);
    resize(300);
    expect(s.el.scrollTop).toBe(1000);
  });
});
