import { describe, expect, it, vi } from 'vitest';
import type { CommentAgent } from './canvasComments';
import {
  cleanPreviewError,
  pickErrorAgent,
  PREVIEW_ERROR_MAX_CHARS,
  previewErrorPrompt,
} from './previewErrorToAgent';

const agent = (id: number, extra: Partial<CommentAgent>): CommentAgent => ({
  id,
  label: `Tab ${id}`,
  send: vi.fn().mockResolvedValue(undefined),
  ...extra,
});

describe('cleanPreviewError', () => {
  it('strips the bracketed-paste terminator and other controls', () => {
    expect(cleanPreviewError('err\x1b[201~\recho pwned\r')).toBe('err[201~\necho pwned');
  });
  it('rejects non-strings and empty text', () => {
    expect(cleanPreviewError(undefined)).toBeNull();
    expect(cleanPreviewError(42)).toBeNull();
    expect(cleanPreviewError('  \x1b ')).toBeNull();
  });
  it('caps the length', () => {
    const long = cleanPreviewError('a'.repeat(PREVIEW_ERROR_MAX_CHARS + 50)) ?? '';
    expect(long.length).toBe(PREVIEW_ERROR_MAX_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
  });
  it('wraps the error in a prompt without a Return', () => {
    expect(previewErrorPrompt('X')).not.toMatch(/\r/);
  });
});

describe('pickErrorAgent', () => {
  it('never picks a shell tab, even when it is active', () => {
    expect(pickErrorAgent([agent(1, { isAgent: false, isActive: true })])).toBeNull();
    const target = pickErrorAgent([
      agent(1, { isAgent: false, isActive: true }),
      agent(2, { isAgent: true }),
    ]);
    expect(target?.id).toBe(2);
  });
  it('prefers the active agent tab', () => {
    const target = pickErrorAgent([
      agent(1, { isAgent: true }),
      agent(2, { isAgent: true, isActive: true }),
    ]);
    expect(target?.id).toBe(2);
  });
  it('treats an unmarked tab as not an agent', () => {
    expect(pickErrorAgent([agent(1, {})])).toBeNull();
  });
});
