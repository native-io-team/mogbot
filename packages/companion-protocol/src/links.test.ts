import { describe, expect, it } from 'vitest';
import { CLAUDE_AI_CONNECTORS_URL, OUTSIDE_LINKS } from './links';

describe('outside links', () => {
  it('are https URLs with no stray parts', () => {
    for (const link of OUTSIDE_LINKS) {
      const url = new URL(link);
      expect(url.protocol).toBe('https:');
      expect(url.username + url.password + url.search + url.hash).toBe('');
      expect(url.toString()).toBe(link);
    }
  });

  it('send connectors to Customize, never the page that moved', () => {
    const url = new URL(CLAUDE_AI_CONNECTORS_URL);
    expect(url.host).toBe('claude.ai');
    expect(url.pathname).toBe('/customize/connectors');
    expect(CLAUDE_AI_CONNECTORS_URL).not.toContain('/settings/connectors');
  });
});
