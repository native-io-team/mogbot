import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_GRACE_MS, __resetFirstClick, isFocusClick } from './firstClick';

afterEach(() => {
  vi.restoreAllMocks();
  __resetFirstClick();
});

const pointerDown = () => window.dispatchEvent(new Event('pointerdown'));

describe('isFocusClick', () => {
  it('the click that brought the window forward is a focus click', () => {
    window.dispatchEvent(new Event('focus'));
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(true);
  });

  it('a click well after focus acts', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    window.dispatchEvent(new Event('focus'));
    now.mockReturnValue(1000 + FOCUS_GRACE_MS + 1);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(false);
  });

  it('a pointer that went down while the window was in the background is a focus click', () => {
    window.dispatchEvent(new Event('blur'));
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(true);
  });

  it('a window in front acts even when the document says it has no focus', () => {
    // WKWebView answers hasFocus() false now and then with the window in front:
    // that ate clicks on Keep changes. Only blur and focus decide it.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(false);
  });

  it('back in front, past the grace, a click acts', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(5000);
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    now.mockReturnValue(5000 + FOCUS_GRACE_MS + 1);
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(false);
  });

  it('a keyboard activation never is', () => {
    window.dispatchEvent(new Event('focus'));
    pointerDown();
    expect(isFocusClick({ detail: 0 })).toBe(false);
  });
});
