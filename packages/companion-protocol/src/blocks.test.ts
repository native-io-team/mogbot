import { describe, expect, it } from 'vitest';
import {
  answerAfter,
  attachmentsOutsideBlocks,
  badNumbers,
  blockRuns,
  chartModel,
  domainOf,
  formReply,
  formatNumber,
  formatValue,
  indexAt,
  legendEntries,
  metricDelta,
  missingFields,
  niceTicks,
  pickedReply,
  readBlocks,
  shortColumns,
  sortRows,
  type Block,
  type ChartBlock,
  type FormBlock,
} from './blocks';

const line: ChartBlock = {
  kind: 'chart',
  chart: 'line',
  summary: 's',
  labels: ['a', 'b', 'c', 'd'],
  series: [{ name: 'x', values: [1, null, 3, 4] }],
};

describe('readBlocks', () => {
  it('keeps known, well-formed blocks and drops the rest', () => {
    const set = readBlocks({
      blocks: {
        v: 1,
        intro: 'Hi',
        items: [
          line,
          { kind: 'hologram', summary: 'x' },
          { kind: 'table', summary: 'x', columns: [], rows: 'no' },
          { kind: 'callout', summary: 'x', tone: 'info', text: 'ok' },
        ],
      } as never,
    });
    expect(set?.items.map((b) => b.kind)).toEqual(['chart', 'callout']);
    expect(set?.intro).toBe('Hi');
  });

  it('falls back to the text for a newer version, or nothing drawable', () => {
    expect(readBlocks({ blocks: { v: 2, items: [line] } as never })).toBeNull();
    expect(readBlocks({ blocks: { v: 1, items: [{ kind: 'x' }] } as never })).toBeNull();
    expect(readBlocks({})).toBeNull();
  });

  it('keeps the outside mark', () => {
    expect(readBlocks({ blocks: { v: 1, items: [line], fromOutside: true } })?.fromOutside).toBe(
      true
    );
  });
});

describe('numbers', () => {
  it('reads as people write them', () => {
    expect(formatNumber(1284)).toBe('1,284');
    expect(formatNumber(12_900)).toBe('12.9K');
    expect(formatNumber(4_200_000)).toBe('4.2M');
    expect(formatNumber(3.5)).toBe('3.5');
    expect(formatNumber(84_200, true)).toBe('84,200');
    expect(formatNumber(5000, false, true)).toBe('5K');
    expect(formatValue(-1200, { prefix: '$' })).toBe('−$1,200');
    expect(formatValue(42, { suffix: '%' })).toBe('42%');
    expect(formatValue(null)).toBe('–');
  });

  it('a delta knows which way is good', () => {
    expect(metricDelta({ label: 'a', value: 1, delta: 3, suffix: '%' })).toEqual({
      text: '+3%',
      direction: 'up',
      tone: 'good',
    });
    expect(
      metricDelta({ label: 'a', value: 1, delta: -380, prefix: '$', good: 'down' })?.tone
    ).toBe('good');
    expect(metricDelta({ label: 'a', value: 1, delta: '-2.1 pts' })?.tone).toBe('bad');
    expect(metricDelta({ label: 'a', value: 1, delta: 'flat' })?.tone).toBe('neutral');
    expect(metricDelta({ label: 'a', value: 1 })).toBeNull();
  });

  it('ticks are clean', () => {
    expect(niceTicks(0, 47)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });
});

describe('charts', () => {
  it('a gap breaks the line', () => {
    const m = chartModel(line, 400, 200);
    if (m.type !== 'cartesian') throw new Error('cartesian');
    expect(m.lines[0].line.match(/M/g)).toHaveLength(2);
    expect(m.lines[0].points[1]).toBeNull();
    expect(indexAt(m, m.xs[2] + 1)).toBe(2);
  });

  it('bars are at most 24px and start at zero', () => {
    const m = chartModel(
      { ...line, chart: 'bar', series: [{ name: 'x', values: [5, -2, 3, 1] }] },
      600,
      200
    );
    if (m.type !== 'cartesian') throw new Error('cartesian');
    expect(m.bars).toHaveLength(4);
    for (const b of m.bars) expect(b.w).toBeLessThanOrEqual(24);
    expect(m.ticks.some((t) => t.value === 0)).toBe(true);
  });

  it('stacked bars round only the top segment', () => {
    const m = chartModel(
      {
        ...line,
        chart: 'bar',
        stacked: true,
        series: [
          { name: 'a', values: [1, 1, 1, 1] },
          { name: 'b', values: [2, 2, 2, 2] },
        ],
      },
      600,
      200
    );
    if (m.type !== 'cartesian') throw new Error('cartesian');
    const first = m.bars.filter((b) => b.index === 0);
    expect(first[0].path).not.toContain('Q');
    expect(first[1].path).toContain('Q');
  });

  it('a pie of one value is a whole circle; zero slices draw nothing', () => {
    const m = chartModel(
      { ...line, chart: 'pie', labels: ['a', 'b'], series: [{ name: 'x', values: [5, 0] }] },
      160,
      160
    );
    if (m.type !== 'pie') throw new Error('pie');
    expect(m.slices).toHaveLength(1);
    expect(m.slices[0].share).toBe(1);
    expect(m.slices[0].path.match(/A/g)).toHaveLength(2);
  });

  it('axis ticks share one style', () => {
    const m = chartModel(
      { ...line, chart: 'bar', series: [{ name: 'x', values: [3000, 12000, 18000, 1] }] },
      600,
      200
    );
    if (m.type !== 'cartesian') throw new Error('cartesian');
    expect(m.ticks.map((t) => t.label)).toEqual(['0', '5K', '10K', '15K', '20K']);
  });

  it('a legend only for two or more series', () => {
    expect(legendEntries(line)).toEqual([]);
    expect(
      legendEntries({ ...line, series: [line.series[0], { name: 'y', values: [] }] })
    ).toHaveLength(2);
  });
});

describe('tables and answers', () => {
  it('sorts with blanks last either way', () => {
    const rows = [
      ['a', 3],
      ['b', null],
      ['c', 10],
    ];
    expect(sortRows(rows, 1, 'desc').map((r) => r[0])).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, 1, 'asc').map((r) => r[0])).toEqual(['a', 'c', 'b']);
    expect(sortRows([['x2'], ['x10'], ['x1']], 0, 'asc').map((r) => r[0])).toEqual([
      'x1',
      'x2',
      'x10',
    ]);
  });

  it('the answer is the next thing the user said', () => {
    const msgs = [
      { id: 'a', kind: 'agent' as const, text: '' },
      { id: 'b', kind: 'agent' as const, text: '' },
      { id: 'c', kind: 'user' as const, text: 'Yes ' },
    ];
    expect(answerAfter(msgs, 'a')).toBe('Yes ');
    expect(answerAfter(msgs, 'c')).toBeNull();
    expect(pickedReply(['No', 'yes'], 'Yes ')).toBe(1);
    expect(pickedReply(['No'], null)).toBe(-1);
  });

  it('a form checks what it needs and replies in plain lines', () => {
    const form: FormBlock = {
      kind: 'form',
      title: 'Event',
      summary: '',
      submit: 'Send',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'n', label: 'Guests', type: 'number' },
        { id: 'notes', label: 'Notes', type: 'long_text' },
      ],
    };
    expect(missingFields(form, {})).toEqual(['name']);
    expect(badNumbers(form, { n: 'lots' })).toEqual(['n']);
    expect(badNumbers(form, { n: '1,200' })).toEqual([]);
    expect(formReply(form, { name: 'Launch', n: '40', notes: 'a\nb' })).toBe(
      'Event\nName: Launch\nGuests: 40\nNotes:\na\nb'
    );
  });

  it('image files are drawn once, and domains are bare', () => {
    const file = { name: 'a.png', path: 'attachments/m/a.png', mime: 'image/png', size: 1 };
    const other = { ...file, path: 'attachments/m/b.png' };
    const set = readBlocks({ blocks: { v: 1, items: [{ kind: 'image', summary: '', file }] } })!;
    expect(attachmentsOutsideBlocks([file, other], set)).toEqual([other]);
    expect(domainOf('https://www.Example.com/x')).toBe('example.com');
  });
});

describe('layout', () => {
  const facts = (title: string): Block => ({ kind: 'facts', title, summary: '', items: [] });
  const note: Block = { kind: 'callout', tone: 'warning', summary: '', text: 't' };
  const chart: Block = line;

  it('puts a run of records and notes on one page, and leaves the rest alone', () => {
    const runs = blockRuns([facts('a'), note, facts('b'), chart, facts('c'), note, note]);
    expect(runs.map((r) => r.length)).toEqual([3, 1, 3]);
    // One record alone, or notes alone, stay as they are.
    expect(blockRuns([facts('a'), chart]).map((r) => r.length)).toEqual([1, 1]);
    expect(blockRuns([note, note]).map((r) => r.length)).toEqual([1, 1]);
  });

  it('keeps times, names and numbers on one line, lets long text wrap', () => {
    const short = shortColumns({
      columns: [{ label: 'Time' }, { label: 'What' }, { label: 'Runs', numeric: true }],
      rows: [
        ['10:30 AM', 'Read what’s new and write up the three that matter', 1234567],
        ['9:00 AM', 'Sweep', null],
      ],
    });
    expect(short).toEqual([true, false, true]);
  });
});
