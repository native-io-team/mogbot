/**
 * How someone gets the phone app onto their phone in this build, so every
 * place that offers the phone (the Chief's card, the Phone panel) promises
 * only what this build can do.
 *
 * - `store`: the App Store page is known (`links.appStore` in brand.json).
 *   Preferred: it takes a minute, and only the store build receives push.
 * - `build`: no store page, but this build can build it on this Mac
 *   (`links.companionSource`, or a dev build): ten minutes to an hour.
 * - `none`: neither. A downloaded build before the App Store app is live.
 *   Nothing offers the phone as a next step; the panel says it isn't out yet.
 *
 * @module lib/phoneApp
 */

import { BRAND_LINKS } from './brand';
import { COMPANION_INSTALL_ENABLED } from './companionInstall';

export type PhoneAppRoute = 'store' | 'build' | 'none';

export function phoneAppRouteFor(storeUrl: string | null, canBuild: boolean): PhoneAppRoute {
  if (storeUrl) return 'store';
  return canBuild ? 'build' : 'none';
}

/** The App Store page, when there is one. */
export const PHONE_APP_STORE_URL: string | null = BRAND_LINKS.appStore ?? null;

/** This build's route. */
export const PHONE_APP_ROUTE: PhoneAppRoute = phoneAppRouteFor(
  PHONE_APP_STORE_URL,
  COMPANION_INSTALL_ENABLED
);

/** The Chief's phone card's one line, honest about the time for each route. */
export function phoneOfferNote(route: PhoneAppRoute): string | null {
  switch (route) {
    case 'store':
      return 'Chat, answer and approve from anywhere. Get the free app from the App Store, then scan a code from this Mac. Your phone talks only to this Mac.';
    case 'build':
      return 'Chat, answer and approve from anywhere. Your phone talks only to this Mac. There’s no App Store app yet, so setting it up takes ten minutes to an hour.';
    case 'none':
      return null;
  }
}

/** The Phone panel's "Get the app" line when this build can't get it yet. */
export const PHONE_APP_NOT_OUT =
  'The phone app isn’t out yet. Your agents work the same without it.';
