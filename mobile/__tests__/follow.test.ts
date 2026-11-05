/**
 * How a chat follows the conversation (lib/follow.ts): pinned at the newest
 * line until your own finger lets go, a "New" pill for what arrives while
 * you read back, and the keyboard's inset never mistaken for scrolling.
 */

import {
  AT_END,
  endOffset,
  FAR,
  FOLLOWING,
  fromEnd,
  holdFor,
  HOLD,
  newestSignature,
  pillFor,
  scrolled,
  toEnd,
} from '../src/lib/follow';

describe('distance from the newest line', () => {
  it('is the offset with the keyboard down', () => {
    expect(fromEnd(0, 0)).toBe(0);
    expect(fromEnd(240, 0)).toBe(240);
  });

  it('counts from the keyboard-lifted end with the keyboard up', () => {
    // The inverted list's end moves to -inset: there, you're at the newest line.
    expect(fromEnd(-336, 336)).toBe(0);
    expect(fromEnd(-100, 336)).toBe(236);
  });

  it('never goes below zero (a rubber-band past the end)', () => {
    expect(fromEnd(-400, 336)).toBe(0);
  });

  it('scrolls to the keyboard-lifted end, not to 0 behind the keyboard', () => {
    expect(endOffset(0)).toBe(-0);
    expect(endOffset(336)).toBe(-336);
  });
});

describe('following', () => {
  it('starts pinned', () => {
    expect(FOLLOWING.pinned).toBe(true);
    expect(holdFor(FOLLOWING)).toBeUndefined();
  });

  it('lets go only when your finger scrolls back', () => {
    const left = scrolled(FOLLOWING, 200, 'm3', true);
    expect(left).toEqual({ pinned: false, leftAt: 'm3' });
    expect(holdFor(left)).toBe(HOLD);
  });

  it('stays pinned when something else moves the list (keyboard, a card opening, a page arriving)', () => {
    expect(scrolled(FOLLOWING, 336, 'm3', false)).toBe(FOLLOWING);
    expect(scrolled(FOLLOWING, 5000, 'm3', false)).toBe(FOLLOWING);
  });

  it('stays pinned within a finger’s rest of the end', () => {
    expect(scrolled(FOLLOWING, AT_END, 'm3', true)).toBe(FOLLOWING);
  });

  it('pins again on reaching the end, by hand or not', () => {
    const left = scrolled(FOLLOWING, 200, 'm3', true);
    expect(scrolled(left, 0, 'm4', true)).toEqual(FOLLOWING);
    expect(scrolled(left, 10, 'm4', false)).toEqual(FOLLOWING);
  });

  it('keeps what was newest when you left, however far you then scroll', () => {
    const left = scrolled(FOLLOWING, 200, 'm3', true);
    expect(scrolled(left, 900, 'm5', true)).toBe(left);
  });

  it('pins on send or the pill', () => {
    expect(toEnd()).toEqual(FOLLOWING);
  });
});

describe('the newest row’s signature', () => {
  it('changes as a reply is written, so more words count as new', () => {
    const a = newestSignature({ key: 'd1', kind: 'draft', text: 'On it' });
    const b = newestSignature({ key: 'd1', kind: 'draft', text: 'On it. Here' });
    expect(a).not.toBe(b);
  });

  it('is the key for a message', () => {
    expect(newestSignature({ key: 'm9', kind: 'message' })).toBe('m9');
  });

  it('changes when the working line says something new', () => {
    expect(newestSignature({ key: 'working', kind: 'working', label: 'Reading' })).not.toBe(
      newestSignature({ key: 'working', kind: 'working', label: 'Editing' })
    );
  });

  it('is null for an empty chat', () => {
    expect(newestSignature(undefined)).toBeNull();
  });
});

describe('the pill', () => {
  const left = scrolled(FOLLOWING, 200, 'd1:40', true);

  it('never shows while pinned', () => {
    expect(pillFor(FOLLOWING, 0, 'x', true)).toBeNull();
  });

  it('says nothing just after letting go, close to the end, with nothing new', () => {
    expect(pillFor(left, 200, 'd1:40', false)).toBeNull();
  });

  it('says New once a reply grows or a message arrives below', () => {
    expect(pillFor(left, 200, 'd1:85', false)).toEqual({ says: 'new' });
    expect(pillFor(left, 200, 'm7', false)).toEqual({ says: 'new' });
  });

  it('is a bare arrow far back with nothing new', () => {
    expect(pillFor(left, FAR + 1, 'd1:40', false)).toEqual({ says: null });
  });

  it('puts a card waiting on you first', () => {
    expect(pillFor(left, 200, 'm7', true)).toEqual({ says: 'urgent' });
  });
});
