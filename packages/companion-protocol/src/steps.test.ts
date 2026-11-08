import { describe, expect, it } from 'vitest';
import {
  cleanSteps,
  draftAppsLine,
  keptRoutines,
  routineSteps,
  stepsLine,
  whenLabel,
} from './steps';

describe('whenLabel', () => {
  it('capitalises the sentence and the day and month names, nothing else', () => {
    expect(whenLabel('every friday at 16:00')).toBe('Every Friday at 16:00');
    expect(whenLabel('every 3 months on the 15th at 09:00 (Jan, Apr, Jul and Oct)')).toBe(
      'Every 3 months on the 15th at 09:00 (Jan, Apr, Jul and Oct)'
    );
  });
});
import { describeRun } from './schedule';
import type { AgentDraft } from './model';

describe('routines in steps', () => {
  const weekly = {
    note: 'Draft the weekly report',
    then: [{ text: 'Post it to #team', askFirst: true }],
  };

  it('numbers the note as step 1', () => {
    expect(routineSteps(weekly)).toEqual([
      { n: 1, text: 'Draft the weekly report', askFirst: false },
      { n: 2, text: 'Post it to #team', askFirst: true },
    ]);
    expect(routineSteps({ note: 'Brief me' })).toHaveLength(1);
  });

  it('says how many steps and where it asks, and nothing for one step', () => {
    expect(stepsLine(weekly)).toBe('2 steps · your OK before step 2');
    expect(stepsLine({ note: 'x' })).toBeNull();
    expect(
      stepsLine({
        note: 'a',
        then: [
          { text: 'b', askFirst: true },
          { text: 'c' },
          { text: 'd', askFirst: true },
        ],
      })
    ).toBe('4 steps · your OK before steps 2 and 4');
  });

  it('drops empty steps and keeps the flag only when set', () => {
    expect(cleanSteps([{ text: '  Post ' }, { text: '   ', askFirst: true }])).toEqual([
      { text: 'Post' },
    ]);
  });

  it('describes a run waiting for an OK, and one stopped there', () => {
    expect(describeRun({ at: 1, outcome: 'waiting', attempt: 1, step: 1 })).toBe(
      'Waiting for your OK after step 1'
    );
    expect(describeRun({ at: 1, outcome: 'declined', attempt: 1, step: 1 })).toBe(
      'Stopped after step 1'
    );
  });
});

describe('a drafted agent', () => {
  const draft: AgentDraft = {
    name: 'Morning Brief',
    role: 'Five lines every weekday',
    color: 'teal',
    instructions: 'You read the newsletters.',
    routines: [
      { when: 'every weekday at 8:00', note: 'Draft the brief', readsAs: 'every weekday at 08:00' },
      { when: 'whenever', note: 'Tidy', problem: 'Can’t be scheduled as written' },
      {
        when: 'every friday at 16:00',
        note: 'Draft the recap',
        then: [{ text: 'Post it', askFirst: true }],
      },
    ],
    apps: ['Gmail', 'Slack'],
  };

  it('keeps the ticked routines that can be set, and never one with a problem', () => {
    expect(keptRoutines(draft, [true, true, true])).toEqual([
      { when: 'every weekday at 8:00', note: 'Draft the brief' },
      {
        when: 'every friday at 16:00',
        note: 'Draft the recap',
        then: [{ text: 'Post it', askFirst: true }],
      },
    ]);
    expect(keptRoutines(draft, [false, true, true])).toHaveLength(1);
  });

  it('names the apps it will ask for without claiming they are connected', () => {
    expect(draftAppsLine(['Gmail', 'Slack'])).toBe(
      'Uses Gmail and Slack. It asks you to connect them the first time it needs them.'
    );
    expect(draftAppsLine(['Gmail'])).toMatch(/connect it the first time it needs it\.$/);
    expect(draftAppsLine([])).toBeNull();
  });
});
