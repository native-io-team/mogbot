import { describe, expect, it } from 'vitest';
import { firstSentence, plainLine, previewText } from './preview';

describe('previewText: a row says plain words', () => {
  it('skips a bold heading and a label for what follows them', () => {
    expect(
      previewText(
        '**Post 1 of 6 · Fri Nov 6, 10am**\nLINKEDIN:\nWe shipped the new pricing page today. It took three weeks.'
      )
    ).toBe('We shipped the new pricing page today.');
  });

  it('strips markdown markers and keeps the words', () => {
    expect(
      previewText('## Done\n- **Fixed** the `footer` [links](https://x.example) on _mobile_')
    ).toBe('Fixed the footer links on mobile');
  });

  it('a lone label is still said, without its colon', () => {
    expect(previewText('LINKEDIN:')).toBe('LINKEDIN');
    expect(previewText('**Post 1 of 6 · Fri Nov 6, 10am**')).toBe('Post 1 of 6 · Fri Nov 6, 10am');
  });

  it('cuts to the first sentence only when another follows', () => {
    expect(previewText('Acme’s staging deploy is green. Want me to have it open the PR?')).toBe(
      'Acme’s staging deploy is green.'
    );
    expect(previewText('Two invoices are overdue: Northwind ($4,200) and…')).toBe(
      'Two invoices are overdue: Northwind ($4,200) and…'
    );
    expect(firstSentence('Bumped to v1.2. e.g. the footer')).toBe(
      'Bumped to v1.2. e.g. the footer'
    );
  });

  it('leaves snake_case, prices and plain text alone', () => {
    expect(plainLine('Renamed user_id to account_id for $4,200')).toBe(
      'Renamed user_id to account_id for $4,200'
    );
    expect(previewText('Build 42 is on TestFlight.')).toBe('Build 42 is on TestFlight.');
  });

  it('skips rules and table separators, and reads a table row as cells', () => {
    expect(previewText('---\n| Plan | Price |\n|---|---|\n| Pro | $29 |')).toBe('Plan · Price');
  });

  it('nothing to say is null', () => {
    expect(previewText(null)).toBeNull();
    expect(previewText('  \n---\n')).toBeNull();
  });
});
