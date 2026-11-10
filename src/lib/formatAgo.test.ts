import { describe, expect, it } from 'vitest';
import { formatAge, formatAgo } from './formatAgo';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatAge / formatAgo', () => {
  it('never produces "now ago"', () => {
    const now = 1_000_000_000;
    expect(formatAge(now, now)).toBe('now');
    expect(formatAgo(now, now)).toBe('just now');
    expect(formatAgo(now - 18 * MINUTE, now)).toBe('18m ago');
    expect(formatAgo(now - 3 * HOUR, now)).toBe('3h ago');
    expect(formatAgo(now - 2 * DAY, now)).toBe('2d ago');
    expect(formatAgo(now - 14 * DAY, now)).toBe('2w ago');
  });

  it('clamps a clock-skewed future timestamp to "now"', () => {
    const now = 1_000_000_000;
    expect(formatAge(now + 5 * MINUTE, now)).toBe('now');
  });
});
