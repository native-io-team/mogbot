import { describe, expect, it } from 'vitest';
import type { Template } from '../hooks/useProjectCreation';
import {
  PROJECT_OUTCOMES,
  availableOutcomes,
  outcomeFor,
  templateForOutcome,
} from './projectOutcomes';

const t = (id: string): Template => ({
  id,
  name: id,
  description: '',
  repo: id === 'blank' ? '' : `https://example.com/${id}`,
  category: 'web',
});

const ALL = [
  'nextjs-basic',
  'astro-basic',
  'shopify-theme',
  'expo-mobile',
  'eve-agent',
  'blank',
].map(t);
const website = PROJECT_OUTCOMES.find((o) => o.id === 'website')!;

describe('project outcomes', () => {
  it('offers only outcomes this build has a template for', () => {
    expect(availableOutcomes(ALL).map((o) => o.id)).toEqual([
      'website',
      'store',
      'mobile',
      'blank',
    ]);
    // No starter repos: only Blank.
    expect(availableOutcomes([t('blank')]).map((o) => o.id)).toEqual(['blank']);
  });

  it('maps a framework back to what it is for, and Eve to nothing', () => {
    expect(outcomeFor('astro-basic')?.id).toBe('website');
    expect(outcomeFor('shopify-theme')?.id).toBe('store');
    expect(outcomeFor('eve-agent')).toBeNull();
    expect(outcomeFor(null)).toBeNull();
  });

  it('keeps the current framework, then the saved default, then the first', () => {
    expect(templateForOutcome(website, ALL, 'astro-basic', 'nextjs-basic')?.id).toBe('astro-basic');
    expect(templateForOutcome(website, ALL, 'expo-mobile', 'astro-basic')?.id).toBe('astro-basic');
    expect(templateForOutcome(website, ALL, null, 'eve-agent')?.id).toBe('nextjs-basic');
  });
});
