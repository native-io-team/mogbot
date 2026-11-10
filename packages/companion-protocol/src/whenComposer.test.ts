import { describe, expect, it } from 'vitest';
import {
  everyAfterPick,
  whenApps,
  whenEcho,
  whenIntervalChoices,
  whenMissing,
  whenReadback,
  whenSourceChoices,
} from './whenComposer';

describe('the "When…" composer, desk and phone', () => {
  it('says where checks run from where it is said', () => {
    expect(whenSourceChoices(false)[0].how).toBe('Free · checked from this Mac');
    expect(whenSourceChoices(false, 'your Mac')[0].how).toBe('Free · checked from your Mac');
    expect(whenSourceChoices(false).map((s) => s.kind)).not.toContain('linear_assigned');
    expect(whenSourceChoices(true).map((s) => s.kind)).toContain('linear_assigned');
  });

  it('starts an app check at 30 min and keeps an interval off the chips', () => {
    expect(everyAfterPick('github_mentions', 'custom', 10)).toBe(30);
    expect(everyAfterPick('new_file', 'github_assigned', 1)).toBe(10);
    expect(everyAfterPick('custom', 'new_file', 30)).toBe(30);
    expect(whenIntervalChoices('new_file', 20)).toEqual([1, 5, 10, 20, 30]);
  });

  it('asks for what is missing, in order', () => {
    expect(whenMissing('new_file', ' ', '', '')).toBe('Which folder?');
    expect(whenMissing('custom', '', '', '')).toBe('What should it look out for?');
    expect(whenMissing('custom', '', 'a new email', '')).toBe('Which app should it check?');
    expect(whenMissing('github_mentions', '', '', '')).toBeNull();
  });

  it('echoes the routine and its cost', () => {
    expect(whenEcho('Finance', { kind: 'github_mentions' }, ' Triage   it ')).toBe(
      'When someone mentions you on GitHub — Triage it'
    );
    expect(
      whenEcho('Lead Gen', { kind: 'custom', check: 'a new email from Dana', app: 'gmail' }, '')
    ).toBe('When Lead Gen finds “a new email from Dana”');
    expect(whenReadback('Finance', { kind: 'linear_assigned' }, 30)).toBe(
      'Each check uses a little of Finance’s usage and can only read that app, up to 24 a day. The first check only notes what’s already there, so nothing old starts work.'
    );
    expect(whenReadback('Finance', { kind: 'new_file', folder: '/x' }, 5)).toMatch(
      /^Checks are free\./
    );
  });

  it('offers our own connections given to the agent, then Claude Code’s, never claude.ai', () => {
    const conn = (serverKey: string, agentId: string, service = 'gmail') => ({
      service,
      title: 'Gmail',
      account: `${serverKey}@example.com`,
      kind: { type: 'oauth' },
      serverKey,
      grants: [{ agentId }],
    });
    const found = whenApps(
      'a1',
      [conn('gmail-1', 'a1'), conn('gmail-2', 'a1'), conn('gmail-3', 'b2')],
      [
        { name: 'linear', target: 'https://mcp.linear.app/mcp', source: 'user' },
        { name: 'claude.ai Notion', target: 'https://x', source: 'claudeAi' },
      ]
    );
    expect(found.apps).toEqual([
      { value: 'gmail-1', label: 'Gmail (gmail-1@example.com)' },
      { value: 'gmail-2', label: 'Gmail (gmail-2@example.com)' },
      { value: 'linear', label: 'Linear' },
    ]);
    expect(found.linear).toBe(true);
  });
});
