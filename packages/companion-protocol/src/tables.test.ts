import { describe, expect, it } from 'vitest';
import { columnAlign, isFigure, numericColumns } from './tables';

describe('figures in table cells', () => {
  it('reads amounts, counts, percentages and multiples as figures', () => {
    for (const t of ['42', '$5,350', '-12%', '+3.5', '1.2k', '€1 200', '(40)', '3×', '0.75', '−8 pp']) {
      expect(isFigure(t), t).toBe(true);
    }
  });

  it('leaves words, dates and times alone', () => {
    for (const t of ['Acme', '2026-01-05', '10:30', 'Q3', 'v2.1 beta', 'about 40', '', '4 hours']) {
      expect(isFigure(t), t).toBe(false);
    }
  });
});

describe('numeric columns', () => {
  const rows = [
    ['Invoice 1042', 'Acme', '$2,100', '30', '—'],
    ['Invoice 1043', 'Lumen', '$3,250', '45', '12%'],
  ];

  it('is every body cell a figure, blanks and dashes aside', () => {
    expect(numericColumns(rows, 5)).toEqual([false, false, true, true, true]);
  });

  it('needs at least one figure', () => {
    expect(numericColumns([['—'], ['']], 1)).toEqual([false]);
  });

  it('keeps an alignment the author wrote, and right-aligns figures otherwise', () => {
    expect(columnAlign([null, 'center', null, 'left', null], rows)).toEqual([
      null,
      'center',
      'right',
      'left',
      'right',
    ]);
  });
});
