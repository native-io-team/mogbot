import { describe, expect, it } from 'vitest';
import type { LiveCall, TurnWork, WorkStep } from './model';
import {
  formatDuration,
  formatElapsed,
  formatRowElapsed,
  lifeLine,
  offersStopStep,
  outputNote,
  quietLine,
  slowHint,
  stepLine,
  workingRowLine,
} from './work';

const call = (over: Partial<LiveCall> = {}): LiveCall => ({
  kind: 'command',
  label: 'Running the Cypress tests',
  startedAt: 0,
  slow: 'tests',
  streams: false,
  canStop: true,
  ...over,
});

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  startedAt: 0,
  stepCount: 1,
  steps: [],
  fileCount: 0,
  ...over,
});

describe('live step words', () => {
  it('times the step', () => {
    expect(formatElapsed(7_400)).toBe('0:07');
    expect(formatElapsed(332_000)).toBe('5:32');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatDuration(372_000)).toBe('6m 12s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatRowElapsed(332_000)).toBe('5m');
  });

  it('hints only after a minute, only for a known slow tool', () => {
    expect(slowHint(call(), 59_000)).toBeNull();
    expect(slowHint(call(), 60_000)).toBe('Test runs usually take a few minutes');
    expect(slowHint(call({ slow: undefined }), 600_000)).toBeNull();
    expect(slowHint(call({ slow: 'whatever' as never }), 60_000)).toBe(
      'This usually takes a few minutes'
    );
  });

  it('offers to stop a step only after ten minutes, when it can', () => {
    expect(offersStopStep(call(), 599_000)).toBe(false);
    expect(offersStopStep(call(), 600_000)).toBe(true);
    expect(offersStopStep(call({ canStop: false }), 900_000)).toBe(false);
  });

  it('says why there is no output', () => {
    expect(outputNote(call())).toBe('Output appears when it finishes');
    expect(outputNote(call({ streams: true }))).toBe('Nothing printed yet');
    expect(outputNote(call({ streams: true, output: ['x'] }))).toBeNull();
  });

  it('goes quiet only when the Mac says so', () => {
    expect(quietLine(work(), 999_999)).toBeNull();
    expect(quietLine(work({ quietSince: 0 }), 300_000)).toBe('No progress for 5 min');
  });

  it('says when it last showed life, and whether its command uses the CPU', () => {
    expect(lifeLine(work(), 1)).toBeNull();
    expect(lifeLine(work({ lastSignAt: 1_000 }), 5_000)).toBe('Last activity 4s ago');
    expect(lifeLine(work({ lastSignAt: 4_500, current: call({ busy: true }) }), 5_000)).toBe(
      'Last activity just now · using the CPU'
    );
    expect(lifeLine(work({ lastSignAt: 0, current: call({ busy: false }) }), 120_000)).toBe(
      'Last activity 2m ago · not using the CPU'
    );
  });

  it('finishes a step with its time and its counts', () => {
    const step: WorkStep = {
      at: 0,
      kind: 'command',
      label: 'Ran the Cypress tests',
      endedAt: 372_000,
      summary: '42 passed, 3 failed',
    };
    expect(stepLine(step)).toBe('Ran the Cypress tests · 6m 12s · 42 passed, 3 failed');
    expect(stepLine({ ...step, endedAt: 2_000, summary: undefined })).toBe('Ran the Cypress tests');
    // An older timeline: just its label.
    expect(stepLine({ at: 0, kind: 'command', label: 'Ran npm test' })).toBe('Ran npm test');
  });

  it('gives a working row its live step and elapsed time', () => {
    expect(
      workingRowLine('Running the Cypress tests', work({ current: call() }), 0, 332_000)
    ).toEqual({ text: 'Running the Cypress tests', elapsed: '5m' });
    expect(workingRowLine(null, undefined, 0, 12_000)).toEqual({
      text: 'Thinking',
      elapsed: '12s',
    });
    expect(workingRowLine('Thinking', work({ quietSince: 0 }), 0, 300_000)).toEqual({
      text: 'No progress for 5 min',
      elapsed: null,
    });
  });
});
