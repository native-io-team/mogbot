import { describe, expect, it } from 'vitest';
import { SKILL_OFFER_NOTE, skillWhenLine } from './skills';

describe('skillWhenLine', () => {
  it('says the agent’s “when” to you, with the verb agreeing', () => {
    expect(skillWhenLine('When the user asks to reconcile last month’s payouts')).toBe(
      'When you ask to reconcile last month’s payouts'
    );
    expect(skillWhenLine('When the user’s invoices are due')).toBe('When your invoices are due');
    expect(skillWhenLine('When the user is filing expenses')).toBe('When you are filing expenses');
    expect(skillWhenLine('When the user pushes a release')).toBe('When you push a release');
    expect(skillWhenLine('When the user tries the export')).toBe('When you try the export');
    expect(skillWhenLine('When the user always wants the PDF')).toBe('When you always want the PDF');
    expect(skillWhenLine('The user wants a weekly summary')).toBe('You want a weekly summary');
  });

  it('leaves other words alone', () => {
    expect(skillWhenLine('For last month’s invoices')).toBe('For last month’s invoices');
    expect(skillWhenLine('When the user this week…')).toBe('When you this week…');
    expect(skillWhenLine('When the user wanted it')).toBe('When you wanted it');
  });

  it('says what saving does and where it goes', () => {
    expect(SKILL_OFFER_NOTE).toMatch(/same way next time/);
    expect(SKILL_OFFER_NOTE).toMatch(/under Skills/);
  });
});
