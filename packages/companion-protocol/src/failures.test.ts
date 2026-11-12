import { describe, expect, it } from 'vitest';
import {
  CONTINUE_TEXT,
  failureClause,
  failureFix,
  failureFixAtMac,
  failureFixLabel,
  failureLine,
  failurePill,
  noteFixLabel,
} from './failures';

const NOW = new Date(2026, 10, 9, 15, 0).getTime();

// docs/design/failure-states.md: one set of words for desk and phone.
describe('failure words', () => {
  it('says each kind once, with the reason first for anything else', () => {
    expect(failureLine({ kind: 'signed_out' }, 'x', 'Codex', NOW)).toBe('Codex is signed out');
    expect(failureLine({ kind: 'engine_missing' }, 'x', 'Claude Code', NOW)).toBe(
      'Claude Code isn’t installed'
    );
    expect(failureLine({ kind: 'usage_limit' }, 'x', 'Codex', NOW)).toBe('Out of usage');
    expect(
      failureLine(
        { kind: 'other' },
        "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online.",
        'Claude Code',
        NOW
      )
    ).toBe("Claude Code couldn't reach Anthropic over the network · didn’t finish");
    expect(failureLine({ kind: 'other' }, '', 'Codex', NOW)).toBe('Didn’t finish');
  });

  it('pills never repeat the state in the reason', () => {
    expect(failurePill({ kind: 'engine_missing' }, 'x', 'Codex', NOW)).toEqual({
      tone: 'failed',
      label: 'Not installed',
      rest: 'Codex',
    });
    const other = failurePill({ kind: 'other' }, 'Boom. More', 'Codex', NOW);
    expect(other).toEqual({ tone: 'failed', label: 'Didn’t finish', rest: 'Boom' });
    expect(failurePill({ kind: 'usage_limit' }, 'x', 'Codex', NOW).tone).toBe('out');
  });

  it('names one fix per kind, and Continue never resends the request', () => {
    expect(failureFix('signed_out')).toBe('sign-in');
    expect(failureFix('engine_missing')).toBe('install');
    expect(failureFix('interrupted')).toBe('continue');
    expect(failureFix('other')).toBe('retry');
    expect(failureFix(undefined)).toBe('retry');
    expect(failureFixLabel('install', 'Codex')).toBe('Install Codex');
    expect(failureFixLabel('sign-in', 'Claude Code')).toBe('Sign in to Claude Code');
    expect(failureFixLabel('continue', 'Codex')).toBe(CONTINUE_TEXT);
    // The phone can't install or sign in an engine: it says where.
    expect(failureFixAtMac('install', 'Codex')).toBe(
      'Install Codex on your computer, then send it again.'
    );
    expect(failureFixAtMac('install', 'Codex', 'mac')).toBe(
      'Install Codex on your Mac, then send it again.'
    );
    expect(failureFixAtMac('install', 'Codex', 'pc')).toBe(
      'Install Codex on your PC, then send it again.'
    );
    expect(failureFixAtMac('retry', 'Codex')).toBeNull();
  });

  it('a note’s button matches what the note says', () => {
    expect(noteFixLabel('user_chrome')).toBe('Set up Your Chrome');
    expect(noteFixLabel('user_chrome_check')).toBe('Check Your Chrome');
    expect(noteFixLabel('disk')).toBe('Free up space');
  });

  it('cuts the clause at the first sentence', () => {
    expect(failureClause('One. Two.')).toBe('One');
    expect(failureClause(null)).toBe('');
  });
});
