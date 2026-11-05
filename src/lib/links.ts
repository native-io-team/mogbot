/**
 * Shared external links.
 *
 * Every community CTA in the app uses this single URL, taken from
 * `links.community` in brand.json. It is null when this build has no
 * community of its own, and every CTA that would use it hides.
 */
import { BRAND_LINKS } from './brand';

export const SLACK_INVITE_URL: string | null = BRAND_LINKS.community;
