import type { TurnWork } from '@shipstudio/companion-protocol';
import type { WorkStepKind } from '@shipstudio/companion-protocol';
import { earlierSteps, formatWorked, stepOffset, stepSymbol, workSummary } from '../src/lib/work';

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: 0,
  endedAt: 6 * 60_000,
  stepCount: 23,
  steps: [],
  fileCount: 2,
  ...over,
});

describe('what a turn did', () => {
  it('folds into one line of what was observed', () => {
    expect(workSummary(work())).toBe('Worked 6 min · 23 steps · edited 2 files');
    expect(workSummary(work({ fileCount: 0, stepCount: 1 }))).toBe('Worked 6 min · 1 step');
    expect(workSummary(work({ endedAt: undefined }))).toBe('23 steps · edited 2 files');
    expect(formatWorked(41_000)).toBe('41s');
    expect(formatWorked(80 * 60_000)).toBe('1 h 20 min');
  });

  it('times steps from the start and counts the ones not kept', () => {
    expect(stepOffset({ at: 75_000, kind: 'read', label: 'x' }, 0)).toBe('1:15');
    expect(earlierSteps(work({ stepCount: 3, steps: [{ at: 1, kind: 'read', label: 'x' }] }))).toBe(
      2
    );
  });

  it('draws every kind the Mac sends, and an unknown one as a tool', () => {
    const kinds: WorkStepKind[] = [
      'read',
      'edit',
      'search',
      'web',
      'command',
      'message',
      'approval',
      'screenshot',
      'plan',
      'delegate',
      'project',
      'tool',
    ];
    expect(new Set(kinds.map(stepSymbol)).size).toBe(kinds.length);
    expect(stepSymbol('teleport')).toBe('puzzlepiece');
  });
});
