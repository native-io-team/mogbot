import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAVE_MS,
  flushChatRestore,
  keepDraft,
  keepReadTo,
  readTo,
  resetChatRestoreForTests,
  unsentDraft,
} from './chatRestore';

/** What the next launch reads: storage written, memory gone. */
function relaunch() {
  flushChatRestore();
  resetChatRestoreForTests();
}

describe('chatRestore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetChatRestoreForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps unsent text across a restart, multibyte text included', () => {
    keepDraft('a1', 'Press ⌘K, then 日本語 🙂');
    keepDraft('room:r1', 'for the room');
    relaunch();
    expect(unsentDraft('a1')).toBe('Press ⌘K, then 日本語 🙂');
    expect(unsentDraft('room:r1')).toBe('for the room');
    expect(unsentDraft('a2')).toBe('');
  });

  it('writes a moment after typing stops, without waiting for a quit', () => {
    vi.useFakeTimers();
    keepDraft('a1', 'half a sent');
    expect(localStorage.getItem('shipstudio.agents.drafts')).toBeNull();
    vi.advanceTimersByTime(SAVE_MS);
    // A crash now still finds it.
    resetChatRestoreForTests();
    expect(unsentDraft('a1')).toBe('half a sent');
  });

  it('forgets a draft once it is sent (emptied)', () => {
    keepDraft('a1', 'hello');
    keepDraft('a1', '');
    relaunch();
    expect(unsentDraft('a1')).toBe('');
  });

  it('remembers where a chat was read to, and that the newest line is no place', () => {
    keepReadTo('a1', { id: 'm-12', offset: -40 });
    keepReadTo('a2', { id: 'm-3', offset: 8 });
    keepReadTo('a2', null);
    relaunch();
    expect(readTo('a1')).toEqual({ id: 'm-12', offset: -40 });
    expect(readTo('a2')).toBeNull();
  });

  it('reads nothing from storage that is broken or the wrong shape', () => {
    localStorage.setItem('shipstudio.agents.drafts', '{not json');
    localStorage.setItem(
      'shipstudio.agents.readTo',
      JSON.stringify({ a1: { v: { id: 3, offset: 'x' }, at: 1 }, a2: { v: null, at: 1 } })
    );
    expect(unsentDraft('a1')).toBe('');
    expect(readTo('a1')).toBeNull();
    expect(readTo('a2')).toBeNull();
    // And it still keeps new ones.
    keepDraft('a1', 'fresh');
    relaunch();
    expect(unsentDraft('a1')).toBe('fresh');
  });

  it('keeps only the most recent chats', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 80; i++) {
      vi.setSystemTime(1_000 + i);
      keepDraft(`a${i}`, `draft ${i}`);
    }
    relaunch();
    expect(unsentDraft('a79')).toBe('draft 79');
    expect(unsentDraft('a0')).toBe('');
  });

  it('works without storage at all', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    keepDraft('a1', 'in memory still');
    expect(unsentDraft('a1')).toBe('in memory still');
    expect(() => flushChatRestore()).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});
