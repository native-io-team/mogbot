import { describe, expect, it } from 'vitest';
import {
  checkInHead,
  IMPORT_CHOICE_DECLINE,
  IMPORT_CHOICE_NOTE,
  IMPORT_CHOICE_TITLE,
  runsOnDetail,
  stepInOutcome,
  stepInSource,
  RUNS_ON_ANY_DETAIL,
  USE_THIS_ONE_NOW,
} from './cardWords';

const NOW = new Date(2026, 10, 9, 15, 0).getTime();

describe('the words the desk and the phone share', () => {
  it('the import card asks people who already have agents, and tells a first-timer what to press', () => {
    expect(IMPORT_CHOICE_TITLE).toMatch(/^Already have agents/);
    expect(IMPORT_CHOICE_NOTE).toMatch(/New to agents\? Start fresh\.$/);
    expect(IMPORT_CHOICE_DECLINE).toMatch(/start fresh/i);
  });

  it('a routine line: Routine or Scheduled, then why, and late with when it was due', () => {
    expect(checkInHead({ dueAt: NOW, late: false, repeats: true }, NOW)).toBe('Routine');
    expect(checkInHead({ dueAt: NOW, late: false, repeats: false }, NOW)).toBe('Scheduled');
    expect(checkInHead({ dueAt: NOW, late: false, repeats: true, manual: true }, NOW)).toBe(
      'Routine · run now'
    );
    expect(
      checkInHead({ dueAt: NOW, late: false, repeats: true, found: '2 new GitHub mentions' }, NOW)
    ).toBe('Routine · 2 new GitHub mentions');
    const due = new Date(2026, 10, 9, 9, 0).getTime();
    expect(checkInHead({ dueAt: due, late: true, repeats: true }, NOW)).toMatch(
      /^Routine · late, was due today at 9:00\sAM$/
    );
    expect(checkInHead(undefined, NOW)).toBe('Scheduled');
  });

  it('step in: where, and how it closed', () => {
    expect(stepInSource({ site: 'login.example.com', pageTitle: 'Verify' })).toBe(
      'login.example.com · Verify'
    );
    expect(stepInSource({ site: 'login.example.com' })).toBe('login.example.com');
    expect(stepInOutcome({ status: 'allowed' })).toBe('Handed back');
    expect(stepInOutcome({ status: 'denied' })).toBe('Not now');
    expect(stepInOutcome({ status: 'expired', setAside: 'Handed back by itself' })).toBe(
      'Handed back by itself'
    );
  });

  it('accounts: one word for putting one first, and Runs on', () => {
    expect(USE_THIS_ONE_NOW).toBe('Use for new work');
    expect(RUNS_ON_ANY_DETAIL).toMatch(/carrying on with the next/);
    expect(runsOnDetail({ signedIn: false, out: false })).toBe('Not signed in');
    expect(runsOnDetail({ signedIn: true, out: true })).toMatch(/out of usage now$/);
    expect(runsOnDetail({ signedIn: true, out: false })).toBe('Only this one, never another');
  });
});
