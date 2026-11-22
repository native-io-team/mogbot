import { forgetDates, formatDate } from '../src/lib/agents';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();

describe('a date is written out once', () => {
  const written = jest.spyOn(Date.prototype, 'toLocaleDateString');
  beforeEach(() => {
    forgetDates();
    written.mockClear();
  });
  afterAll(() => written.mockRestore());

  it('the same day, however often and at whatever time, is one formatting', () => {
    const now = at(2026, 10, 22);
    const words = formatDate(at(2026, 10, 4, 9), now);
    expect(formatDate(at(2026, 10, 4, 23), now)).toBe(words);
    expect(written).toHaveBeenCalledTimes(1);
  });

  it('another day, and the same day seen from another year, are their own', () => {
    const now = at(2026, 10, 22);
    const a = formatDate(at(2026, 10, 4), now);
    expect(formatDate(at(2026, 10, 5), now)).not.toBe(a);
    const later = formatDate(at(2026, 10, 4), at(2027, 0, 2));
    expect(later).not.toBe(a);
    expect(later).toContain('2026');
    expect(written).toHaveBeenCalledTimes(3);
  });

  it('is written again after the app comes forward, in whatever language it is now', () => {
    const now = at(2026, 10, 22);
    formatDate(at(2026, 10, 4), now);
    written.mockReturnValueOnce('4 nov.');
    expect(formatDate(at(2026, 10, 4), now)).not.toBe('4 nov.');
    forgetDates();
    expect(formatDate(at(2026, 10, 4), now)).toBe('4 nov.');
  });
});
