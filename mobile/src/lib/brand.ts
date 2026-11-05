/**
 * The product's name and links, from the repo's brand.json: the one place
 * the name is set (MISSION: never hardcode it, never make it prominent).
 * Copy should rarely need it: "your Mac", "this phone" and "your agents" say
 * enough. Use it only where a sentence has to name the app, such as a path
 * through the desktop's menus.
 */

import brandJson from '../../../brand.json';

export interface Brand {
  name: string;
  slug: string;
  repository: string;
}

export const brand: Brand = {
  name: brandJson.name,
  slug: brandJson.slug,
  repository: brandJson.repository,
};
