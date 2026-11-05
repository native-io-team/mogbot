import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFollowBottom } from './useAgentMotion';

describe('useFollowBottom', () => {
  // performance.now() starts at 0 on page load: a chat opened in the first
  // second (the Chief, at launch) must not read that as the reader scrolling.
  it('counts no scroll as the reader’s before any input', () => {
    vi.spyOn(performance, 'now').mockReturnValue(300);
    const { result } = renderHook(() =>
      useFollowBottom({ current: null }, { current: null }, { current: true })
    );
    expect(result.current.readerScrolled()).toBe(false);
    vi.restoreAllMocks();
  });
});
