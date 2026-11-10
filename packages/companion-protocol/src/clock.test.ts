import { afterEach, describe, expect, it } from 'vitest';
import { clockAt, clockHour24, formatClock, setClockHour24 } from './clock';
import { describeRepeat, formatWhen } from './schedule';

afterEach(() => setClockHour24(null));

describe('the clock', () => {
  it('follows the Mac: 24-hour when it says so', () => {
    setClockHour24(true);
    expect(clockHour24()).toBe(true);
    expect(clockAt(9, 0)).toMatch(/^09[:.]00$/);
    expect(clockAt(17, 30)).toMatch(/^17[:.]30$/);
  });

  it('follows the Mac: 12-hour when it says so', () => {
    setClockHour24(false);
    expect(clockAt(9, 0)).toMatch(/^9[:.]00\s?AM$/i);
    expect(clockAt(0, 5)).toMatch(/^12[:.]05\s?AM$/i);
    expect(clockAt(17, 30)).toMatch(/^5[:.]30\s?PM$/i);
  });

  it('writes a routine the way the Mac writes it, in every sentence', () => {
    const repeat = { kind: 'days' as const, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
    setClockHour24(true);
    expect(describeRepeat(repeat)).toMatch(/at 09[:.]00$/);
    setClockHour24(false);
    expect(describeRepeat(repeat)).toMatch(/at 9[:.]00\s?AM$/i);
    const nine = new Date(2026, 10, 9, 9, 0).getTime();
    expect(formatWhen(nine, nine)).toMatch(/^Today 9[:.]00\s?AM$/i);
    expect(formatClock(nine)).toMatch(/^9[:.]00\s?AM$/i);
  });

  it('leaves it to the locale until the Mac says, and ignores anything else', () => {
    setClockHour24(undefined);
    expect(clockHour24()).toBeNull();
    setClockHour24('yes' as never);
    expect(clockHour24()).toBeNull();
  });
});
