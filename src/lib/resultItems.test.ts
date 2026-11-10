import { describe, expect, it } from 'vitest';
import { repeatsName } from './resultItems';

describe('repeatsName', () => {
  it('drops a host that only repeats the link title', () => {
    expect(repeatsName('www.linkedin.com', 'www.linkedin.com/company/acme')).toBe(true);
    expect(repeatsName('www.linkedin.com', 'https://www.linkedin.com/company/acme')).toBe(true);
    expect(repeatsName('example.com', 'example.com')).toBe(true);
    // The row shows the host without www.; the title may still have it.
    expect(repeatsName('linkedin.com', 'www.linkedin.com/company/acme')).toBe(true);
  });

  it('keeps a subtitle that adds something', () => {
    expect(repeatsName('www.linkedin.com', 'Acme on LinkedIn')).toBe(false);
    expect(repeatsName('PDF · 2 KB', 'invoice.pdf')).toBe(false);
    // Another host that merely starts the same way is not the same host.
    expect(repeatsName('example.com', 'example.com.evil.net/x')).toBe(false);
  });
});
