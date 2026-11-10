import { describe, expect, it } from 'vitest';
import {
  apiPrice,
  onClaudePlan,
  quotaLines,
  readPhrase,
  resetDay,
  resetPhrase,
  retryPhrase,
  routineWeekLine,
  sumTotals,
  windowName,
} from './quota';
import type { Quota, QuotaWindow, UsageTotals } from './model';

// A Thursday, 2 PM local.
const NOW = new Date(2026, 10, 5, 14, 0).getTime();
const HOUR = 3_600_000;

const win = (over: Partial<QuotaWindow>): QuotaWindow => ({
  kind: 'seven_day',
  limited: false,
  observedAt: NOW - HOUR,
  ...over,
});
const claude = (...windows: QuotaWindow[]): Quota => ({ engine: 'claude', windows });

describe('reset wording', () => {
  it('never says a weekly reset as a time today', () => {
    const today = new Date(2026, 10, 5, 17, 0).getTime();
    const tomorrow = new Date(2026, 10, 6, 9, 0).getTime();
    const saturday = new Date(2026, 10, 7, 10, 0).getTime();
    const later = new Date(2026, 10, 20, 10, 0).getTime();
    expect(resetDay(today, NOW)).toMatch(/5:00/);
    expect(resetDay(tomorrow, NOW)).toBe('tomorrow');
    expect(resetDay(saturday, NOW)).toMatch(/Sat/);
    expect(resetDay(later, NOW)).toMatch(/Nov/);
    expect(resetPhrase(tomorrow, NOW)).toMatch(/^tomorrow 9:00/);
    expect(resetPhrase(saturday, NOW)).toMatch(/Sat.*10:00/);
    expect(retryPhrase(today, NOW)).toMatch(/^at 5:00/);
    expect(retryPhrase(saturday, NOW)).toMatch(/^Sat.*10:00/);
  });

  it('names windows in words', () => {
    expect(windowName({ kind: 'five_hour' })).toBe('5-hour');
    expect(windowName({ kind: 'primary', windowMinutes: 10080 })).toBe('weekly');
    expect(windowName({ kind: 'primary', windowMinutes: 300 })).toBe('5-hour');
    expect(windowName({ kind: 'mystery_window' })).toBe('mystery window');
  });
});

describe('quotaLines', () => {
  const saturday = new Date(2026, 10, 7, 10, 0).getTime();

  it('shows nothing when nothing was reported', () => {
    expect(quotaLines([], NOW)).toEqual([]);
    expect(quotaLines([claude()], NOW)).toEqual([]);
    // A window with no figure that isn't used up says nothing either.
    expect(quotaLines([claude(win({ resetsAt: saturday }))], NOW)).toEqual([]);
  });

  it('says the fullest window, calm below 90%', () => {
    const [line] = quotaLines(
      [
        claude(
          win({ usedPercent: 85, resetsAt: saturday }),
          win({ kind: 'five_hour', usedPercent: 12, resetsAt: NOW + HOUR })
        ),
      ],
      NOW
    );
    expect(line.text).toMatch(/^Claude usage 85% · refills Sat/);
    expect(line.tone).toBe('calm');
    expect(line.detail).toMatch(/weekly limit/);
  });

  it('turns amber at 90% and floors the figure', () => {
    const [at] = quotaLines([claude(win({ usedPercent: 90, resetsAt: saturday }))], NOW);
    expect(at.tone).toBe('warning');
    const [under] = quotaLines([claude(win({ usedPercent: 89.9, resetsAt: saturday }))], NOW);
    expect(under.text).toMatch(/usage 89%/);
    expect(under.tone).toBe('calm');
  });

  it('a used-up window wins, with when it lifts', () => {
    const [line] = quotaLines(
      [
        claude(
          win({ usedPercent: 40, resetsAt: saturday }),
          win({ kind: 'five_hour', limited: true, resetsAt: NOW + 3 * HOUR })
        ),
      ],
      NOW
    );
    expect(line.tone).toBe('limited');
    expect(line.text).toMatch(/^Claude out of usage until 5:00/);
    const [bare] = quotaLines([claude(win({ limited: true }))], NOW);
    expect(bare.text).toBe('Claude out of usage');
  });

  it('says how old a reading is: its day in the tooltip, its age on the line after 6 h', () => {
    // An hour old, today: the time alone, and no age on the line.
    const [fresh] = quotaLines([claude(win({ usedPercent: 34, resetsAt: saturday }))], NOW);
    expect(fresh.detail).toMatch(/reported it at \d/);
    expect(fresh.text).not.toMatch(/read/);
    // Seven hours old, still today: the line says when.
    const [today] = quotaLines(
      [claude(win({ usedPercent: 34, resetsAt: saturday, observedAt: NOW - 7 * HOUR }))],
      NOW
    );
    expect(today.text).toMatch(/^Claude usage 34% · refills Sat · read 7:00/);
    // Read Tuesday: the day, in both.
    const tuesday = new Date(2026, 10, 3, 15, 0).getTime();
    const [old] = quotaLines(
      [claude(win({ usedPercent: 34, resetsAt: saturday, observedAt: tuesday }))],
      NOW
    );
    expect(old.text).toMatch(/· read Tue$/);
    expect(old.detail).toMatch(/reported it Tue at 3:00/);
    expect(readPhrase(NOW - 24 * HOUR, NOW)).toMatch(/^yesterday at 2:00/);
    expect(readPhrase(new Date(2026, 9, 20, 9, 0).getTime(), NOW)).toMatch(/^on Oct 20 at 9:00/);
    // A used-up window stays used up until its reset: no age needed.
    const [limit] = quotaLines(
      [claude(win({ limited: true, resetsAt: saturday, observedAt: tuesday }))],
      NOW
    );
    expect(limit.text).not.toMatch(/read/);
  });

  it('drops windows past their reset, and names each engine', () => {
    expect(quotaLines([claude(win({ usedPercent: 99, resetsAt: NOW - 1 }))], NOW)).toEqual([]);
    const lines = quotaLines(
      [
        claude(win({ usedPercent: 20, resetsAt: saturday })),
        {
          engine: 'codex',
          windows: [
            win({ kind: 'primary', usedPercent: 95, windowMinutes: 300, resetsAt: NOW + HOUR }),
          ],
        },
      ],
      NOW
    );
    expect(lines.map((l) => [l.engine, l.tone])).toEqual([
      ['claude', 'calm'],
      ['codex', 'warning'],
    ]);
    expect(lines[1].text).toMatch(/^Codex usage 95%/);
  });
});

describe('routineWeekLine', () => {
  const t = (over: Partial<UsageTotals>): UsageTotals => ({
    turns: 2,
    inputTokens: 30_000,
    outputTokens: 8_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.84,
    pricedTurns: 2,
    durationMs: 0,
    ...over,
  });
  it('a cost only when every run reported one, else tokens, else nothing', () => {
    expect(routineWeekLine(t({}))).toBe('$0.84 at API prices this week');
    expect(routineWeekLine(t({ costUsd: 0.004 }))).toBe('<$0.01 at API prices this week');
    expect(routineWeekLine(t({ pricedTurns: 0, costUsd: 0 }))).toBe('38k tokens this week');
    expect(routineWeekLine(t({ pricedTurns: 1 }))).toBe('38k tokens this week');
    expect(routineWeekLine(t({ turns: 0 }))).toBeNull();
    expect(routineWeekLine(undefined)).toBeNull();
  });

  it('on a Claude plan, tokens instead of a list price that is not the bill', () => {
    expect(routineWeekLine(t({}), true)).toBe('38k tokens this week');
    expect(apiPrice(0.84)).toBe('$0.84 at API prices');
    const plan = quotaLines(
      [claude(win({ usedPercent: 20, resetsAt: new Date(2026, 10, 7, 10, 0).getTime() }))],
      NOW
    );
    expect(onClaudePlan(plan)).toBe(true);
    expect(onClaudePlan([])).toBe(false);
    expect(onClaudePlan([{ engine: 'codex' }])).toBe(false);
  });

  it('sums routines, keeping an unpriced one from passing as priced', () => {
    expect(sumTotals([])).toBeUndefined();
    const both = sumTotals([t({}), t({ pricedTurns: 0, costUsd: 0 })]);
    expect(both?.turns).toBe(4);
    expect(both?.pricedTurns).toBe(2);
    expect(routineWeekLine(both)).toBe('76k tokens this week');
  });
});
