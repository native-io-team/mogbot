import { describe, expect, it } from 'vitest';
import { formatBytes, freedLine, homeLine } from './agentsDisk';

describe('agentsDisk', () => {
  it('reads sizes like Finder (and like disk::gb)', () => {
    expect(formatBytes(39_400_000_000)).toBe('39 GB');
    expect(formatBytes(3_400_000_000)).toBe('3.4 GB');
    expect(formatBytes(20_000_000)).toBe('20 MB');
  });

  it('says how much of a home is regenerable only when it is', () => {
    const h = { agentId: 'a', name: 'A', bytes: 39_400_000_000, regenerableBytes: 37_200_000_000 };
    expect(homeLine(h)).toBe('Its folder uses 39 GB, 37 GB of it in dependency and build folders.');
    expect(homeLine({ ...h, regenerableBytes: 0 })).toBe('Its folder uses 39 GB.');
  });

  it('says what Free up space did, never more', () => {
    expect(freedLine({ bytes: 37_200_000_000, removed: 41, kept: 0, busy: false })).toBe(
      'Freed 37 GB.'
    );
    expect(freedLine({ bytes: 0, removed: 0, kept: 2, busy: false })).toBe(
      'Nothing to free up. Left 2 alone: git doesn’t ignore them.'
    );
    expect(freedLine({ bytes: 0, removed: 0, kept: 0, busy: true })).toMatch(/working/);
  });
});
