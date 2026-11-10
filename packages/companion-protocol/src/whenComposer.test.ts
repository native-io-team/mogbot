import { describe, expect, it } from 'vitest';
import {
  everyAfterPick,
  isHandle,
  whenAccess,
  whenFilterOf,
  whenSourceOf,
  whenCost,
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

  it('reads Mail and Messages on the Mac, free, narrowed only when asked', () => {
    const kinds = whenSourceChoices(false, 'your Mac');
    expect(kinds.find((s) => s.kind === 'new_mail')).toEqual({
      kind: 'new_mail',
      label: 'An email arrives in Mail',
      how: 'Free · reads Mail on your Mac',
    });
    expect(kinds.find((s) => s.kind === 'new_text')?.label).toBe('A text arrives in Messages');
    expect(whenIntervalChoices('new_text', 10)).toEqual([1, 5, 10, 30]);
    expect(whenSourceOf('new_mail', '', '', '', { from: ' a@b.co ', words: '' })).toEqual({
      kind: 'new_mail',
      from: 'a@b.co',
    });
    expect(whenSourceOf('new_text', '', '', '', { from: '', words: 'ignored' })).toEqual({
      kind: 'new_text',
    });
    expect(whenFilterOf({ kind: 'new_mail', words: 'invoice' })).toEqual({
      from: '',
      words: 'invoice',
    });
    expect(whenEcho('Ops', { kind: 'new_text', from: '+1 555 123 4567' }, 'Tell me')).toBe(
      'When a text arrives in Messages from +1 555 123 4567 — Tell me'
    );
    expect(whenCost('Ops', { kind: 'new_mail' }, 1)).toBe(
      'Checks are free. What a message says is only information to Ops, and it asks you before replying.'
    );
  });

  it('takes a phone number or email for a text, as the Mac does', () => {
    for (const ok of ['+1 (555) 123-4567', 'dana@acme.com', '07700 900123'])
      expect(isHandle(ok)).toBe(true);
    for (const no of ['my landlord', '@acme.com', '123', 'dana@acme'])
      expect(isHandle(no)).toBe(false);
    expect(whenMissing('new_text', '', '', '', { from: 'my landlord', words: '' })).toMatch(
      /^Give their phone number or email/
    );
    expect(whenMissing('new_text', '', '', '', { from: '', words: '' })).toBeNull();
  });

  it('says what stands in the way only when the Mac said so', () => {
    const fda = {
      state: 'full_disk_access' as const,
      words: 'Reading Mail needs Full Disk Access…',
    };
    const ok = { state: 'ok' as const };
    expect(whenAccess('new_mail', { mail: fda, messages: ok })).toBe(fda);
    expect(whenAccess('new_text', { mail: fda, messages: ok })).toBeNull();
    expect(whenAccess('github_mentions', { mail: fda, messages: fda })).toBeNull();
    expect(whenAccess('new_mail', undefined)).toBeNull();
  });
});
