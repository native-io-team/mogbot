import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, scrollMotion } from './motion';

function reduce(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: on && q.includes('reduce'), media: q }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Reduce Motion', () => {
  it('a scripted scroll glides, or jumps when motion is reduced', () => {
    reduce(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollMotion()).toBe('smooth');
    reduce(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollMotion()).toBe('auto');
  });

  it('no script asks for a smooth scroll without asking first', () => {
    // `behavior: 'smooth'` ignores the stylesheet's floor; scrollMotion() doesn't.
    // useAgentMotion checks prefersReducedMotion() itself, right beside its call.
    const sources = import.meta.glob<string>(
      ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../components/agents/useAgentMotion.ts'],
      { query: '?raw', import: 'default', eager: true }
    );
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes("behavior: 'smooth'"))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
