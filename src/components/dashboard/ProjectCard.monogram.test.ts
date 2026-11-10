import { describe, expect, it } from 'vitest';
import { monogram } from './ProjectCard';

describe('monogram', () => {
  it('is the first letter or digit of the name', () => {
    expect(monogram('acme-marketing')).toBe('A');
    expect(monogram('_internal')).toBe('I');
    expect(monogram('3d-viewer')).toBe('3');
    expect(monogram('日本語のプロジェクト名')).toBe('日');
    expect(monogram('🚀-launch')).toBe('L');
  });

  it('falls back to the first character, and to nothing for an empty name', () => {
    expect(monogram('🚀')).toBe('🚀');
    expect(monogram('')).toBe('');
  });
});
