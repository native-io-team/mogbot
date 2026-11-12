/**
 * How someone gets the phone app onto their phone in this build, so every
 * place that offers the phone (the Chief's card, the Phone panel) promises
 * only what this build can do.
 *
 * - `store`: the App Store page is known (`links.appStore` in brand.json).
 *   Preferred: it takes a minute, and only the store build receives push.
 * - `testflight`: no store page yet, but a public TestFlight link
 *   (`links.testFlight`): the free beta, as quick as the store.
 * - `build`: neither, but this build can build it on this Mac
 *   (`links.companionSource`, or a dev build): ten minutes to an hour.
 * - `none`: none of these. Nothing offers the phone as a next step; the
 *   panel says it isn't out yet.
 *
 * @module lib/phoneApp
 */

import { BRAND_LINKS, relayOn } from './brand';
import { COMPANION_INSTALL_ENABLED } from './companionInstall';

export type PhoneAppRoute = 'store' | 'testflight' | 'build' | 'none';

export function phoneAppRouteFor(
  storeUrl: string | null,
  testFlightUrl: string | null,
  canBuild: boolean
): PhoneAppRoute {
  if (storeUrl) return 'store';
  if (testFlightUrl) return 'testflight';
  return canBuild ? 'build' : 'none';
}

/** The App Store page, when there is one. */
export const PHONE_APP_STORE_URL: string | null = BRAND_LINKS.appStore ?? null;

/** The public TestFlight link, when there is one. */
export const PHONE_APP_TESTFLIGHT_URL: string | null = BRAND_LINKS.testFlight ?? null;

/**
 * Whether the phone app exists for Android (`links.playStore`). False while
 * it's iPhone only (TestFlight, then the App Store): the pairing steps then
 * link only Tailscale's App Store page, not Google Play.
 */
export const PHONE_APP_ON_ANDROID: boolean = !!BRAND_LINKS.playStore;

/** This build's route. */
export const PHONE_APP_ROUTE: PhoneAppRoute = phoneAppRouteFor(
  PHONE_APP_STORE_URL,
  PHONE_APP_TESTFLIGHT_URL,
  COMPANION_INSTALL_ENABLED
);

/** The big button on the "Get the app" screen when the route is TestFlight. */
export const GET_ON_TESTFLIGHT = 'Get it on TestFlight';

/**
 * How the phone reaches this Mac, said before anyone starts: with our relay
 * (`relayOn()`), a free sign-in here or the user's own Tailscale, either one;
 * without it (a fork), Tailscale on both, the only way.
 */
export function phoneRouteLine(relay = relayOn()): string {
  return relay
    ? 'Your phone reaches this Mac through a free sign-in here, or your own Tailscale.'
    : 'Your phone talks only to this Mac, through Tailscale on both.';
}

/** The Chief's phone card's one line, honest about the time for each route. */
export function phoneOfferNote(route: PhoneAppRoute, relay = relayOn()): string | null {
  const how = phoneRouteLine(relay);
  switch (route) {
    case 'store':
      return `Chat, answer and approve from anywhere. Get the free app from the App Store, then scan a code from this Mac. ${how}`;
    case 'testflight':
      return `Chat, answer and approve from anywhere. Get the free beta from TestFlight, then scan a code from this Mac. ${how}`;
    case 'build':
      return `Chat, answer and approve from anywhere. ${how} There’s no App Store app yet, so setting it up takes ten minutes to an hour.`;
    case 'none':
      return null;
  }
}

/** The Phone panel's "Get the app" line when this build can't get it yet. */
export const PHONE_APP_NOT_OUT =
  'The phone app isn’t out yet. Your agents work the same without it.';
