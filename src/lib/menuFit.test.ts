import { describe, expect, it } from 'vitest';
import { fitMenu, fitMenuX } from './menuFit';

describe('fitMenuX', () => {
  // A 900px window; the conversation switcher's 320px menu.
  it('opens from the trigger’s left edge when it fits', () => {
    expect(fitMenuX({ left: 300, right: 340 }, 900, 320, 'left')).toEqual({ left: 300 });
  });

  it('lines up with the trigger’s right edge rather than run off the window', () => {
    // The icon-only trigger beside Usage: left-aligned, 320px ran past 900.
    expect(fitMenuX({ left: 700, right: 740 }, 900, 320, 'left')).toEqual({ right: 160 });
  });

  it('keeps a right-aligned menu right-aligned while it fits, else flips left', () => {
    expect(fitMenuX({ left: 700, right: 740 }, 900, 320, 'right')).toEqual({ right: 160 });
    expect(fitMenuX({ left: 20, right: 60 }, 900, 320, 'right')).toEqual({ left: 20 });
  });

  it('holds a menu wider than either side 8px inside the window', () => {
    expect(fitMenuX({ left: 150, right: 190 }, 400, 320, 'left')).toEqual({ left: 72 });
    expect(fitMenuX({ left: 150, right: 190 }, 300, 320, 'left')).toEqual({ left: 8 });
  });

  // Issue #10: a 1000px window, the chat from 220 to 1000 beside the sidebar,
  // and your long message's … at the chat's left edge.
  const chat = { left: 220, right: 1000 };

  it('flips a right-aligned menu rather than open over the sidebar', () => {
    // The window alone had room on the left (252 - 240 >= 8): under the sidebar.
    expect(fitMenuX({ left: 228, right: 252 }, 1000, 240, 'right')).toEqual({ right: 748 });
    expect(fitMenuX({ left: 228, right: 252 }, 1000, 240, 'right', chat)).toEqual({ left: 228 });
  });

  it('holds a menu 8px inside the area when the trigger sits on its edge', () => {
    expect(fitMenuX({ left: 210, right: 230 }, 1000, 240, 'right', chat)).toEqual({ left: 228 });
    expect(fitMenuX({ left: 960, right: 1000 }, 1000, 240, 'left', chat)).toEqual({ right: 8 });
  });

  it('keeps a menu wider than the area against its left edge', () => {
    expect(fitMenuX({ left: 300, right: 320 }, 1000, 900, 'left', chat)).toEqual({ left: 228 });
  });
});

// A 900px window; the chat header's trigger sits at the top.
const header = { top: 10, bottom: 40 };

describe('fitMenu', () => {
  it('opens below and keeps its own height when it fits', () => {
    const { side, maxHeight } = fitMenu(header, 900, 300, 'bottom');
    expect(side).toBe('bottom');
    expect(maxHeight).toBeGreaterThanOrEqual(300);
  });

  it('never runs past the bottom edge: a long menu is capped at the room below', () => {
    // The 25-item menu that ran off a 900px window.
    const { side, maxHeight } = fitMenu(header, 900, 1200, 'bottom');
    expect(side).toBe('bottom');
    expect(header.bottom + 6 + maxHeight).toBeLessThanOrEqual(900);
  });

  it('flips up when the room below is short and above has more', () => {
    const trigger = { top: 800, bottom: 830 };
    const { side, maxHeight } = fitMenu(trigger, 900, 400, 'bottom');
    expect(side).toBe('top');
    expect(maxHeight).toBeLessThanOrEqual(trigger.top);
    expect(maxHeight).toBeGreaterThanOrEqual(400);
  });

  it('stays on the side asked for when the other has no more room', () => {
    const trigger = { top: 430, bottom: 460 };
    expect(fitMenu(trigger, 900, 1000, 'bottom').side).toBe('bottom');
    expect(fitMenu(trigger, 900, 200, 'top').side).toBe('top');
  });
});
