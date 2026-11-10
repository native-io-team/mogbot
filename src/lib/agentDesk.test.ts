import { describe, expect, it } from 'vitest';
import {
  lastResultWords,
  nextRunWords,
  pausedLine,
  ranOnLine,
  resumedLine,
  routineCounts,
  routineRows,
  routineWhenWords,
  stepIndex,
} from './agentDesk';
import type { Agent, CheckIn, WorkStep } from './agents';

const routine = (id: string, extra: Partial<CheckIn> = {}): CheckIn => ({
  id,
  note: `do ${id}`,
  nextAt: 1_000,
  createdAt: 0,
  paused: false,
  ...extra,
});
const agent = (id: string, checkIns: CheckIn[]) => ({ id, name: id, checkIns }) as unknown as Agent;

describe('ranOnLine', () => {
  it('joins only what was recorded', () => {
    expect(ranOnLine({ engine: 'Codex', account: 'me', model: 'gpt-5.5' })).toBe(
      'Codex · me · gpt-5.5'
    );
    expect(ranOnLine({ engine: 'Codex', model: '  ' })).toBe('Codex');
    expect(ranOnLine({})).toBeNull();
  });
});

describe('stepIndex', () => {
  it('counts the steps no longer kept', () => {
    const steps = (n: number): WorkStep[] =>
      Array.from({ length: n }, (_, i) => ({ at: i, kind: 'read', label: 'Read a' }));
    expect(stepIndex({ stepCount: 70, steps: steps(60) }, 0)).toBe(10);
    expect(stepIndex({ stepCount: 2, steps: steps(2) }, 1)).toBe(1);
  });
});

describe('the Routines overview', () => {
  const agents = [
    agent('b', [routine('late', { nextAt: 9_000 }), routine('off', { paused: true })]),
    agent('a', [routine('soon', { nextAt: 2_000 })]),
  ];

  it('lists every routine, running ones soonest first, paused last', () => {
    expect(routineRows(agents).map((r) => r.routine.id)).toEqual(['soon', 'late', 'off']);
    expect(routineCounts(agents)).toEqual({ on: 2, paused: 1 });
  });

  it('says how each runs, when next, and how its last run went', () => {
    const daily = routine('d', {
      repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
      runs: [{ at: 1, outcome: 'failed', attempt: 1 }],
    });
    expect(routineWhenWords(daily)).toMatch(/^Every weekday at /);
    expect(routineWhenWords(routine('once'))).toBe('Once');
    expect(lastResultWords(daily)).toBe('Didn’t run');
    expect(lastResultWords(routine('new'))).toBeNull();
    expect(nextRunWords(routine('p', { paused: true }))).toBeNull();
  });

  it('words the bulk outcomes', () => {
    expect(pausedLine(0)).toBe('No routine was running');
    expect(pausedLine(1)).toBe('Paused 1 routine');
    expect(resumedLine(3)).toBe('Resumed 3 routines');
  });
});
