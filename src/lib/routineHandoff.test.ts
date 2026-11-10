import { describe, expect, it } from 'vitest';
import { askToChangeRoutine, takeRoutineAsk } from './routineHandoff';

describe('routine handoff', () => {
  it('is taken once, by the agent it was for', () => {
    askToChangeRoutine('finance', 'ci-1', 1_000);
    expect(takeRoutineAsk('lead-gen', 1_100)).toBeNull();
    expect(takeRoutineAsk('finance', 1_200)).toBe('ci-1');
    expect(takeRoutineAsk('finance', 1_300)).toBeNull();
  });

  it('goes stale rather than ambushing a later visit', () => {
    askToChangeRoutine('finance', 'ci-1', 1_000);
    expect(takeRoutineAsk('finance', 1_000 + 60_000)).toBeNull();
  });
});
