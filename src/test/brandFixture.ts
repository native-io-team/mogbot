/**
 * Tests for features that brand.json can switch off (issue reporting, the
 * template gallery, community links, updates, the phone install…) run against
 * a brand with every link set, so the feature exists to be tested:
 *
 *   vi.mock('../../lib/brand', async (importOriginal) => {
 *     const { withAllLinks } = await import('../../test/brandFixture');
 *     return withAllLinks(await importOriginal());
 *   });
 *
 * The values are the inherited ones these tests were written against. They
 * are fixtures only: the shipped brand.json leaves every one of them null.
 */
import type * as BrandModule from '../lib/brand';

export const ALL_LINKS: BrandModule.BrandLinks = {
  issueRepo: 'ship-studio/ship-studio',
  securityAdvisories: 'https://github.com/ship-studio/ship-studio/security/advisories/new',
  discussions: 'https://github.com/ship-studio/ship-studio/discussions',
  community: 'https://ship.studio/slack',
  website: 'https://example.com',
  errorReports: 'https://example.com/report',
  releases: 'https://github.com/example/releases/releases',
  updates: 'https://example.com/latest.json',
  templateApi: 'https://example.com/api/v1/templates',
  starterRepoBase: 'https://github.com/ship-studio',
  companionSource: 'https://github.com/ship-studio/ship-studio.git',
  appStore: 'https://apps.apple.com/app/id0000000000',
  pushRelay: null,
};

export function withAllLinks(original: typeof BrandModule): typeof BrandModule {
  const BRAND = { ...original.BRAND, links: ALL_LINKS };
  return { ...original, BRAND, BRAND_LINKS: ALL_LINKS };
}
