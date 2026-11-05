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

  it('a pointer that went down without focus is a focus click', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    pointerDown();
    expect(isFocusClick({ detail: 1 })).toBe(true);
  });

  it('a keyboard activation never is', () => {
    window.dispatchEvent(new Event('focus'));
    pointerDown();
    expect(isFocusClick({ detail: 0 })).toBe(false);
  });
});
