import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUEUE_HINT_LEARNED_AFTER,
  noteQueueHintUse,
  queueHintLearned,
  readQueueHintUses,
} from './queueHint';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the queue caption is learned, then quiet', () => {
  it('counts each kind and is learned only once both reach the bar', () => {
    for (let i = 0; i < QUEUE_HINT_LEARNED_AFTER; i++) noteQueueHintUse(false);
    expect(queueHintLearned()).toBe(false);
    for (let i = 0; i < QUEUE_HINT_LEARNED_AFTER - 1; i++) noteQueueHintUse(true);
    expect(queueHintLearned()).toBe(false);
    noteQueueHintUse(true);
    expect(queueHintLearned()).toBe(true);
  });

  it('reads garbage or a throwing store as never used', () => {
    localStorage.setItem('shipstudio.agents.queueHint', '{ nope');
    expect(readQueueHintUses()).toEqual({ queued: 0, now: 0 });
    localStorage.setItem('shipstudio.agents.queueHint', '{"queued":-4,"now":"9"}');
    expect(readQueueHintUses()).toEqual({ queued: 0, now: 0 });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(queueHintLearned()).toBe(false);
    expect(() => noteQueueHintUse(true)).not.toThrow();
  });
});
