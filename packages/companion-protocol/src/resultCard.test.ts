import { describe, expect, it } from 'vitest';
import {
  isPortrait,
  linkHost,
  linkKind,
  RESULT_STATUS_LABEL,
  resultStatus,
  resultVersions,
  type ResultCard,
} from './results';

const card = (id: string, version: number, extra: Partial<ResultCard> = {}): ResultCard => ({
  id,
  version,
  title: 'T',
  summary: 'S',
  ...extra,
});

describe('resultVersions', () => {
  it('lists each result’s versions oldest first, from the log only', () => {
    const v1 = card('a', 1);
    const v2 = card('a', 2, { changes: 'x' });
    const other = card('b', 1);
    const map = resultVersions([
      { id: 'm2', result: v2 },
      { id: 'n', result: undefined },
      { id: 'm1', result: v1 },
      { id: 'o', result: other },
    ]);
    expect(map.get('a')).toEqual([v1, v2]);
    expect(map.get('b')).toEqual([other]);
    expect(map.has('n')).toBe(false);
  });

  it('shows a version recorded twice once, the later copy', () => {
    const first = card('a', 1, { summary: 'old' });
    const again = card('a', 1, { summary: 'new' });
    expect(
      resultVersions([
        { id: '1', result: first },
        { id: '2', result: again },
      ]).get('a')
    ).toEqual([again]);
  });
});

describe('resultStatus', () => {
  it('says only what the card carries', () => {
    expect(resultStatus(card('a', 1), true)).toBe('finished');
    expect(resultStatus(card('a', 1, { checkpoint: true }), true)).toBe('partway');
    expect(resultStatus(card('a', 1, { checkpoint: true }), false)).toBe('earlier');
    expect(RESULT_STATUS_LABEL.partway).toBe('Partway through');
    // Never claims the work was verified.
    expect(Object.values(RESULT_STATUS_LABEL).join(' ')).not.toMatch(/verif|check/i);
  });
});

describe('links', () => {
  it('reads a kind from the address alone', () => {
    expect(linkKind('http://localhost:3104/pricing')).toBe('local');
    expect(linkKind('http://127.0.0.1:5173')).toBe('local');
    expect(linkKind('https://github.com/acme/site/pull/4')).toBe('repo');
    expect(linkKind('https://docs.google.com/spreadsheets/d/1')).toBe('doc');
    expect(linkKind('https://www.notion.so/x')).toBe('doc');
    expect(linkKind('https://example.com')).toBe('web');
    expect(linkKind('not a url')).toBe('web');
    // A look-alike host is just a page.
    expect(linkKind('https://github.com.evil.example/x')).toBe('web');
  });

  it('shows the host without www', () => {
    expect(linkHost('https://www.linkedin.com/company/x')).toBe('linkedin.com');
    expect(linkHost('http://localhost:3104/pricing')).toBe('localhost:3104');
    expect(linkHost('nope')).toBe('nope');
  });
});

describe('isPortrait', () => {
  it('frames only clearly tall pictures', () => {
    expect(isPortrait({ width: 390, height: 640 })).toBe(true);
    expect(isPortrait({ width: 1280, height: 800 })).toBe(false);
    expect(isPortrait({ width: 100, height: 120 })).toBe(false);
    expect(isPortrait(null)).toBe(false);
    expect(isPortrait({ width: 0, height: 10 })).toBe(false);
  });
});
