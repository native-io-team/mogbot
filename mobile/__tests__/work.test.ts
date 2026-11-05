import type { TurnWork } from '@shipstudio/companion-protocol';
import type { WorkStepKind } from '@shipstudio/companion-protocol';
import {
  earlierSteps,
  formatWorked,
  liveSteps,
  liveSummary,
  stepOffset,
  stepOffsetSpoken,
  stepSymbol,
  workSummary,
} from '../src/lib/work';

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

describe('while it works', () => {
  const steps = [
    { at: 1, kind: 'read' as const, label: 'Read a.ts' },
    { at: 2, kind: 'command' as const, label: 'Ran npm test' },
  ];
  it('folds into “n steps so far”: the row above already says it’s working', () => {
    expect(liveSummary(work({ endedAt: undefined, stepCount: 8, fileCount: 0 }))).toBe(
      '8 steps so far'
    );
    expect(liveSummary(work({ endedAt: undefined, stepCount: 1, fileCount: 1 }))).toBe(
      '1 step so far · edited 1 file'
    );
  });

  it('says each step’s time in words for VoiceOver, not digit by digit', () => {
    const at = (s: number) => ({ at: s * 1000, kind: 'read' as const, label: 'Read a.ts' });
    expect(stepOffsetSpoken(at(12), 0)).toBe('12 seconds in');
    expect(stepOffsetSpoken(at(14 * 60 + 5), 0)).toBe('14 minutes 5 seconds in');
    expect(stepOffsetSpoken(at(60), 0)).toBe('1 minute in');
    expect(stepOffsetSpoken(at(3600 + 120 + 3), 0)).toBe('1 hour 2 minutes in');
    expect(stepOffsetSpoken(at(0), 0)).toBe('at the start');
  });

  it('leaves out the newest step only while the working row is saying it', () => {
    const w = work({ steps, stepCount: 2, doing: 'Running npm test' });
    expect(liveSteps(w, 'Running npm test')).toHaveLength(1);
    expect(liveSteps(w, null)).toHaveLength(2);
    expect(liveSteps({ ...w, doing: undefined }, 'Running npm test')).toHaveLength(2);
  });
});
