import { STEADY_HOLD_MS, THINKING_GRACE_MS, steadyNext } from '../src/lib/steady';

describe('steadyNext', () => {
  it('keeps the same line', () => {
    expect(steadyNext('Reading a file', 'Reading a file', 0, 10)).toEqual({ show: 'Reading a file', waitMs: 0 });
  });
  it('holds a new step until the shown one has had its moment', () => {
    expect(steadyNext('Reading a file', 'Running a command', 1000, 1500)).toEqual({
      show: 'Reading a file',
      waitMs: STEADY_HOLD_MS - 500,
    });
    expect(steadyNext('Reading a file', 'Running a command', 0, STEADY_HOLD_MS)).toEqual({
      show: 'Running a command',
      waitMs: 0,
    });
  });
  it('a brief Thinking between steps waits longer', () => {
    const r = steadyNext('Reading a file', 'Thinking', 0, STEADY_HOLD_MS);
    expect(r.show).toBe('Reading a file');
    expect(r.waitMs).toBe(THINKING_GRACE_MS - STEADY_HOLD_MS);
  });
});
