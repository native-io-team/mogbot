/**
 * The product's name and links, from the repo's brand.json: the one place
 * the name is set (MISSION: never hardcode it, never make it prominent).
 * app.config.ts reads the file and hands it over as `extra.brand`, so the
 * bundle never reaches outside mobile/ for it. Copy should rarely need it:
 * "your Mac", "this phone" and "your agents" say enough. Use it only where a
 * sentence has to name the app, such as a path through the desktop's menus.
 */

import Constants from 'expo-constants';

export interface Brand {
  name: string;
  slug: string;
  repository: string;
}

/** No config to read (a test, a broken build): a neutral name, and no links to open. */
const FALLBACK: Brand = { name: 'the desktop app', slug: '', repository: '' };

const text = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);

export function readBrand(extra: unknown): Brand {
  const raw = (extra as { brand?: Record<string, unknown> } | undefined)?.brand;
  if (!raw || typeof raw !== 'object') return FALLBACK;
  return {
    name: text(raw.name, FALLBACK.name),
    slug: text(raw.slug, FALLBACK.slug),
    repository: text(raw.repository, FALLBACK.repository),
  };
}

export const brand: Brand = readBrand(Constants.expoConfig?.extra);
