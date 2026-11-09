import { describe, expect, it } from 'vitest';
import { fitMenu } from './menuFit';

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
