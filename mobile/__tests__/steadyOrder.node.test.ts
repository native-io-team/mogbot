/** The Projects list holds still while agents work (lib/steadyOrder.ts). */

import { steadyOrder } from '../src/lib/steadyOrder';

describe('steadyOrder', () => {
  it('takes the ranking the first time', () => {
    expect(steadyOrder([], ['b', 'a'])).toEqual(['b', 'a']);
  });

  it('keeps places when only activity changes', () => {
    expect(steadyOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('re-ranks when asked (back on screen, pulled)', () => {
    expect(steadyOrder(['a', 'b'], ['b', 'a'], { fresh: true })).toEqual(['b', 'a']);
  });

  it('re-ranks at once when something new waits on you', () => {
    expect(
      steadyOrder(['a', 'b'], ['b', 'a'], { urgent: new Set(['b']), wasUrgent: new Set() })
    ).toEqual(['b', 'a']);
  });

  it('does not re-rank for something already waiting', () => {
    const waiting = new Set(['b']);
    expect(steadyOrder(['a', 'b'], ['b', 'a'], { urgent: waiting, wasUrgent: waiting })).toEqual([
      'a',
      'b',
    ]);
  });

  it('places a newcomer where the ranking puts it, and drops a gone one', () => {
    expect(steadyOrder(['a', 'b', 'c'], ['a', 'n', 'c'])).toEqual(['a', 'n', 'c']);
    expect(steadyOrder(['a', 'b'], ['b', 'a', 'z'])).toEqual(['a', 'b', 'z']);
  });
});
