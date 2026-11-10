import { describe, expect, it } from 'vitest';
import cases from './conversation-title-cases.json';
import { CONVERSATION_AUTO_TITLE_CHARS, conversationAutoTitle } from './conversationTitle';
import { conversationTitle } from './conversations';

describe('conversationAutoTitle', () => {
  it.each(cases.cases)('$text', ({ text, title }) => {
    expect(conversationAutoTitle(text)).toBe(title);
    // Idempotent: a stored title tidies to itself.
    expect(conversationAutoTitle(title)).toBe(title);
    expect([...title].length).toBeLessThanOrEqual(CONVERSATION_AUTO_TITLE_CHARS);
  });

  it('stays in bounds on long lines and long words', () => {
    const words = conversationAutoTitle('word '.repeat(30));
    expect(words.length).toBeLessThanOrEqual(CONVERSATION_AUTO_TITLE_CHARS);
    expect(words.endsWith('…')).toBe(false);
    expect(conversationAutoTitle('x'.repeat(100))).toHaveLength(CONVERSATION_AUTO_TITLE_CHARS);
  });
});

describe('conversationTitle', () => {
  it('tidies an automatic title an older Mac sent, never a typed name', () => {
    const old = 'I Kind of like B with a hint of A. L…';
    expect(conversationTitle({ id: 'c1', title: old, named: false })).toBe(
      'I kind of like B with a hint of A'
    );
    expect(conversationTitle({ id: 'c1', title: 'can you DO it.', named: true })).toBe(
      'can you DO it.'
    );
    expect(conversationTitle({ id: 'c1', title: '', named: false })).toBe('New conversation');
    expect(conversationTitle({ id: 'first', title: '' })).toBe('First conversation');
  });
});
