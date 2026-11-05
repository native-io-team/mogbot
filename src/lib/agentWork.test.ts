import { describe, expect, it } from 'vitest';
import {
  earlierSteps,
  formatWorked,
  liveSummary,
  rememberLiveOpen,
  stepOffset,
  wasOpenLive,
  workSummary,
} from './agentWork';
import type { TurnWork } from './agents';

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: 1_000_000,
  endedAt: 1_000_000 + 6 * 60_000,
  stepCount: 23,
  steps: [],
  fileCount: 2,
  files: ['Hero.tsx', 'Nav.tsx'],
  ...over,
});

describe('workSummary', () => {
  it('says how long, how many steps and how many files', () => {
    expect(workSummary(work())).toBe('Worked 6 min · 23 steps · edited 2 files');
  });

  it('leaves out what it has nothing behind', () => {
    expect(workSummary(work({ fileCount: 0, files: [], stepCount: 1 }))).toBe(
      'Worked 6 min · 1 step'
    );
  });

  it('never guesses a length it did not record', () => {
    expect(workSummary(work({ endedAt: undefined, fileCount: 1 }))).toBe(
      '23 steps · edited 1 file'
    );
    expect(workSummary(work({ endedAt: 0 }))).toBe('23 steps · edited 2 files');
  });

  it('reads short and long turns naturally', () => {
    expect(formatWorked(400)).toBe('1s');
    expect(formatWorked(42_000)).toBe('42s');
    expect(formatWorked(90_000)).toBe('2 min');
    expect(formatWorked(60 * 60_000)).toBe('1 h');
    expect(formatWorked(80 * 60_000)).toBe('1 h 20 min');
  });

  it('live, counts only', () => {
    expect(liveSummary(work({ endedAt: undefined, stepCount: 5, fileCount: 0 }))).toBe('5 steps');
  });
});

describe('steps', () => {
  it('are timed from the turn’s start', () => {
    const at = (ms: number) => ({ at: 1_000_000 + ms, kind: 'read' as const, label: 'Read a.ts' });
    expect(stepOffset(at(12_400), 1_000_000)).toBe('0:12');
    expect(stepOffset(at(14 * 60_000 + 5_000), 1_000_000)).toBe('14:05');
    expect(stepOffset(at(3_723_000), 1_000_000)).toBe('1:02:03');
    expect(stepOffset(at(-5), 1_000_000)).toBe('0:00');
  });

  it('counts the ones no longer kept', () => {
    const one = { at: 1, kind: 'read' as const, label: 'x' };
    expect(earlierSteps(work({ stepCount: 3, steps: [one] }))).toBe(2);
    expect(earlierSteps(work({ stepCount: 1, steps: [one] }))).toBe(0);
  });

  it('remember being opened live, for that turn only', () => {
    rememberLiveOpen('a', 5, true);
    expect(wasOpenLive('a', 5)).toBe(true);
    expect(wasOpenLive('a', 6)).toBe(false);
    rememberLiveOpen('a', 5, false);
    expect(wasOpenLive('a', 5)).toBe(false);
  });
});
