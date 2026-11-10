/**
 * A downloaded build offers the phone only when it can get the app onto one:
 * the App Store first, then TestFlight's beta, then a build on this Mac,
 * otherwise not at all.
 */
import { describe, expect, it } from 'vitest';
import {
  phoneAppRouteFor,
  phoneOfferNote,
  PHONE_APP_NOT_OUT,
  PHONE_APP_ROUTE,
  PHONE_APP_TESTFLIGHT_URL,
} from './phoneApp';

const STORE = 'https://apps.apple.com/app/id1';
const BETA = 'https://testflight.apple.com/join/abc';

describe('phoneAppRouteFor', () => {
  it('prefers the App Store, then TestFlight, then a build on this Mac, else none', () => {
    expect(phoneAppRouteFor(STORE, BETA, true)).toBe('store');
    expect(phoneAppRouteFor(STORE, null, false)).toBe('store');
    expect(phoneAppRouteFor(null, BETA, true)).toBe('testflight');
    expect(phoneAppRouteFor(null, BETA, false)).toBe('testflight');
    expect(phoneAppRouteFor(null, null, true)).toBe('build');
    expect(phoneAppRouteFor(null, null, false)).toBe('none');
  });

  it('takes this build’s TestFlight link from brand.json', () => {
    expect(PHONE_APP_TESTFLIGHT_URL).toMatch(/^https:\/\/testflight\.apple\.com\/join\//);
    expect(PHONE_APP_ROUTE).toBe('testflight');
  });
});

describe('phoneOfferNote', () => {
  it('promises the time each route really takes, and nothing when there is no route', () => {
    expect(phoneOfferNote('store')).toMatch(/App Store/);
    expect(phoneOfferNote('store')).not.toMatch(/no App Store app yet|hour/);
    expect(phoneOfferNote('testflight')).toBe(
      'Chat, answer and approve from anywhere. Get the free beta from TestFlight, then scan a code from this Mac. Your phone talks only to this Mac, through Tailscale on both.'
    );
    expect(phoneOfferNote('build')).toMatch(/ten minutes to an hour/);
    expect(phoneOfferNote('none')).toBeNull();
  });

  it('says the app isn’t out without blaming the version', () => {
    expect(PHONE_APP_NOT_OUT).not.toMatch(/version|install/i);
  });
});
