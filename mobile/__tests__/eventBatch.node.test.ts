import { BEAT_MS, HOLD_MS, createEventBatch } from '../src/lib/eventBatch';

function setup(apply?: (e: number[]) => void) {
  const errors: unknown[] = [];
  const where = { away: false };
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const applied: number[][] = [];
  const batch = createEventBatch<number>(apply ?? ((e) => applied.push(e)), {
    now: () => now,
    away: () => where.away,
    onError: (x) => errors.push(x),
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      timers = timers.filter((x) => x !== t);
    },
  });
  const pass = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  };
  return { batch, applied, pass, errors, where, timers: () => timers.length };
}

describe('the event batch', () => {
  it('applies everything missed as one update, at caught up', () => {
    const { batch, applied, pass } = setup();
    batch.hold();
    for (let i = 0; i < 1180; i++) batch.add(i);
    pass(BEAT_MS * 2);
    expect(applied).toEqual([]);
    batch.release();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(1180);
  });

  it('shows progress on a slow link, and never holds past HOLD_MS', () => {
    const { batch, applied, pass } = setup();
    batch.hold();
    batch.add(1);
    pass(HOLD_MS);
    batch.add(2);
    expect(applied).toEqual([[1]]);
    pass(HOLD_MS);
    expect(applied).toEqual([[1], [2]]);
  });

  it('lets the first live event straight through, and keeps the rest for the beat', () => {
    const { batch, applied, pass } = setup();
    pass(1000);
    batch.add(1);
    expect(applied).toEqual([[1]]);
    batch.add(2);
    batch.add(3);
    pass(BEAT_MS - 1);
    expect(applied).toHaveLength(1);
    pass(1);
    expect(applied).toEqual([[1], [2, 3]]);
  });

  it('an answer is never handled before what it caused', () => {
    const { batch, applied, timers } = setup();
    batch.add(1);
    batch.add(2);
    batch.flush();
    expect(applied.flat()).toEqual([1, 2]);
    expect(timers()).toBe(0);
  });

  it('drops what waits for another Mac', () => {
    const { batch, applied, pass, timers } = setup();
    batch.hold();
    batch.add(1);
    batch.clear();
    expect(timers()).toBe(0);
    pass(HOLD_MS);
    expect(applied).toEqual([]);
  });

  it('an event added while applying waits its turn, in order', () => {
    let batch: ReturnType<typeof createEventBatch<number>> | null = null;
    const seen: number[] = [];
    batch = createEventBatch<number>(
      (e) => {
        seen.push(...e);
        if (e.includes(1)) batch!.add(9);
      },
      { beatMs: 0 }
    );
    batch.add(1);
    expect(seen).toEqual([1, 9]);
  });

  it('an error in applying never leaves the beat, the hold, or whoever flushes', () => {
    const { batch, pass, errors } = setup(() => {
      throw new Error('apply');
    });
    batch.add(1);
    batch.add(2);
    expect(() => pass(BEAT_MS)).not.toThrow();
    batch.hold();
    batch.add(3);
    expect(() => pass(HOLD_MS)).not.toThrow();
    batch.add(4);
    expect(() => batch.flush()).not.toThrow();
    batch.add(5);
    expect(() => batch.release()).not.toThrow();
    expect(errors).toHaveLength(5);
  });

  it('put away, nothing waits for a timer', () => {
    const { batch, applied, where, timers } = setup();
    where.away = true;
    batch.add(1);
    batch.add(2);
    batch.add(3);
    expect(applied).toEqual([[1], [2], [3]]);
    expect(timers()).toBe(0);
  });

  it('put away while catching up, it is still one update', () => {
    const { batch, applied, where } = setup();
    where.away = true;
    batch.hold();
    batch.add(1);
    batch.add(2);
    expect(applied).toEqual([]);
    batch.release();
    expect(applied).toEqual([[1, 2]]);
  });
});
