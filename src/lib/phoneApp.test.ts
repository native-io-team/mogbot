/**
 * A downloaded build offers the phone only when it can get the app onto one:
 * the App Store first, then a build on this Mac, otherwise not at all.
 */
import { describe, expect, it } from 'vitest';
import { phoneAppRouteFor, phoneOfferNote, PHONE_APP_NOT_OUT } from './phoneApp';

describe('phoneAppRouteFor', () => {
  it('prefers the App Store, then a build on this Mac, else none', () => {
    expect(phoneAppRouteFor('https://apps.apple.com/app/id1', true)).toBe('store');
    expect(phoneAppRouteFor('https://apps.apple.com/app/id1', false)).toBe('store');
    expect(phoneAppRouteFor(null, true)).toBe('build');
    expect(phoneAppRouteFor(null, false)).toBe('none');
  });
});

describe('phoneOfferNote', () => {
  it('promises the time each route really takes, and nothing when there is no route', () => {
    expect(phoneOfferNote('store')).toMatch(/App Store/);
    expect(phoneOfferNote('store')).not.toMatch(/no App Store app yet|hour/);
    expect(phoneOfferNote('build')).toMatch(/ten minutes to an hour/);
    expect(phoneOfferNote('none')).toBeNull();
  });

  it('says the app isn’t out without blaming the version', () => {
    expect(PHONE_APP_NOT_OUT).not.toMatch(/version|install/i);
  });
});
